import { rename, chmod, unlink, rm } from 'fs/promises'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawn as spawnChild } from 'node:child_process'
import { platform } from 'os'
import { basename, dirname, join } from 'path'
import { getVersionInfo, CURRENT_VERSION, compareVersions } from './version.ts'
import { launchdPlistPath, restartAutostart } from './autostart.ts'
import { AGENTISTICS_DATA_DIR, PORT } from './config.ts'
import { cliStrings, type CliLang, type CliStrings } from './cli-i18n.ts'
import { PRIMARY_REPO, fetchFirstOk, releaseAssetUrls } from './release-source.ts'
import { parseUpgradeProgress, shouldWriteDownload, type UpgradeProgress } from './upgrade-progress.ts'

/** Where a running upgrade narrates itself for the page that started it (`upgrade-progress.ts`). */
export const UPGRADE_PROGRESS_FILE = join(AGENTISTICS_DATA_DIR, 'upgrade-progress.json')

/** Best-effort: a progress file that cannot be written costs the page its narration, never the upgrade. */
function writeProgress(p: Omit<UpgradeProgress, 'at'>): void {
  try {
    mkdirSync(AGENTISTICS_DATA_DIR, { recursive: true })
    writeFileSync(UPGRADE_PROGRESS_FILE, JSON.stringify({ ...p, at: Date.now() }))
  } catch { /* unwritable data dir */ }
}

/**
 * Read the body chunk by chunk so the download stage can report bytes. Same failure surface as
 * `arrayBuffer()` (a reset or the timeout rejects the read), so the caller's guard is unchanged.
 */
async function readBodyWithProgress(resp: Response, version: string): Promise<Uint8Array> {
  const totalHeader = Number(resp.headers.get('content-length'))
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined
  const reader = resp.body?.getReader()
  if (!reader) return new Uint8Array(await resp.arrayBuffer())
  const chunks: Uint8Array[] = []
  let received = 0
  let last: { received: number; at: number } | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    const now = Date.now()
    if (shouldWriteDownload(last, received, total, now)) {
      writeProgress({ stage: 'downloading', version, received, ...(total ? { total } : {}) })
      last = { received, at: now }
    }
  }
  const out = new Uint8Array(received)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  writeProgress({ stage: 'downloading', version, received, ...(total ? { total } : {}) })
  return out
}

/**
 * Where a release asset lives, addressed BY VERSION.
 *
 * It used to be `.../releases/latest/download`, which resolves through GitHub's rolling "Latest"
 * FLAG rather than through the version this command just resolved and printed. Those are different
 * things: the flag moves to whichever release GitHub considers latest, and a release that takes it
 * without publishing the `agentop` asset makes the download 404 — while the announced version's
 * binary sits there, present and unreachable.
 *
 * Measured on the real repo (linux/x64, 2026-09-02): the flag-addressed URL answered **404** while
 * `.../releases/download/v2.5.0/agentop` answered **206**. The command printed "Latest: v2.5.0" and
 * then failed to download v2.5.0 — the one thing an upgrade must never do is announce a version it
 * is not fetching.
 */
function releaseAssetTarget(version: string, asset: string): UpgradeTarget {
  // The tag is `v<version>`; `version` arrives from the releases API without the prefix. Every
  // owner the repository has lived under is listed (release-source.ts), new first.
  const urls = releaseAssetUrls(version, asset)
  return { asset, url: urls[0]!, urls }
}
/** Where a user goes when self-install is refused (unsupported platform/arch). */
export const RELEASES_PAGE = `https://github.com/${PRIMARY_REPO}/releases`

const _ESC = '\x1b'
const _R  = `${_ESC}[0m`
const _B  = `${_ESC}[1m`
const _GR = `${_ESC}[92m`
const _WH = `${_ESC}[97m`
const _D  = `${_ESC}[2m`
const _Y  = `${_ESC}[33m`
const _RD = `${_ESC}[91m`

// central.sh sets PROJECT=${PROJECT:-team-mode}; docker/machine.yml builds `agentistics-machine`.
const CENTRAL_PROJECT = 'team-mode'
const MACHINE_IMAGE = 'agentistics-machine'

// ---------------------------------------------------------------------------
// Platform/arch gate
//
// The release workflow (.github/workflows/release.yml) publishes these assets:
//   • `agentop`      — `bun build --compile` on ubuntu-latest        → Linux x86_64 ELF
//   • `agentop.exe`  — `--target=bun-windows-x64`                    → Windows x86_64 PE
//   • `agentop-darwin-x64` and `agentop-darwin-arm64` → macOS Mach-O
// There is no Linux arm64 asset. Downloading `agentop` on an arm64 Linux box
// (Raspberry Pi, Ampere VM) or on macOS replaces a WORKING binary with an ELF the kernel
// cannot exec — and the upgrade then restarts the user's services onto it. So the gate is
// an allowlist of the combinations the workflow actually publishes; everything else is
// refused before a single byte is downloaded.
// ---------------------------------------------------------------------------

export interface UpgradeTarget {
  /** Release asset name, as published by the workflow. */
  asset: string
  /** Full download URL for that asset, under the CURRENT owner. */
  url: string
  /** Every URL the asset may be fetched from, in order: the current owner, then the legacy one. */
  urls: string[]
}

/**
 * Pure: the asset for a platform/arch pair at a GIVEN VERSION, or null when self-install is not
 * supported there.
 *
 * `version` is required rather than optional. An optional one would default to the rolling flag
 * for any caller that forgot it, which is the defect this signature exists to make impossible —
 * and both callers (the manual command and the unattended path) already hold the version they
 * resolved.
 */
export function resolveUpgradeAsset(platformId: string, arch: string, version: string): UpgradeTarget | null {
  const key = `${platformId}/${arch}`
  if (key === 'linux/x64') return releaseAssetTarget(version, 'agentop')
  if (key === 'win32/x64') return releaseAssetTarget(version, 'agentop.exe')
  if (key === 'darwin/arm64') return releaseAssetTarget(version, 'agentop-darwin-arm64')
  if (key === 'darwin/x64') return releaseAssetTarget(version, 'agentop-darwin-x64')
  return null
}

// ---------------------------------------------------------------------------
// Download verification
// ---------------------------------------------------------------------------

/** The compiled Bun binary is >100 MB; anything this small is an error page, a truncated
 *  transfer or an LFS/redirect stub — never a usable agentop. */
export const MIN_BINARY_BYTES = 4 * 1024 * 1024

/** Pure: does the payload start with the executable magic for this platform? */
export function looksLikeExecutable(head: Uint8Array, platformId: string, arch?: string): boolean {
  if (platformId === 'win32') return head[0] === 0x4d && head[1] === 0x5a // "MZ"
  if (platformId === 'darwin') {
    const magic = head.length >= 4 ? ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0 : 0
    const thin = magic === 0xfeedfacf || magic === 0xcffaedfe
    const fat = magic === 0xcafebabe || magic === 0xbebafeca
    if (!thin && !fat) return false
    if (!arch || head.length < 8) return true
    const want = arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : null
    if (want === null) return true
    const read32 = (offset: number, little: boolean) => little
      ? (head[offset]! | (head[offset + 1]! << 8) | (head[offset + 2]! << 16) | (head[offset + 3]! << 24)) >>> 0
      : ((head[offset]! << 24) | (head[offset + 1]! << 16) | (head[offset + 2]! << 8) | head[offset + 3]!) >>> 0
    if (thin) return read32(4, magic === 0xcffaedfe) === want
    const little = magic === 0xbebafeca
    const count = read32(4, little)
    for (let i = 0; i < count && 8 + i * 20 + 4 <= head.length; i++) {
      if (read32(8 + i * 20, little) === want) return true
    }
    return false
  }
  // 0x7F 'E' 'L' 'F'
  return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46
}

