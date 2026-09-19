import { test, expect } from 'bun:test'
import {
  resolveUpgradeAsset,
  verifyDownload,
  looksLikeExecutable,
  checkBinaryVersionOutput,
  tempBinaryPath,
  backupBinaryPath,
  parseUpgradeFailure,
  nextUpgradeFailure,
  shouldAttemptUpgrade,
  upgradeBackoffMs,
  UPGRADE_BACKOFF_STEPS_MS,
  MIN_BINARY_BYTES,
  pollRunningVersion,
  describeStaleServer,
  describeUnconfirmedRestart,
  decideVersionVerification,
} from './upgrade'

// --- platform/arch gate -----------------------------------------------------
// .github/workflows/release.yml publishes exactly two compiled assets: `agentop`
// (ubuntu-latest → linux x64) and `agentop.exe` (--target=bun-windows-x64). Anything
// else must be refused BEFORE a byte is downloaded — installing the x86_64 ELF on an
// arm64 box replaces a working binary with one the kernel cannot exec.

test('only the platform/arch pairs the release workflow publishes are self-installable', () => {
  expect(resolveUpgradeAsset('linux', 'x64', '2.5.0')).toEqual({
    asset: 'agentop',
    url: 'https://github.com/blpsoares/agentistics/releases/download/v2.5.0/agentop',
  })
  expect(resolveUpgradeAsset('win32', 'x64', '2.5.0')).toEqual({
    asset: 'agentop.exe',
    url: 'https://github.com/blpsoares/agentistics/releases/download/v2.5.0/agentop.exe',
  })
})

// The whole bug: the command printed "Latest: v2.5.0" and then downloaded through GitHub's rolling
// "Latest" FLAG, which a later release had taken without publishing the asset. Measured on the real
// repo (2026-09-02): the flag URL answered 404 while the version-addressed one answered 206.
test('the URL is addressed by VERSION, never by the rolling latest flag', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64']] as const) {
    const t = resolveUpgradeAsset(platform, arch, '1.23.1')!
    expect(t.url).toContain('/releases/download/v1.23.1/')
    expect(t.url).not.toContain('/releases/latest/download')
  }
})

test('the URL carries the version it was GIVEN — never a default', () => {
  // An upgrade that announces one version and fetches another is the failure this signature exists
  // to make impossible, so `version` is required rather than optional.
  expect(resolveUpgradeAsset('linux', 'x64', '9.9.9')!.url)
    .toBe('https://github.com/blpsoares/agentistics/releases/download/v9.9.9/agentop')
  expect(resolveUpgradeAsset('linux', 'x64', '1.0.0')!.url).toContain('/v1.0.0/')
})

test('the tag prefix is added once — the API reports a version, the tag is v<version>', () => {
  expect(resolveUpgradeAsset('linux', 'x64', '2.6.1')!.url).toContain('/v2.6.1/')
  expect(resolveUpgradeAsset('linux', 'x64', '2.6.1')!.url).not.toContain('/vv2.6.1/')
})

test('an unsupported platform is still refused whatever the version', () => {
  // The platform gate runs BEFORE any download; a version can never talk it into one.
  expect(resolveUpgradeAsset('darwin', 'arm64', '2.5.0')).toBeNull()
})

test('unsupported platform/arch combinations are refused', () => {
  expect(resolveUpgradeAsset('linux', 'arm64', '2.5.0')).toBeNull()   // Raspberry Pi / Ampere VM
  expect(resolveUpgradeAsset('linux', 'arm', '2.5.0')).toBeNull()
  expect(resolveUpgradeAsset('darwin', 'arm64', '2.5.0')).toBeNull()  // no macOS asset at all
  expect(resolveUpgradeAsset('darwin', 'x64', '2.5.0')).toBeNull()
  expect(resolveUpgradeAsset('win32', 'arm64', '2.5.0')).toBeNull()
  expect(resolveUpgradeAsset('freebsd', 'x64', '2.5.0')).toBeNull()
})

// --- download verification --------------------------------------------------

const elfHead = () => new Uint8Array([0x7f, 0x45, 0x4c, 0x46])
const peHead = () => new Uint8Array([0x4d, 0x5a, 0x90, 0x00])

function payload(head: Uint8Array, size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(head, 0)
  return bytes
}

test('executable magic is checked per platform', () => {
  expect(looksLikeExecutable(elfHead(), 'linux')).toBe(true)
  expect(looksLikeExecutable(peHead(), 'win32')).toBe(true)
  expect(looksLikeExecutable(peHead(), 'linux')).toBe(false)   // Windows PE on Linux
  expect(looksLikeExecutable(elfHead(), 'win32')).toBe(false)
  // "<!DOCTYPE" — a GitHub error/redirect page, the classic 200-with-HTML case.
  expect(looksLikeExecutable(new Uint8Array([0x3c, 0x21, 0x44, 0x4f]), 'linux')).toBe(false)
})

test('verifyDownload rejects truncated payloads and non-executables', () => {
  expect(verifyDownload(payload(elfHead(), MIN_BINARY_BYTES + 1), 'linux')).toEqual({ ok: true })

  const short = verifyDownload(payload(elfHead(), 1024), 'linux')
  expect(short.ok).toBe(false)
  expect(short.ok === false && short.reason).toContain('1024 bytes')

  const html = verifyDownload(payload(new Uint8Array([0x3c, 0x21, 0x44, 0x4f]), MIN_BINARY_BYTES + 1), 'linux')
  expect(html.ok).toBe(false)
  expect(html.ok === false && html.reason).toContain('not an executable')

  // Empty body (dropped connection) never reaches the disk swap.
  expect(verifyDownload(new Uint8Array(0), 'linux').ok).toBe(false)
})

// --- post-download identity check -------------------------------------------

test('the downloaded binary must identify itself as the expected version (or newer)', () => {
  expect(checkBinaryVersionOutput('agentop v1.7.0\n', '1.7.0')).toEqual({ ok: true, found: '1.7.0' })
  // The download URL is the ROLLING `latest` release, which can be one bump ahead of the
  // newest version the releases API lists — newer is fine, older is not.
  expect(checkBinaryVersionOutput('agentop v1.7.1\n', '1.7.0')).toEqual({ ok: true, found: '1.7.1' })
  expect(checkBinaryVersionOutput('agentop v1.6.9\n', '1.7.0')).toEqual({ ok: false, found: '1.6.9' })
  // Nothing usable printed → the file did not run (wrong arch, corrupt, killed).
  expect(checkBinaryVersionOutput('', '1.7.0')).toEqual({ ok: false, found: null })
  expect(checkBinaryVersionOutput('bash: cannot execute binary file', '1.7.0')).toEqual({ ok: false, found: null })
  expect(checkBinaryVersionOutput('<!DOCTYPE html>', '1.7.0')).toEqual({ ok: false, found: null })
})

// --- atomic staging paths ---------------------------------------------------

test('the staged file is unique, hidden and next to the binary it will replace', () => {
  // Same directory → rename() is atomic (a cross-filesystem move is a copy, i.e. a window
  // where the live binary is half-written).
  expect(tempBinaryPath('/home/u/.local/bin/agentop', 'abc123'))
    .toBe('/home/u/.local/bin/.agentop.new-abc123')
  // The extension survives, or Windows cannot exec the staged file to verify it.
  expect(tempBinaryPath('/opt/tools/agentop.exe', 'deadbeef'))
    .toBe('/opt/tools/.agentop.new-deadbeef.exe')
  // Two concurrent upgrades never collide on the same temp name.
  expect(tempBinaryPath('/bin/agentop', 'a')).not.toBe(tempBinaryPath('/bin/agentop', 'b'))
})