/** Pure: gate on the bytes BEFORE they can ever replace a working binary. */
export function verifyDownload(
  bytes: Uint8Array,
  platformId: string,
  minBytes: number = MIN_BINARY_BYTES,
): { ok: true } | { ok: false; reason: string } {
  if (bytes.length < minBytes) {
    return { ok: false, reason: `downloaded file is only ${bytes.length} bytes (expected > ${minBytes})` }
  }
  if (!looksLikeExecutable(bytes.subarray(0, 4096), platformId, platformId === 'darwin' ? process.arch : undefined)) {
    return { ok: false, reason: `downloaded file is not an executable for ${platformId}` }
  }
  return { ok: true }
}

/**
 * Pure: does `agentop --version` output prove this binary is the release we expect?
 *
 * `>=` rather than `===`, and the reason CHANGED when the download URL stopped going through
 * GitHub's rolling "Latest" flag: it used to be that the flag could legitimately be one bump ahead
 * of the releases API. A version-addressed URL cannot be ahead of the version it names, so `>=` is
 * now only a tolerance — an asset republished under its own tag after a rebuild still passes. An
 * OLDER (or unparseable) version still means we downloaded the wrong thing and must not install
 * it, which is the check that actually matters.
 */
export function checkBinaryVersionOutput(
  out: string,
  expected: string,
): { ok: boolean; found: string | null } {
  const m = out.match(/agentop\s+v(\d+\.\d+\.\d+)/i)
  const found = m?.[1] ?? null
  return { ok: !!found && compareVersions(found, expected) >= 0, found }
}

/** Pure: unique temp path NEXT TO the target (same filesystem → rename is atomic), keeping the
 *  extension so Windows can still exec it. Unique per attempt so a hand-run `agentop upgrade`
 *  and the background one can never write the same file. */
export function tempBinaryPath(currentBin: string, unique: string): string {
  const dir = dirname(currentBin)
  const base = basename(currentBin)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot) : ''
  const stem = dot > 0 ? base.slice(0, dot) : base
  return join(dir, `.${stem}.new-${unique}${ext}`)
}

/** Pure: where the replaced binary is kept so a failed install can be rolled back. */
export function backupBinaryPath(currentBin: string): string {
  return `${currentBin}.bak`
}

// ---------------------------------------------------------------------------
// Failure memory + backoff
//
// A critical update that can never succeed here (no write permission, unsupported arch, a
// 404 asset, a full disk) used to re-download ~140 MB on every shell that opened, forever.
// Failures are persisted with an attempt counter and retried on a widening schedule; any
// successful upgrade — or a NEW target version — clears the state.
// ---------------------------------------------------------------------------

export const UPGRADE_FAILURE_FILE = join(AGENTISTICS_DATA_DIR, 'upgrade-failure.json')
/** Backoff per consecutive failure: 30 min → 2 h → 8 h → 24 h (capped). */
export const UPGRADE_BACKOFF_STEPS_MS = [30 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000, 24 * 60 * 60_000]

export interface UpgradeFailure {
  /** Target version that failed. */
  version: string
  failedAt: number
  attempts: number
  reason: string
}

/** Pure: how long to wait after `attempts` consecutive failures. */
export function upgradeBackoffMs(attempts: number): number {
  const idx = Math.min(Math.max(attempts, 1), UPGRADE_BACKOFF_STEPS_MS.length) - 1
  return UPGRADE_BACKOFF_STEPS_MS[idx]!
}

/** Pure: parse the persisted failure state. Junk → null (treated as "no failures"). */
export function parseUpgradeFailure(raw: string): UpgradeFailure | null {
  try {
    const o = JSON.parse(raw) as Partial<UpgradeFailure>
    if (!o || typeof o.version !== 'string' || !o.version) return null
    if (typeof o.failedAt !== 'number' || !Number.isFinite(o.failedAt)) return null
    const attempts = typeof o.attempts === 'number' && Number.isFinite(o.attempts) && o.attempts > 0
      ? Math.floor(o.attempts)
      : 1
    return { version: o.version, failedAt: o.failedAt, attempts, reason: typeof o.reason === 'string' ? o.reason : '' }
  } catch {
    return null
  }
}

/** Pure: next state after a failure — consecutive only while the target version is the same. */
export function nextUpgradeFailure(
  prev: UpgradeFailure | null,
  version: string,
  now: number,
  reason: string,
): UpgradeFailure {
  const attempts = prev && prev.version === version ? prev.attempts + 1 : 1
  return { version, failedAt: now, attempts, reason }
}

/**
 * Pure: may an UNATTENDED upgrade to `version` run now? A different target version always
 * gets a fresh chance (the new release may well fix what failed). A hand-run
 * `agentop upgrade` never consults this — the user asked explicitly.
 */
export function shouldAttemptUpgrade(
  state: UpgradeFailure | null,
  version: string,
  now: number,
): boolean {
  if (!state || state.version !== version) return true
  return now - state.failedAt >= upgradeBackoffMs(state.attempts)
}

/** Reads the persisted failure state. Never throws. */
export function readUpgradeFailure(): UpgradeFailure | null {
  try {
    return parseUpgradeFailure(readFileSync(UPGRADE_FAILURE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function recordUpgradeFailure(version: string, reason: string): void {
  writeProgress({ stage: 'failed', version, reason })
  try {
    mkdirSync(AGENTISTICS_DATA_DIR, { recursive: true })
    const next = nextUpgradeFailure(readUpgradeFailure(), version, Date.now(), reason)
    writeFileSync(UPGRADE_FAILURE_FILE, JSON.stringify(next))
  } catch { /* best-effort */ }
}

function clearUpgradeFailure(): void {
  try { unlinkSync(UPGRADE_FAILURE_FILE) } catch { /* nothing recorded */ }
}

/**
 * The running server reports `current`: any failure recorded for exactly that version is stale (the
 * target is installed and answering) and is dropped, and a `failed` progress record for it is
 * rewritten as `done`. Never touches a failure for ANOTHER version. Best-effort, never throws.
 */
export function staleUpgradeState(
  failure: UpgradeFailure | null,
  progress: UpgradeProgress | null,
  current: string,
): { clearFailure: boolean; rewriteProgress: boolean } {
  return {
    clearFailure: !!failure && failure.version === current,
    rewriteProgress: !!progress && progress.stage === 'failed' && progress.version === current,
  }
}

export function reconcileUpgradeState(current: string): void {
  try {
    const f = readUpgradeFailure()
    let p: UpgradeProgress | null = null
    try { p = parseUpgradeProgress(readFileSync(UPGRADE_PROGRESS_FILE, 'utf8')) } catch { /* none */ }
    const stale = staleUpgradeState(f, p, current)
    if (stale.clearFailure) clearUpgradeFailure()
    if (stale.rewriteProgress) writeProgress({ stage: 'done', version: current })
  } catch { /* nothing recorded */ }
}

/** Run a command, capturing trimmed stdout (stderr discarded). Never throws. */
async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
    const out = (await new Response(p.stdout).text()).trim()
    const code = await p.exited
    return { code, out }
  } catch {
    return { code: 1, out: '' }
  }
}

/** Run a command with inherited stdio so the user sees progress (docker pull/up, etc.). */
async function shInherit(cmd: string[]): Promise<number> {
  try {
    const p = Bun.spawn(cmd, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    return await p.exited
  } catch {
    return 1
  }
}

async function dockerRunning(filter: string): Promise<boolean> {
  const r = await sh(['docker', 'ps', '-q', '-f', filter])
  return r.out.split(/\s+/).filter(Boolean).length > 0
}

/**
 * Runs `<bin> --version` and returns its stdout ('' when it can't run). Killed after
 * `timeoutMs` so a hung/incompatible binary can't wedge the upgrade.
 *
 * AGENTISTICS_NO_UPDATE_CHECK=1 keeps the probe offline: `agentop --version` otherwise does a
 * GitHub round-trip, which would make every install wait on the network.
 */
async function probeBinaryVersion(bin: string, timeoutMs = 20_000): Promise<string> {
  try {
    const p = Bun.spawn([bin, '--version'], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, AGENTISTICS_NO_UPDATE_CHECK: '1' },
    })
    const timer = setTimeout(() => { try { p.kill() } catch { /* already gone */ } }, timeoutMs)
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    clearTimeout(timer)
    return code === 0 ? out : ''
  } catch {
    return ''
  }
}

/** What the server answering THIS machine's port says it runs, or null when nothing answers. */
async function runningServerVersion(): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/version`, { signal: AbortSignal.timeout(2_000) })
    if (!r.ok) return null
    const v = (await r.json() as { current?: unknown }).current
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

export type RestartOutcome = {
  ok: boolean
  failures: string[]
  /**
   * True only when something that answers THIS machine's own `/api/version` (bound to `PORT`) was
   * bounced: the native `agentop-server` systemd unit, the machine-in-Docker container (it runs
   * with `network_mode: host`, so it binds `PORT` directly, unlike the central which is a separate
   * container on its own port), or an unmanaged background `agentop server` process. Never true for
   * `agentop-watch` (the OTel daemon has no HTTP surface) or the central (a different port). This is
   * what lets the poll below tell "a server was restarted and never came back" apart from "nothing
   * runs here to confirm" — `didSomething` alone conflates both.
   */
  restartedServer: boolean
}

/**
 * After the new binary is in place, bounce whatever is actually running so it runs the new
 * version — the whole point of `upgrade` is that the user doesn't have to restart by hand.
 *
 * Self-restart is safe: `agentop upgrade` runs as a foreground CLI, a *separate* process from
 * the systemd user service or Docker container it restarts, so restarting those never kills
 * this process. `systemctl --user restart` is handled out-of-process by systemd, and the
 * central/machine live in their own containers.
 *
 * Every step's result is CHECKED and collected: a swallowed restart failure leaves the user
 * on the old code while the CLI claims success — exactly the case where a critical update
 * silently did not take effect.
 *
 * @param newBin path to the just-installed binary — the central/machine restart is driven by
 *   THIS binary so the image tag matches the version we just installed (the running process
 *   still carries the old version number).
 */
/**
 * Restart a server that NO service manager owns, onto `newBin` — only ever reached when no
 * `agentop-server` unit is installed (see `server-restart-plan.ts`). Targets only processes whose
 * argv IS `agentop server`, waits for each to exit and for the data-dir lock to be free, and starts
 * exactly one replacement. The old version matched `pgrep -f 'agentop.*(server|start)'`, which
 * killed the systemd unit's own server on 2026-10-03 (docs/incidents/2026-10-03-restart-loop.md).
 */
async function handOverUnmanagedServers(pids: readonly number[], newBin: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { handOverDetached } = await import('./server-restart-io.ts')
  const { serverLockFile } = await import('./config.ts')
  process.stdout.write('  Restarting the agentop server started outside any service manager…\n')
  return handOverDetached(pids, serverLockFile(), {
    spawnServer: () => {
      const log = join(AGENTISTICS_DATA_DIR, 'agentop-server.log')
      const fd = openSync(log, 'a')
      // A new session + no inherited handles, the shape `startBackgroundUpgrade` uses — no `sh -c`,
      // no `nohup`, and no `--bg` launcher in between to race the lock.
      const child = spawnChild(newBin, ['server'], { detached: true, stdio: ['ignore', fd, fd] })
      child.unref()
      try { closeSync(fd) } catch { /* the child kept its own dup */ }
    },
  })
}

async function restartRunningServices(newBin: string, wantVersion?: string, backup?: string): Promise<RestartOutcome> {
  let didSomething = false
  let restartedServer = false
  const failures: string[] = []

  // 1) The server: the SERVICE MANAGER restarts it, or nothing does (`server-restart-plan.ts`).
  //    Decided once, here, from the unit file, the manager's own answer and /proc — never by
  //    killing whatever a pattern matched. `watch` keeps its own unit-only path below.
  let serverPlan: import('./server-restart-plan.ts').ServerRestartPlan = { kind: 'none' }
  if (platform() === 'darwin') {
    const { darwinRestartPlan } = await import('./server-restart-plan.ts')
    const plist = launchdPlistPath('server')
    const plan = darwinRestartPlan({ plistPresent: existsSync(plist) })
    if (plan.kind === 'launchd') {
      const uid = String(process.getuid?.() ?? '')
      const label = 'com.agentistics.agentop-server'
      process.stdout.write(`  Restarting the macOS LaunchAgent ${label}…\n`)
      const kick = await sh(['launchctl', 'kickstart', '-k', `gui/${uid}/${label}`])
      if (kick.code !== 0) {
        failures.push(`macOS LaunchAgent: launchctl kickstart failed (${kick.out || `exit ${kick.code}`})`)
      } else if (wantVersion) {
        process.stdout.write('    Waiting for /api/health and /api/version to report the new version…\n')
        const deadline = Date.now() + 180_000
        let matched = false
        while (Date.now() < deadline) {
          try {
            const health = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2_000) })
            const version = await fetch(`http://127.0.0.1:${PORT}/api/version`, { signal: AbortSignal.timeout(2_000) })
            const body = version.ok ? await version.json() as { current?: unknown } : null
            if (health.ok && version.ok && body?.current === wantVersion) { matched = true; break }
          } catch { /* launchd is still bringing the process back */ }
          await new Promise(resolve => setTimeout(resolve, 1_000))
        }
        if (!matched) failures.push(`macOS LaunchAgent: /api/health and /api/version did not confirm v${wantVersion}`)
      }
      didSomething = true
      restartedServer = true
      if (failures.length > 0 && backup) {
        process.stdout.write('  The macOS restart failed; restoring the previous binary and restarting launchd…\n')
        try {
          const failed = `${newBin}.failed-${process.pid}`
          await rename(newBin, failed)
          await rename(backup, newBin)
          await chmod(newBin, 0o755)
          await unlink(failed).catch(() => {})
          await sh(['xattr', '-d', 'com.apple.quarantine', newBin])
          const retry = await sh(['launchctl', 'kickstart', '-k', `gui/${uid}/${label}`])
          if (retry.code !== 0) failures.push(`macOS rollback: launchctl kickstart failed (${retry.out || `exit ${retry.code}`})`)
          else process.stdout.write('    Restored the backup binary and kickstarted launchd.\n')
        } catch (err: any) {
          failures.push(`macOS rollback failed: ${err?.message ?? String(err)}`)
        }
      }
    }
  } else if (platform() === 'linux') {
    const { planServerRestart, parseIsActive } = await import('./server-restart-plan.ts')
    const { readProcs } = await import('./server-restart-io.ts')
    const { unitPath } = await import('./autostart.ts')
    const unitInstalled = existsSync(unitPath('server'))
    const unitActive = unitInstalled
      ? parseIsActive((await sh(['systemctl', '--user', 'is-active', 'agentop-server'])).out)
      : null
    serverPlan = planServerRestart({ unitInstalled, unitActive, procs: readProcs(), selfPid: process.pid })

    if (serverPlan.kind === 'service') {
      process.stdout.write('  Restarting the agentop-server service…\n')
      const res = await restartAutostart('server', {
        ...(wantVersion ? { wantVersion } : {}),
        // A heavy service can take a while to bind; say we are still waiting rather than go quiet.
        onWait: sec => { if (sec >= 5 && sec % 5 === 0) process.stdout.write(`    …still waiting for agentop-server to answer (${sec}s)\n`) },
      })
      process.stdout.write(`    ${res.message.split('\n')[0]}\n`)
      if (!res.ok) failures.push(`agentop-server service: ${res.message.split('\n')[0]}`)
      didSomething = true
      restartedServer = true
    } else if (serverPlan.kind === 'manager-unreachable') {
      failures.push(
        'agentop-server service: the service manager could not be asked whether it runs ' +
        '(no reachable user bus from here) — nothing was stopped or started. ' +
        'Run `systemctl --user restart agentop-server` from a normal terminal.',
      )
      didSomething = true
    } else if (serverPlan.kind === 'outside-service') {
      // The unit owns this data dir. A stray that is provably its own `agentop server` (it holds
      // our lock — `server-ownership.ts`) is stopped and the UNIT started on the new binary; this
      // is the 2026-10-04 case, which used to end in "it was left alone" and two hours on the old
      // version. Only what cannot be proven ours is still left alone.
      const { startServerUnit } = await import('./server-ownership-io.ts')
      process.stdout.write(`  agentop server pid ${serverPlan.pids.join(', ')} runs outside the agentop-server service — handing it over to the service…\n`)
      const res = await startServerUnit()
      process.stdout.write(`    ${res.message}\n`)
      if (!res.ok) {
        failures.push(
          `agentop server pid ${serverPlan.pids.join(', ')} runs OUTSIDE the agentop-server service and could not be handed over: ${res.message}`,
        )
      }
      // The unit answers on PORT once it is up, so the version poll below has something to confirm.
      restartedServer = res.ok
      didSomething = true
    } else if (serverPlan.kind === 'detached') {
      const res = await handOverUnmanagedServers(serverPlan.pids, newBin)
      if (!res.ok) failures.push(`background agentop server: ${res.reason}`)
      didSomething = true
      restartedServer = res.ok
    }

    // `agentop watch` (the OTel daemon, no HTTP surface): its own unit, restarted only when active.
    const watch = parseIsActive((await sh(['systemctl', '--user', 'is-active', 'agentop-watch'])).out)
    if (watch === true) {
      process.stdout.write('  Restarting the agentop-watch service…\n')
      const res = await restartAutostart('watch')
      process.stdout.write(`    ${res.message.split('\n')[0]}\n`)
      if (!res.ok) failures.push(`agentop-watch service: ${res.message.split('\n')[0]}`)
      didSomething = true
    }
  }

  // 2) Central (Docker): pull the new version-tagged image and recreate. Driven through the NEW
  //    binary so `agentop central` resolves the image tag to the version we just installed.
  //    The central listens on its OWN port (48080 by default, mapped separately) — never `PORT` —
  //    so bouncing it says nothing about whether `agentop server` itself came back up.
  if (await dockerRunning(`label=com.docker.compose.project=${CENTRAL_PROJECT}`)) {
    process.stdout.write('  Updating the central (Docker): pulling the new image and recreating…\n')
    const pull = await shInherit([newBin, 'central', 'pull'])
    if (pull !== 0) failures.push(`central: \`agentop central pull\` exited ${pull}`)
    const up = await shInherit([newBin, 'central', 'up'])
    if (up !== 0) failures.push(`central: \`agentop central up\` exited ${up}`)
    didSomething = true
  }

  // 3) Machine-in-Docker: recreate. The machine image is built from a repo checkout
  //    (docker/machine.yml), so this only applies when that compose is reachable —
  //    and when it isn't, the container KEEPS RUNNING THE OLD VERSION, which is a failure,
  //    not a footnote. Unlike the central, the machine runs with `network_mode: host`
  //    (docker/machine.yml), so it binds `PORT` directly and counts toward `restartedServer`.
  if (await dockerRunning(`ancestor=${MACHINE_IMAGE}`)) {
    const compose = join(process.cwd(), 'docker', 'machine.yml')
    if (await Bun.file(compose).exists()) {
      process.stdout.write('  Recreating the machine container (Docker)…\n')
      const code = await shInherit(['docker', 'compose', '-f', compose, 'up', '-d', '--build'])
      if (code !== 0) failures.push(`machine container: \`docker compose up -d --build\` exited ${code}`)
      didSomething = true
      restartedServer = true
    } else {
      failures.push(
        'machine container: docker/machine.yml not found here — it still runs the old version ' +
        '(re-run `agentop start` from the repo)',
      )
    }
  }

  if (!didSomething && failures.length === 0) {
    process.stdout.write(
      `  ${_D}No managed services detected running. If agentop is running in the foreground, ` +
      `restart it to apply.${_R}\n`,
    )
  }

  return { ok: failures.length === 0, failures, restartedServer }
}