test('the replaced binary is kept next to the target for rollback', () => {
  expect(backupBinaryPath('/home/u/.local/bin/agentop')).toBe('/home/u/.local/bin/agentop.bak')
  expect(backupBinaryPath('/opt/tools/agentop.exe')).toBe('/opt/tools/agentop.exe.bak')
})

// --- failure memory + backoff ----------------------------------------------

test('parseUpgradeFailure accepts a valid state and rejects junk', () => {
  expect(parseUpgradeFailure('{"version":"1.7.0","failedAt":1000,"attempts":2,"reason":"HTTP 404"}'))
    .toEqual({ version: '1.7.0', failedAt: 1000, attempts: 2, reason: 'HTTP 404' })
  expect(parseUpgradeFailure('{"version":"1.7.0","failedAt":1000}'))
    .toEqual({ version: '1.7.0', failedAt: 1000, attempts: 1, reason: '' })
  expect(parseUpgradeFailure('not json')).toBeNull()
  expect(parseUpgradeFailure('{"failedAt":1000}')).toBeNull()          // no version
  expect(parseUpgradeFailure('{"version":"1.7.0"}')).toBeNull()        // no timestamp
})

test('backoff widens with consecutive failures and caps', () => {
  expect(upgradeBackoffMs(1)).toBe(UPGRADE_BACKOFF_STEPS_MS[0]!)
  expect(upgradeBackoffMs(2)).toBe(UPGRADE_BACKOFF_STEPS_MS[1]!)
  expect(upgradeBackoffMs(4)).toBe(UPGRADE_BACKOFF_STEPS_MS[3]!)
  expect(upgradeBackoffMs(99)).toBe(UPGRADE_BACKOFF_STEPS_MS[3]!)      // capped, never grows forever
  expect(upgradeBackoffMs(0)).toBe(UPGRADE_BACKOFF_STEPS_MS[0]!)       // defensive
})

test('consecutive failures on the same version increment; a new version resets', () => {
  const first = nextUpgradeFailure(null, '1.7.0', 1000, 'HTTP 404')
  expect(first).toEqual({ version: '1.7.0', failedAt: 1000, attempts: 1, reason: 'HTTP 404' })
  const second = nextUpgradeFailure(first, '1.7.0', 2000, 'HTTP 404')
  expect(second.attempts).toBe(2)
  // A newer release may well fix whatever failed — it gets a clean slate.
  expect(nextUpgradeFailure(second, '1.7.1', 3000, 'HTTP 404').attempts).toBe(1)
})

test('a permanently failing update backs off instead of re-downloading on every shell', () => {
  const t0 = 1_000_000
  const state = { version: '1.7.0', failedAt: t0, attempts: 1, reason: 'permission denied' }
  expect(shouldAttemptUpgrade(state, '1.7.0', t0 + 1000)).toBe(false)                       // seconds later
  expect(shouldAttemptUpgrade(state, '1.7.0', t0 + upgradeBackoffMs(1) - 1)).toBe(false)
  expect(shouldAttemptUpgrade(state, '1.7.0', t0 + upgradeBackoffMs(1))).toBe(true)         // window elapsed
  // A different target version is always retried immediately.
  expect(shouldAttemptUpgrade(state, '1.7.1', t0 + 1000)).toBe(true)
  // Nothing recorded → always allowed.
  expect(shouldAttemptUpgrade(null, '1.7.0', t0)).toBe(true)
  // After 4 failures the wait is a full day, not another 140 MB download per terminal.
  const worn = { ...state, attempts: 4 }
  expect(shouldAttemptUpgrade(worn, '1.7.0', t0 + 8 * 60 * 60_000)).toBe(false)
  expect(shouldAttemptUpgrade(worn, '1.7.0', t0 + 24 * 60 * 60_000)).toBe(true)
})

// --- pollRunningVersion -----------------------------------------------------
//
// Regression for the false "Done — now running vX": `systemctl --user restart` reporting success
// only means the command was ACCEPTED, not that the new process ever bound the port. An orphaned
// process from before a reboot can go on answering the OLD version forever while the unit's new
// process crash-loops trying to take a port that is already held. This is the one check that asks
// what is actually answering requests, so it is exercised with an injected fetch/sleep/clock rather
// than a real socket and a real wait.