// ---------------------------------------------------------------------------
// Confirm the restart actually took — a systemd/docker command REPORTING success only means the
// OS accepted it. Measured: after a reboot an orphaned `agentop server` (ppid 1, started outside
// the systemd unit) held ports 47291/47292 with the OLD binary; `systemctl --user restart
// agentop-server` succeeded, the unit's own process then failed to bind the already-taken port and
// crash-looped, and `agentop upgrade` printed "Done — now running vX" while `GET /api/version`
// went on answering the version that was current before the upgrade. `restartRunningServices`'s
// `ok` cannot see this — it is a fact about systemd's command queue, not about who is answering
// requests. This is the one check that asks the thing actually being claimed.
// ---------------------------------------------------------------------------

export interface VersionPollResult {
  /** True once something answered `/api/version` with exactly `want`. */
  ok: boolean
  /** The version last seen answering, or `null` if nothing ever answered. */
  observed: string | null
  /**
   * Why it ended: `matched` (ok), `stale` (something answers with ANOTHER version), `busy` (something is
   * bound but never answered in time — a server still starting), `down` (nothing was bound: connections refused).
   */
  state: 'matched' | 'stale' | 'busy' | 'down'
}

/** A timeout or an abort: the port is bound, the process is just not answering yet. Anything else (refused, reset) is "nothing there". */
function isBusyError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * Poll this machine's own `/api/version` until it reports `want`, or the bounded time runs out.
 *
 * **The window is adaptive.** A freshly restarted server spends its first moments (up to a minute and
 * more on a big machine) building its first data, and a request meanwhile TIMES OUT rather than being
 * refused. A fixed window then called a server that was simply still starting a failure. So: a refused
 * connection (nothing bound) never extends the window — it ends at `timeoutMs`; a timeout or a non-OK
 * answer (something IS bound, busy) keeps it open — each such tick holds the deadline at least half the
 * base window ahead — up to the hard cap `maxMs`. An ANSWER with another version is not "starting": the
 * fixed window applies and the result is `stale`.
 *
 * `fetchImpl`/`sleepImpl`/`nowImpl` are injectable so the bounded-time behavior is testable without a
 * real clock, a real socket, or a real wait.
 */
export async function pollRunningVersion(
  port: number,
  want: string,
  opts: {
    timeoutMs?: number
    maxMs?: number
    intervalMs?: number
    fetchImpl?: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
    sleepImpl?: (ms: number) => Promise<void>
    nowImpl?: () => number
  } = {},
): Promise<VersionPollResult> {
  const baseMs = opts.timeoutMs ?? 60_000
  const maxMs = Math.max(baseMs, opts.maxMs ?? 180_000)
  const intervalMs = opts.intervalMs ?? 1_000
  const doFetch = opts.fetchImpl ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(5_000) }))
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = opts.nowImpl ?? Date.now
  const start = now()
  const hardDeadline = start + maxMs
  let deadline = start + baseMs

  let observed: string | null = null
  let busy = false
  for (;;) {
    let tickBusy = false
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/api/version`)
      if (res.ok) {
        const body = await res.json() as { current?: unknown }
        if (typeof body.current === 'string') {
          observed = body.current
          if (observed === want) return { ok: true, observed, state: 'matched' }
        }
      } else tickBusy = true // bound, but answering 5xx while it boots
    } catch (e) {
      tickBusy = isBusyError(e)
    }
    busy = tickBusy
    if (tickBusy) deadline = Math.min(hardDeadline, Math.max(deadline, now() + baseMs / 2))
    if (now() >= deadline) return { ok: false, observed, state: observed !== null ? 'stale' : busy ? 'busy' : 'down' }
    await sleep(intervalMs)
  }
}

/** What is holding the local port, when the poll above never sees the new version. */
export interface PortHolderFacts {
  pid?: number
  cmd?: string
  /** `systemctl --user is-active agentop-server`'s own word, when systemd is available. */
  unitState?: string
}

async function portHolderFacts(port: number): Promise<PortHolderFacts> {
  const lsof = await sh(['lsof', '-ti', `tcp:${port}`, '-sTCP:LISTEN'])
  const pid = Number(lsof.out.split(/\s+/).filter(Boolean)[0])
  const facts: PortHolderFacts = {}
  if (Number.isInteger(pid) && pid > 0) {
    facts.pid = pid
    const ps = await sh(['ps', '-o', 'args=', '-p', String(pid)])
    if (ps.out) facts.cmd = ps.out
  }
  if (platform() === 'linux') {
    const active = await sh(['systemctl', '--user', 'is-active', 'agentop-server'])
    if (active.out) facts.unitState = active.out
  }
  return facts
}

/**
 * The sentence(s) naming what is still running instead of the new version and the exact command to
 * fix it — never a bare "the restart failed". Pure so the wording is tested without spawning
 * anything; `describeStaleServer`'s `port`/`want`/`observed` come straight from `pollRunningVersion`
 * and `portHolderFacts` above.
 */
export function describeStaleServer(o: PortHolderFacts & { port: number; want: string; observed: string | null }): string[] {
  const lines: string[] = []
  lines.push(o.observed !== null
    ? `The server answering on port ${o.port} still reports v${o.observed}, not v${o.want}.`
    : `Nothing answered on port ${o.port} after the restart — it may still be starting, or failed to bind the port.`)
  if (o.pid) lines.push(`  pid ${o.pid} is holding the port${o.cmd ? `: \`${o.cmd}\`` : ''}`)
  if (o.unitState) lines.push(`  agentop-server unit: ${o.unitState}`)
  lines.push(o.pid
    ? `  Fix: kill ${o.pid} (it is not the unit's tracked process), then \`systemctl --user restart agentop-server\`.`
    : `  Fix: \`systemctl --user restart agentop-server\` — or \`agentop restart server\`.`)
  return lines
}

/**
 * The sentence(s) for the OTHER failure shape `describeStaleServer` cannot name: a server was
 * genuinely restarted (the systemd/docker command itself reported success) and the poll's whole
 * window passed with NOTHING answering `/api/version` at all — a crash-loop that never binds the
 * port even once looks identical, from `pollRunningVersion`'s side, to "nothing runs here", and the
 * only thing that tells them apart is knowing a restart was expected. Never invents a pid/unit
 * state it does not have; `portHolderFacts.unitState` carries systemd's own word (`failed`,
 * `activating (auto-restart)`, `inactive`, …) when systemd is available.
 */