function fakeJsonFetch(current: string | null) {
  return async () => ({
    ok: current !== null,
    json: async () => (current === null ? {} : { current }),
  })
}

test('pollRunningVersion succeeds the moment the server answers with the wanted version', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    // Old version on the first poll, new version from the second poll onward — the ordinary case
    // of a restart that takes a moment to come up.
    return { ok: true, json: async () => ({ current: calls === 1 ? '2.36.1' : '2.37.0' }) }
  }
  const result = await pollRunningVersion(47291, '2.37.0', {
    timeoutMs: 10_000, intervalMs: 0, fetchImpl, sleepImpl: async () => {}, nowImpl: () => 0,
  })
  expect(result).toEqual({ ok: true, observed: '2.37.0' })
  expect(calls).toBe(2)
})

test('pollRunningVersion never claims success while the server keeps answering the OLD version', async () => {
  // The exact measured defect: the port answers throughout (an orphan holding it), never with the
  // version that was just installed. A bounded, fake clock stands in for the real timeout so the
  // test does not wait 15 real seconds.
  let now = 0
  const fetchImpl = fakeJsonFetch('2.36.1')
  const result = await pollRunningVersion(47291, '2.37.0', {
    timeoutMs: 5_000, intervalMs: 1_000,
    fetchImpl,
    sleepImpl: async (ms) => { now += ms },
    nowImpl: () => now,
  })
  expect(result).toEqual({ ok: false, observed: '2.36.1' })
})

test('pollRunningVersion reports nothing observed when the port never answers at all', async () => {
  let now = 0
  const result = await pollRunningVersion(47291, '2.37.0', {
    timeoutMs: 3_000, intervalMs: 1_000,
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
    sleepImpl: async (ms) => { now += ms },
    nowImpl: () => now,
  })
  expect(result).toEqual({ ok: false, observed: null })
})

test('pollRunningVersion stops polling once the bounded time is spent, never forever', async () => {
  let now = 0
  let calls = 0
  await pollRunningVersion(47291, '2.37.0', {
    timeoutMs: 4_000, intervalMs: 1_000,
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ current: '2.36.1' }) } },
    sleepImpl: async (ms) => { now += ms },
    nowImpl: () => now,
  })
  // 4s budget / 1s interval — polls at 0, 1000, 2000, 3000, 4000: five attempts, never a sixth.
  expect(calls).toBe(5)
})

// --- describeStaleServer -----------------------------------------------------
//
// Pure composer for the diagnostic sentence — never a bare "the restart failed". Tested without
// spawning `lsof`/`ps`/`systemctl` at all.

test('describeStaleServer names the version still answering, the pid holding the port and the fix', () => {
  const lines = describeStaleServer({
    port: 47291, want: '2.37.0', observed: '2.36.1',
    pid: 4242, cmd: '/usr/local/bin/agentop server --bg', unitState: 'activating (auto-restart)',
  })
  expect(lines[0]).toBe('The server answering on port 47291 still reports v2.36.1, not v2.37.0.')
  expect(lines.some(l => l.includes('4242') && l.includes('/usr/local/bin/agentop server --bg'))).toBe(true)
  expect(lines.some(l => l.includes('activating (auto-restart)'))).toBe(true)
  expect(lines.some(l => l.includes('kill 4242'))).toBe(true)
})

test('describeStaleServer says nothing answered when the poll never got a response', () => {
  const lines = describeStaleServer({ port: 47291, want: '2.37.0', observed: null })
  expect(lines[0]).toContain('Nothing answered on port 47291')
  expect(lines.some(l => l.includes('kill'))).toBe(false) // no pid to name, no kill to suggest
})

test('describeStaleServer omits the pid/unit lines it has no facts for', () => {
  const lines = describeStaleServer({ port: 47291, want: '2.37.0', observed: '2.36.1' })
  expect(lines).toHaveLength(2) // headline + the generic restart-command fix, nothing invented
  expect(lines[1]).toContain('systemctl --user restart agentop-server')
})

// --- decideVersionVerification -----------------------------------------------
//
// The gap a review found in the commit above: when `restartRunningServices` genuinely bounced a
// server that answers `PORT` and the poll's whole window passed with NOTHING ever answering
// `/api/version`, the old code fell straight through to "Done — now running vX" because it only
// ever checked `verified.observed !== null`. A restarted unit that crash-loops hard enough to never
// bind the port even once is indistinguishable, from the poll alone, from "nothing runs here to
// confirm" — the only thing that tells them apart is knowing a restart was expected.

test('decideVersionVerification succeeds once the served version matches', () => {
  expect(decideVersionVerification({ ok: true, observed: '2.37.0' }, true)).toEqual({ ok: true })
  // Whether or not a restart happened is irrelevant once the new version is confirmed.
  expect(decideVersionVerification({ ok: true, observed: '2.37.0' }, false)).toEqual({ ok: true })
})

test('decideVersionVerification fails on a stale version served by another process', () => {
  // The originally measured defect: an orphan answers, and it is never the new version.
  expect(decideVersionVerification({ ok: false, observed: '2.36.1' }, true))
    .toEqual({ ok: false, reason: 'mismatch' })
  // Still a mismatch even if `restartedServer` were somehow false — something IS answering.
  expect(decideVersionVerification({ ok: false, observed: '2.36.1' }, false))
    .toEqual({ ok: false, reason: 'mismatch' })
})

test('decideVersionVerification fails when a server was restarted and nothing ever answered (unit failed)', () => {
  expect(decideVersionVerification({ ok: false, observed: null }, true))
    .toEqual({ ok: false, reason: 'unconfirmed' })
})

test('decideVersionVerification fails when a server was restarted and nothing ever answered (unit activating)', () => {
  // The decision itself does not read `portHolderFacts` — the unit state only affects the composed
  // sentence — but the case is named separately because it is the one `describeUnconfirmedRestart`
  // must render distinctly (see below): `activating (auto-restart)` is still crash-looping, not
  // merely slow, and the decision must fail exactly the same as `failed`.
  expect(decideVersionVerification({ ok: false, observed: null }, true))
    .toEqual({ ok: false, reason: 'unconfirmed' })
})

test('decideVersionVerification succeeds when nothing was restarted at all', () => {
  // No managed service was running (e.g. a foreground/dev setup) — there is nothing to confirm,
  // and "nothing answered" must not read as a failure here.
  expect(decideVersionVerification({ ok: false, observed: null }, false)).toEqual({ ok: true })
})

// --- describeUnconfirmedRestart ------------------------------------------------

test('describeUnconfirmedRestart names the unit state and the exact inspection commands', () => {
  const failed = describeUnconfirmedRestart({ port: 47291, want: '2.37.0', unitState: 'failed' })
  expect(failed[0]).toContain('nothing answered on port 47291')
  expect(failed.some(l => l.includes('agentop-server unit: failed'))).toBe(true)
  expect(failed.some(l => l.includes('systemctl --user status agentop-server'))).toBe(true)
  expect(failed.some(l => l.includes('journalctl --user -u agentop-server -n 50'))).toBe(true)

  const activating = describeUnconfirmedRestart({ port: 47291, want: '2.37.0', unitState: 'activating (auto-restart)' })
  expect(activating.some(l => l.includes('agentop-server unit: activating (auto-restart)'))).toBe(true)
})

test('describeUnconfirmedRestart names the pid holding the port when there is one', () => {
  const lines = describeUnconfirmedRestart({
    port: 47291, want: '2.37.0', unitState: 'inactive', pid: 777, cmd: '/opt/agentop server',
  })
  expect(lines.some(l => l.includes('777') && l.includes('/opt/agentop server'))).toBe(true)
})