export function describeUnconfirmedRestart(o: PortHolderFacts & { port: number; want: string; busy?: boolean }): string[] {
  const lines: string[] = []
  lines.push(o.busy
    ? `The restarted server is up on port ${o.port} but is still starting — it had not answered /api/version by the end of the check window. v${o.want} is probably fine; check again shortly.`
    : `A server was restarted, but nothing answered on port ${o.port} within the check window — ` +
      `v${o.want} may have failed to start.`)
  if (o.pid) lines.push(`  pid ${o.pid} is holding the port${o.cmd ? `: \`${o.cmd}\`` : ''}`)
  lines.push(`  agentop-server unit: ${o.unitState ?? 'unknown (systemd unavailable, or not a systemd service)'}`)
  lines.push('  Inspect it: `systemctl --user status agentop-server`')
  lines.push('  Recent logs: `journalctl --user -u agentop-server -n 50`')
  return lines
}

/** What `runUpgrade` decided about the just-applied restart, from the poll alone. */
export type VersionVerification =
  | { ok: true }
  | { ok: false; reason: 'mismatch' }
  | { ok: false; reason: 'unconfirmed' }

/**
 * Pure: turns a poll result plus "was a server that answers this port actually restarted?" into a
 * pass/fail verdict — never a confident success on either failure shape.
 *
 * - The new version answered → `ok: true`.
 * - SOMETHING answered and it never became the new version → `mismatch` (the originally measured
 *   defect: an orphan process squatting the port).
 * - NOTHING ever answered, but a restart genuinely happened → `unconfirmed` (a restarted service
 *   that crash-loops hard enough to never bind the port even once during the poll is exactly the
 *   same "success claimed while the service is down" bug, for a different trigger).
 * - NOTHING ever answered and NOTHING was restarted → `ok: true`. There was nothing to confirm: a
 *   foreground/dev setup with no managed service is not a failure this check exists to catch.
 */
export function decideVersionVerification(
  verified: VersionPollResult,
  restartedServer: boolean,
): VersionVerification {
  if (verified.ok) return { ok: true }
  if (verified.observed !== null) return { ok: false, reason: 'mismatch' }
  if (restartedServer) return { ok: false, reason: 'unconfirmed' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Unattended (critical) upgrade — lock + detached spawn
//
// `agentop check-update` runs from a shell rc hook on every terminal open. When the
// newest release is flagged critical it installs the update WITHOUT asking, but it
// must never hold the user's terminal — so it spawns a detached `agentop upgrade`,
// logs to a file and returns immediately. Two terminals opening at once would race,
// hence the lock file below. The lock is held for the WHOLE install (runUpgrade takes
// it too), so a hand-run `agentop upgrade` can never interleave with the background one.
// ---------------------------------------------------------------------------

/** Guards concurrent upgrades. Holds the pid of the running upgrade. */
export const UPGRADE_LOCK_FILE = join(AGENTISTICS_DATA_DIR, 'upgrade.lock')
/** Where the detached upgrade's output goes (the terminal gets nothing). */
export const AUTO_UPGRADE_LOG = join(AGENTISTICS_DATA_DIR, 'auto-upgrade.log')
/** A lock older than this is treated as abandoned (crash / killed -9 / pid reuse). */
export const UPGRADE_LOCK_TTL_MS = 30 * 60 * 1000
/** Set on the detached child so it ADOPTS the lock its spawner already took instead of
 *  seeing it as somebody else's and refusing to run. */
export const UPGRADE_LOCK_ENV = 'AGENTISTICS_UPGRADE_LOCK'

export interface UpgradeLock {
  pid: number
  version: string
  startedAt: number
}

/** Pure: parse a lock file's contents. Returns null for junk/truncated content. */
export function parseUpgradeLock(raw: string): UpgradeLock | null {
  try {
    const o = JSON.parse(raw) as Partial<UpgradeLock>
    if (!o || typeof o.pid !== 'number' || !Number.isFinite(o.pid) || o.pid <= 0) return null
    return {
      pid: o.pid,
      version: typeof o.version === 'string' ? o.version : '',
      startedAt: typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : 0,
    }
  } catch {
    return null
  }
}

/**
 * Pure: is an existing lock still held? A lock counts as active only while its process
 * is alive AND it is younger than the TTL — so a crashed upgrade can never wedge the
 * mechanism permanently, and a reused pid can't keep it alive forever either.
 */
export function isUpgradeLockActive(
  lock: UpgradeLock | null,
  now: number,
  isPidAlive: (pid: number) => boolean,
  ttlMs: number = UPGRADE_LOCK_TTL_MS,
): boolean {
  if (!lock) return false
  if (now - lock.startedAt >= ttlMs) return false
  return isPidAlive(lock.pid)
}

/** signal 0 probes liveness without delivering anything. EPERM = alive but not ours. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

const lockPayload = (pid: number, version: string) => JSON.stringify({ pid, version, startedAt: Date.now() })

export type LockResult =
  | { state: 'acquired' | 'adopted' | 'unavailable' }
  | { state: 'busy'; pid: number }

/**
 * Takes the upgrade lock for THIS process.
 *
 * `adopt` (the detached child, via UPGRADE_LOCK_ENV) re-stamps the lock with its own pid
 * unconditionally: the lock is already ours, taken by the spawner on our behalf.
 * Otherwise the lock is created with the exclusive `wx` flag (atomic), so of two racing
 * processes exactly one wins; a stale lock (dead pid or past the TTL) is taken over.
 *
 * `unavailable` means the lock file itself could not be written (read-only HOME): the caller
 * proceeds unlocked rather than refusing to ever upgrade.
 */
export function acquireUpgradeLock(version: string, adopt: boolean): LockResult {
  try {
    mkdirSync(AGENTISTICS_DATA_DIR, { recursive: true })
    if (adopt) {
      writeFileSync(UPGRADE_LOCK_FILE, lockPayload(process.pid, version))
      return { state: 'adopted' }
    }
    try {
      writeFileSync(UPGRADE_LOCK_FILE, lockPayload(process.pid, version), { flag: 'wx' })
      return { state: 'acquired' }
    } catch (err: any) {
      if (err?.code !== 'EEXIST') return { state: 'unavailable' }
      let existing: UpgradeLock | null = null
      try { existing = parseUpgradeLock(readFileSync(UPGRADE_LOCK_FILE, 'utf8')) } catch { /* unreadable → stale */ }
      if (isUpgradeLockActive(existing, Date.now(), pidAlive)) return { state: 'busy', pid: existing!.pid }
      writeFileSync(UPGRADE_LOCK_FILE, lockPayload(process.pid, version))
      return { state: 'acquired' }
    }
  } catch {
    return { state: 'unavailable' }
  }
}

/** Re-stamps the held lock with the version we resolved (informational only). */
function stampUpgradeLock(version: string): void {
  try { writeFileSync(UPGRADE_LOCK_FILE, lockPayload(process.pid, version)) } catch { /* best-effort */ }
}

export type BackgroundUpgradeResult =
  | 'started'
  | 'in-progress'
  | 'not-installed'
  | 'unsupported'
  | 'backoff'
  | 'failed'

/**
 * Pure: is this process the installed `agentop` binary (as opposed to `bun bin/cli.ts` in a
 * source checkout)? runUpgrade replaces process.execPath — from a checkout that path is the
 * BUN runtime itself, so an unattended upgrade there would clobber the user's bun install.
 * Auto-install is therefore restricted to the compiled binary; source checkouts get the
 * normal banner and can still run `agentop upgrade` deliberately.
 */
export function isInstalledBinary(execPath: string, scriptPath: string | undefined): boolean {
  if (scriptPath && (scriptPath.endsWith('.ts') || scriptPath.endsWith('.js'))) return false
  const base = (execPath.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '')
  return base !== 'bun' && base !== 'node'
}

/**
 * Starts `agentop upgrade` as a DETACHED background process and returns immediately —
 * the caller's terminal is never held. Output is appended to AUTO_UPGRADE_LOG.
 *
 * Refuses (without downloading anything) when self-install is unsupported on this
 * platform/arch, and when the same version already failed recently (backoff).
 */
export async function startBackgroundUpgrade(version: string): Promise<BackgroundUpgradeResult> {
  // Never self-install over a dev checkout's runtime — see isInstalledBinary.
  if (!isInstalledBinary(process.execPath, process.argv[1])) return 'not-installed'
  // No published asset for this platform/arch → an unattended install would brick it. The version
  // is threaded through here too, not just on the manual path: `runUpgrade` is what actually
  // downloads, and both share it, so a gate that resolved a different URL from the one about to be
  // fetched would be checking the wrong thing.
  if (!resolveUpgradeAsset(process.platform, process.arch, version)) return 'unsupported'
  // A previously failing target backs off instead of re-downloading on every shell.
  if (!shouldAttemptUpgrade(readUpgradeFailure(), version, Date.now())) return 'backoff'

  const lock = acquireUpgradeLock(version, false)
  if (lock.state === 'busy') return 'in-progress'
  if (lock.state === 'unavailable') return 'failed'

  try {
    // Guaranteed by isInstalledBinary above: execPath IS agentop, so it takes the
    // subcommand directly (no script argument to forward).
    appendFileSync(AUTO_UPGRADE_LOG, `\n=== ${new Date().toISOString()} — auto-installing v${version} ===\n`)
    const fd = openSync(AUTO_UPGRADE_LOG, 'a')
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['upgrade'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      // The child adopts this lock instead of colliding with it.
      env: { ...process.env, [UPGRADE_LOCK_ENV]: '1' },
    })
    // Detach fully: a new process group + unref so this process can exit right now.
    child.unref()
    try { closeSync(fd) } catch { /* the child kept its own dup */ }
    // Re-stamp the lock with the pid that actually does the work, so liveness tracks it.
    if (child.pid) writeFileSync(UPGRADE_LOCK_FILE, lockPayload(child.pid, version))
    return 'started'
  } catch {
    try { unlinkSync(UPGRADE_LOCK_FILE) } catch { /* nothing to release */ }
    return 'failed'
  }
}

/**
 * Releases the lock on exit when THIS process owns it. Registered by runUpgrade so every
 * exit path (success, `process.exit(1)`, throw) frees the lock without extra bookkeeping.
 */
function armUpgradeLockRelease(): void {
  process.on('exit', () => {
    try {
      const lock = parseUpgradeLock(readFileSync(UPGRADE_LOCK_FILE, 'utf8'))
      if (lock?.pid === process.pid) unlinkSync(UPGRADE_LOCK_FILE)
    } catch { /* no lock (unwritable HOME) or already gone */ }
  })
}

interface InstallOutcome {
  ok: boolean
  /** Machine-readable failure cause, recorded for the backoff state. */
  reason?: string
  /** Set when the failure was a permission problem — the download is left here for `sudo mv`. */
  keptTmp?: string
  /** Set when the previous binary was restored after a failed install. */
  rolledBack?: boolean
  /** Where the replaced binary was kept on success. */
  backup?: string
}

/**
 * Verify → stage → back up → swap → re-verify. The live binary is only ever replaced by a
 * file we have already RUN successfully, and the file it replaces is kept so any failure
 * (including one only visible after the swap) can be undone.
 */
async function installDownloadedBinary(
  bytes: Uint8Array,
  currentBin: string,
  expected: string,
  s: CliStrings,
): Promise<InstallOutcome> {
  // 1) Bytes must look like an executable for THIS platform before they touch the disk.
  const verified = verifyDownload(bytes, process.platform)
  if (!verified.ok) return { ok: false, reason: verified.reason }

  // 2) Stage next to the target under a name nobody else can pick (same dir → atomic rename).
  const tmpPath = tempBinaryPath(currentBin, `${process.pid}-${randomBytes(6).toString('hex')}`)
  try {
    await Bun.write(tmpPath, bytes)
    if (process.platform !== 'win32') await chmod(tmpPath, 0o755)
  } catch (err: any) {
    await unlink(tmpPath).catch(() => {})
    return { ok: false, reason: `could not write ${tmpPath}: ${err?.message ?? String(err)}` }
  }

  // 3) The strongest cheap check there is: run it and make it identify itself.
  process.stdout.write(`${s.upgradeVerifying}\n`)
  const probe = checkBinaryVersionOutput(await probeBinaryVersion(tmpPath), expected)
  if (!probe.ok) {
    await unlink(tmpPath).catch(() => {})
    return {
      ok: false,
      reason: probe.found
        ? `downloaded binary reports v${probe.found}, expected v${expected}`
        : 'downloaded binary did not run (`--version` produced nothing usable)',
    }
  }

  writeProgress({ stage: 'swapping', version: expected })
  // 4) Move the working binary aside FIRST — that is the rollback copy, and on Windows it is
  //    also the only way to replace a running executable.
  const backup = backupBinaryPath(currentBin)
  try {
    await rm(backup, { force: true })
    await rename(currentBin, backup)
  } catch (err: any) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      return { ok: false, reason: 'permission denied', keptTmp: tmpPath }
    }
    await unlink(tmpPath).catch(() => {})
    return { ok: false, reason: `could not back up the current binary: ${err?.message ?? String(err)}` }
  }

  // 5) Swap in the verified file; anything going wrong here restores the backup.
  try {
    await rename(tmpPath, currentBin)
    if (process.platform !== 'win32') await chmod(currentBin, 0o755)
    if (process.platform === 'darwin') await sh(['xattr', '-d', 'com.apple.quarantine', currentBin])
  } catch (err: any) {
    await rename(backup, currentBin).catch(() => {})
    await unlink(tmpPath).catch(() => {})
    return { ok: false, reason: `could not install the new binary: ${err?.message ?? String(err)}`, rolledBack: true }
  }

  // 6) Post-install check at the FINAL path (permissions/ACLs/noexec can differ from the temp
  //    name). If the installed binary can't identify itself, put the old one back.
  const after = checkBinaryVersionOutput(await probeBinaryVersion(currentBin), expected)
  if (!after.ok) {
    await rm(currentBin, { force: true }).catch(() => {})
    await rename(backup, currentBin).catch(() => {})
    return { ok: false, reason: 'the installed binary failed its post-install check', rolledBack: true }
  }

  return { ok: true, backup }
}

/**
 * `agentop upgrade`. Returns a process exit code — 0 only when the new binary is installed,
 * verified AND every running service was restarted onto it.
 */
export async function runUpgrade(lang: CliLang = 'en'): Promise<number> {
  const s = cliStrings(lang)

  // The install replaces process.execPath. From a source checkout (`bun bin/cli.ts upgrade`)
  // that path is the BUN RUNTIME — installing over it would clobber the user's bun. Only the
  // background spawner used to check this; a hand-run upgrade must be gated too.
  if (!isInstalledBinary(process.execPath, process.argv[1])) {
    process.stderr.write(`\n  ${_Y}${s.upgradeFromSource(process.execPath)}${_R}\n\n`)
    return 1
  }

  // The lock covers the WHOLE upgrade, not just the spawner: two installs writing the binary
  // at the same time is exactly the interleaving that corrupts it.
  const lock = acquireUpgradeLock('', process.env[UPGRADE_LOCK_ENV] === '1')
  if (lock.state === 'busy') {
    process.stdout.write(`\n  ${_D}${s.upgradeInProgress(lock.pid)}${_R}\n\n`)
    return 0
  }
  if (lock.state === 'unavailable') {
    process.stderr.write(`  ${_Y}${s.upgradeLockUnavailable}${_R}\n`)
  } else {
    armUpgradeLockRelease()
  }

  process.stdout.write('Checking for updates...\n')
  writeProgress({ stage: 'checking', version: '' })

  let info
  try {
    info = await getVersionInfo({ force: true })
  } catch {
    console.error('Failed to check for updates. Check your internet connection.')
    writeProgress({ stage: 'failed', version: '', reason: 'version check failed' })
    return 1
  }

  if (!info.hasUpdate) {
    console.log(`Already on the latest version (${_GR}${_B}v${info.current}${_R}).`)
    // The BINARY is current; the running SERVER may not be (2026-10-04: v2.103.1 installed, a
    // v2.101.2 server outside the unit kept serving). Then the restart is the whole job, not a
    // needless one — and it is the only one this branch ever does.
    const running = await runningServerVersion()
    if (running && compareVersions(running, info.current) < 0) {
      process.stdout.write(`  The running server is v${running} — moving it onto the installed v${info.current}…\n`)
      const outcome = await restartRunningServices(process.execPath, info.current)
      for (const f of outcome.failures) process.stderr.write(`  ${_Y}${f}${_R}\n`)
      writeProgress({ stage: outcome.ok ? 'done' : 'failed', version: info.current, ...(outcome.ok ? {} : { reason: outcome.failures[0] ?? 'restart failed' }) })
      clearUpgradeFailure()
      return outcome.ok ? 0 : 1
    }
    writeProgress({ stage: 'done', version: info.current })
    clearUpgradeFailure()
    return 0
  }
  stampUpgradeLock(info.latest)

  // Platform/arch gate — refuse BEFORE downloading anything.
  const target = resolveUpgradeAsset(process.platform, process.arch, info.latest)
  if (!target) {
    const id = `${process.platform}/${process.arch}`
    process.stderr.write(
      `\n  ${_Y}${_B}${s.upgradeUnsupported(id)}${_R}\n` +
      `  ${s.upgradeManualHow(RELEASES_PAGE)}\n\n`,
    )
    recordUpgradeFailure(info.latest, `unsupported platform ${id}`)
    return 1
  }

  process.stdout.write(
    `\n  ${_D}Current:${_R} ${_WH}v${info.current}${_R}\n` +
    `  ${_D}Latest: ${_R} ${_GR}${_B}v${info.latest}${_R}\n\n`,
  )
  process.stdout.write(`Downloading ${target.asset}...\n`)
  writeProgress({ stage: 'downloading', version: info.latest, received: 0 })

  let resp: Response
  try {
    resp = await fetchFirstOk(target.urls, {
      headers: { 'User-Agent': `agentistics/${CURRENT_VERSION}` },
      signal: AbortSignal.timeout(120_000),
    })
  } catch (err: any) {
    console.error(`Download failed: ${err.message}`)
    recordUpgradeFailure(info.latest, `download failed: ${err?.message ?? String(err)}`)
    return 1
  }

  if (!resp.ok) {
    // A 404 on a VERSION-addressed URL is a different fact from a network failure, and now that
    // the URL names a version it can say which one: the release exists but this platform's asset
    // was not published for it. Naming both is what makes a missing binary reportable instead of
    // looking like a broken connection.
    const detail = resp.status === 404
      ? `HTTP 404 — release v${info.latest} has no ${target.asset} asset`
      : `HTTP ${resp.status}`
    console.error(`Download failed: ${detail}`)
    recordUpgradeFailure(info.latest, `download failed: ${detail}`)
    return 1
  }

  const currentBin = process.execPath
  // Reading the body must be guarded too, not just the fetch: the transfer is ~140 MB, so the
  // 120s timeout firing mid-stream (or a reset connection) is the MOST likely failure of the whole
  // command. Outside the guard it rejected out of runUpgrade, skipping recordUpgradeFailure — so
  // the backoff never learned about the one failure it exists to throttle, and the user got a raw
  // stack trace instead of a message.
  let bytes: Uint8Array
  try {
    bytes = await readBodyWithProgress(resp, info.latest)
  } catch (err: any) {
    console.error(`Download failed: ${err?.message ?? String(err)}`)
    recordUpgradeFailure(info.latest, `download interrupted: ${err?.message ?? String(err)}`)
    return 1
  }
  writeProgress({ stage: 'verifying', version: info.latest })
  const installed = await installDownloadedBinary(bytes, currentBin, info.latest, s)

  if (!installed.ok) {
    if (installed.keptTmp) {
      process.stderr.write(
        `\n${_Y}Permission denied.${_R} The binary was downloaded and verified at:\n` +
        `  ${installed.keptTmp}\n\n` +
        `Run the following to finish the upgrade:\n` +
        `  ${_WH}sudo mv ${installed.keptTmp} ${currentBin}${_R}\n\n`,
      )
    } else {
      process.stderr.write(`\n  ${_RD}${s.upgradeVerifyFailed(installed.reason ?? 'unknown error')}${_R}\n`)
      if (installed.rolledBack) {
        process.stderr.write(`  ${s.upgradeRolledBack(backupBinaryPath(currentBin))}\n`)
      } else {
        process.stderr.write(`  ${s.upgradeUntouched}\n`)
      }
      process.stderr.write('\n')
    }
    recordUpgradeFailure(info.latest, installed.reason ?? 'install failed')
    return 1
  }

  clearUpgradeFailure()
  process.stdout.write(`\n${_GR}${_B}Updated to v${info.latest}!${_R}\n`)
  process.stdout.write(`${_D}${s.upgradeBackupKept(installed.backup ?? '')}${_R}\n\n`)

  // Auto-apply: bounce any running services so they run the new version immediately.
  process.stdout.write('Applying the update to running services…\n')
  writeProgress({ stage: 'restarting', version: info.latest })
  try {
    await restartRunningServices(currentBin, info.latest, installed.backup)
  } catch { /* /api/version below is authoritative even when the helper cannot report a result */ }

  // THE SERVER ITSELF IS THE FINAL WORD. A restart verdict is built from side facts (a pid read with
  // lsof/ss, a unit state), and any of them can be wrong or unobtainable while the new version is
  // already answering — 2026-10-05, 2.104.0 → 2.104.1: the service came back and answered /api/version
  // in about a second, the pid lookup returned nothing, and the upgrade recorded `failed` over a
  // healthy server (and the page said "the update did not finish"). So before any failure is
  // recorded, ask the port what it runs: exactly the target version means the upgrade succeeded.
  // The restart command succeeding only means systemd/docker ACCEPTED it. An orphaned process
  // from before a reboot can go on holding the port while the unit's own new process crash-loops
  // trying to bind it — invisible to every check above, and exactly what let a previous run print
  // "Done — now running vX" while `GET /api/version` kept answering the version that was current
  // before the upgrade. This is the one check that asks what is actually answering requests.
  //
  // A restarted server whose OWN new process never binds the port at all (a harder crash-loop —
  // broken build, missing dependency, a fatal startup error) leaves `observed === null`; the
  // command now reports that as unconfirmed instead of printing "Done" over a server that is down.
  // Keep polling even when the service-manager helper reported a failure. It may have returned
  // before the replacement finished booting, and the HTTP endpoint is the authoritative answer.
  const verified = await pollRunningVersion(PORT, info.latest)
  // A completed binary upgrade is only reported as successful once the new server identity has
  // answered; do not claim success while this endpoint is still down.
  const decision: VersionVerification = verified.ok
    ? { ok: true }
    : { ok: false, reason: verified.observed !== null ? 'mismatch' : 'unconfirmed' }
  if (!decision.ok) {
    const facts = await portHolderFacts(PORT)
    const lines = decision.reason === 'mismatch'
      ? describeStaleServer({ port: PORT, want: info.latest, observed: verified.observed, ...facts })
      : describeUnconfirmedRestart({ port: PORT, want: info.latest, busy: verified.state === 'busy', ...facts })
    process.stderr.write(
      `\n  ${_Y}${_B}${s.upgradeVersionUnconfirmed(info.latest)}${_R}\n` +
      lines.map(l => `    ${l}\n`).join('') +
      '\n',
    )
    recordUpgradeFailure(
      info.latest,
      decision.reason === 'mismatch'
        ? `server still answering as v${verified.observed}`
        : verified.state === 'busy' ? 'restarted server was still starting at the end of the check window' : 'restarted server never answered /api/version',
    )
    return 1
  }

  // WSL: an upgraded machine may never have had autostart set up (WSL.1 only ran at install), or
  // still hold the old logon task that let WSL idle the distro out. Repaired here, one line.
  try {
    const { repairWslAutostart } = await import('./autostart.ts')
    const line = await repairWslAutostart()
    if (line) process.stdout.write(`  ${line}\n`)
  } catch { /* the upgrade itself succeeded; autostart repair is best-effort */ }

  // The installed binary may have a new path. Refresh only an integration the user had already
  // opted into, using the same idempotent merge as `agentop hooks install`.
  try {
    const { refreshInstalledHooks } = await import('./cli-hooks.ts')
    await refreshInstalledHooks()
  } catch { /* hook repair is best-effort; it must not undo a verified upgrade */ }

  // Success is recorded explicitly, and any failure memory of THIS version is dropped with it.
  clearUpgradeFailure()
  writeProgress({ stage: 'done', version: info.latest })
  process.stdout.write(`\n${_GR}${_B}Done — now running v${info.latest}.${_R}\n\n`)
  return 0
}
