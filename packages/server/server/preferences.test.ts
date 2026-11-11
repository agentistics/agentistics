import { test, expect, spyOn } from 'bun:test'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'node:url'
import {
  readPreferencesFrom, writePreferencesTo, updatePreferencesAt, legacyPreferencesSource,
  LOCK_STALE_MS, LOCK_ACQUIRE_TIMEOUT_MS, __setTestOnlyDisableLock,
  __setTestOnlyForceLockVanished, __setTestOnlyAcquireTimeoutMs, PreferencesLockTimeoutError,
} from './preferences'
import type { CheckinConfig } from './checkin'

test('check-in defaults writes accept every per-session interval and supported global pause', async () => {
  const { primary } = tmpPaths()
  for (const intervalMin of [15, 30, 60, 120] as const) {
    for (const paused of [null, { until: null }]) {
      const checkinDefaults: CheckinConfig = { intervalMin, paused, checklist: [{ id: 'fleet', enabled: false }] }
      await writePreferencesTo(primary, null, { checkinDefaults })
      expect((await readPreferencesFrom(primary, null)).checkinDefaults).toEqual(checkinDefaults)
    }
  }
})

test('malformed check-in defaults reject the entire preferences write and preserve stored choices', async () => {
  const { primary } = tmpPaths()
  const valid: CheckinConfig = { intervalMin: 60, paused: { until: null }, checklist: [{ id: 'fleet', enabled: false }] }
  await writePreferencesTo(primary, null, { checkinDefaults: valid, theme: 'dark' })
  const malformed: unknown[] = [
    null, 'invalid', [], {},
    { ...valid, intervalMin: 1, paused: { until: 123 } },
    ...[1, 45, '60', null].map(intervalMin => ({ ...valid, intervalMin })),
    ...[{}, [], true, { until: 123 }, { until: 'later' }].map(paused => ({ ...valid, paused })),
    ...[null, {}, [null], [{ id: 'unknown', enabled: true }], [{ id: 'fleet', enabled: 'no' }]].map(checklist => ({ ...valid, checklist })),
  ]
  for (const checkinDefaults of malformed) {
    await expect(writePreferencesTo(primary, null, { checkinDefaults: checkinDefaults as CheckinConfig, theme: 'light' }))
      .rejects.toThrow('invalid checkinDefaults')
    const stored = await readPreferencesFrom(primary, null)
    expect(stored.checkinDefaults).toEqual(valid)
    expect(stored.theme).toBe('dark')
  }
  // Unrelated saves do not revalidate, replace or reseed an existing agenda.
  await writePreferencesTo(primary, null, { theme: 'light' })
  expect((await readPreferencesFrom(primary, null)).checkinDefaults).toEqual(valid)
})

// Regression: preferences were stored under CLAUDE_DIR, which in Docker is the host ~/.claude mounted READ-ONLY at /host-claude.
// writePreferences therefore failed (EROFS) and every launch re-asked the archive-mode
// consent gate + the install prompt. Preferences must live in the writable ~/.agentistics
// dir, with a one-time migration from the legacy CLAUDE_DIR location so native installs
// keep their existing choices.

/**
 * `legacyPreferencesSource` — the PURE decision behind the isolation contract.
 *
 * The defect it pins: `~/.claude/agentistics-preferences.json` is derived from CLAUDE_DIR, the one
 * persisted path that is NOT under `AGENTISTICS_DATA_DIR`, so the legacy migration read it for
 * EVERY data dir. Starting a server with a brand-new, empty `AGENTISTICS_DIR` wrote a
 * `preferences.json` into it holding settings the operator never configured. An isolated instance
 * inherited another instance's choices.
 */
test('legacyPreferencesSource seeds the DEFAULT data dir and nothing else', () => {
  const legacy = '/home/u/.claude/agentistics-preferences.json'
  const def = '/home/u/.agentistics'

  // The default install still migrates — that is what the legacy file is for.
  expect(legacyPreferencesSource(def, def, legacy)).toBe(legacy)
  // A trailing separator names the same directory, so it must not read as isolated.
  expect(legacyPreferencesSource(def + '/', def, legacy)).toBe(legacy)

  // Any other data dir is isolated: no legacy file may seed it, ever.
  for (const isolated of ['/tmp/agy-iso', '/var/lib/agentistics', '/home/u/.agentistics-2', '/home/other/.agentistics']) {
    expect(legacyPreferencesSource(isolated, def, legacy)).toBeNull()
  }
})

test('a null legacy source is never read — an isolated data dir starts on defaults, not on someone else\'s settings', async () => {
  const { primary, legacy } = tmpPaths()
  // Seed the legacy location with a setting an isolated instance must never inherit.
  await Bun.write(legacy, JSON.stringify({ theme: 'dark' }))

  // Passing the legacy path migrates it (the default-data-dir case)...
  const migrated = await readPreferencesFrom(primary, legacy)
  expect(migrated.theme).toBe('dark')

  // ...but an isolated instance is given `null` and must see none of it.
  const { primary: isolatedPrimary } = tmpPaths()
  const isolated = await readPreferencesFrom(isolatedPrimary, null)
  expect(isolated.theme).toBeUndefined()
  // And nothing was written into the isolated dir at all: with no legacy source there is no
  // migration, so a pure read stays a pure read.
  expect(await Bun.file(isolatedPrimary).exists()).toBe(false)
})

function tmpPaths() {
  const base = join(tmpdir(), `agentistics-prefs-${crypto.randomUUID()}`)
  return {
    primary: join(base, 'agentistics', 'preferences.json'),
    legacy: join(base, 'claude', 'agentistics-preferences.json'),
  }
}

test('write then read round-trips through the primary (writable) path', async () => {
  const { primary, legacy } = tmpPaths()
  await writePreferencesTo(primary, legacy, { installDismissed: true, archiveMode: 'consolidate' })
  const p = await readPreferencesFrom(primary, legacy)
  expect(p.installDismissed).toBe(true)
  expect(p.archiveMode).toBe('consolidate')
  expect(await Bun.file(primary).exists()).toBe(true)
})

test('falls back to the legacy file and migrates it to the primary', async () => {
  const { primary, legacy } = tmpPaths()
  await Bun.write(legacy, JSON.stringify({ archiveMode: 'full', theme: 'light' }))
  const p = await readPreferencesFrom(primary, legacy)
  expect(p.archiveMode).toBe('full')
  expect(p.theme).toBe('light')
  // migration: the primary now exists so future reads never touch the (read-only) legacy dir
  expect(await Bun.file(primary).exists()).toBe(true)
})

test('primary wins over legacy when both exist', async () => {
  const { primary, legacy } = tmpPaths()
  await Bun.write(legacy, JSON.stringify({ archiveMode: 'off' }))
  await Bun.write(primary, JSON.stringify({ archiveMode: 'consolidate' }))
  const p = await readPreferencesFrom(primary, legacy)
  expect(p.archiveMode).toBe('consolidate')
})

test('both missing yields defaults (archiveMode undefined → gate shows once)', async () => {
  const { primary, legacy } = tmpPaths()
  const p = await readPreferencesFrom(primary, legacy)
  expect(p.archiveMode).toBeUndefined()
  expect(p.customLayout).toEqual([])
})

test('writePreferencesTo merges with legacy values on first write', async () => {
  const { primary, legacy } = tmpPaths()
  await Bun.write(legacy, JSON.stringify({ theme: 'light' }))
  await writePreferencesTo(primary, legacy, { installDismissed: true })
  const p = await readPreferencesFrom(primary, legacy)
  expect(p.theme).toBe('light')        // preserved from legacy
  expect(p.installDismissed).toBe(true)
})

// Serialized/atomic writes, shape migration, and preservation of corrupt preferences.

import { mkdtemp, writeFile, readFile, readdir, open, utimes, mkdir } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import { dirname } from 'node:path'

async function tmpPaths2() {
  const dir = await mkdtemp(join(osTmpdir(), 'agentistics-prefs-'))
  return { primary: join(dir, 'preferences.json'), legacy: join(dir, 'legacy.json') }
}

test('readPreferencesFrom returns defaults for an absent or empty file', async () => {
  const { primary, legacy } = await tmpPaths2()
  expect((await readPreferencesFrom(primary, legacy)).customLayout).toEqual([])
  await writeFile(primary, '   ')
  expect((await readPreferencesFrom(primary, legacy)).customLayout).toEqual([])
})

test('corrupt preferences are quarantined once and concurrent readers continue with defaults', async () => {
  const { primary } = await tmpPaths2()
  const broken = '{"team": {"connections": ['
  await writeFile(primary, broken)
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const reads = await Promise.all(Array.from({ length: 8 }, () => readPreferencesFrom(primary, null)))
    for (const prefs of reads) {
      expect(prefs.customLayout).toEqual([])
    }
    const backups = (await readdir(dirname(primary))).filter(n => n.startsWith('preferences.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dirname(primary), backups[0]!), 'utf8')).toBe(broken)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain(broken)
    await writePreferencesTo(primary, null, { theme: 'light' })
    expect((await readPreferencesFrom(primary, null)).theme).toBe('light')
    expect(await readFile(join(dirname(primary), backups[0]!), 'utf8')).toBe(broken)
  } finally { log.mockRestore() }
})

test('failed preferences quarantine preserves the original and refuses a subsequent write', async () => {
  const { primary } = await tmpPaths2()
  const broken = '{invalid'
  await writeFile(primary, broken)
  const stamp = Date.now()
  await mkdir(`${primary}.corrupt-${stamp}`)
  const clock = spyOn(Date, 'now').mockReturnValue(stamp)
  try {
    await expect(readPreferencesFrom(primary, null)).rejects.toThrow()
    await expect(writePreferencesTo(primary, null, { theme: 'light' })).rejects.toThrow()
    expect(await readFile(primary, 'utf8')).toBe(broken)
  } finally { clock.mockRestore() }
})

test('non-object preferences JSON is quarantined instead of crashing shape migration', async () => {
  for (const invalid of ['null', '[]', '42', '"text"']) {
    const { primary } = await tmpPaths2()
    await writeFile(primary, invalid)
    expect((await readPreferencesFrom(primary, null)).customLayout).toEqual([])
    const backups = (await readdir(dirname(primary))).filter(n => n.startsWith('preferences.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dirname(primary), backups[0]!), 'utf8')).toBe(invalid)
  }
})

test('concurrent writes are serialized — no lost update', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, { theme: 'dark' })
  await Promise.all([
    writePreferencesTo(primary, legacy, { lang: 'pt' }),
    writePreferencesTo(primary, legacy, { currency: 'BRL' }),
    writePreferencesTo(primary, legacy, { monthlyBudgetUSD: 100 }),
  ])
  const prefs = await readPreferencesFrom(primary, legacy)
  expect(prefs.theme).toBe('dark')
  expect(prefs.lang).toBe('pt')
  expect(prefs.currency).toBe('BRL')
  expect(prefs.monthlyBudgetUSD).toBe(100)
})

/**
 * A CONCURRENT READER is what makes this test about atomicity. Asserting only that the file
 * parses AFTER every write has settled passes just as well against a plain `Bun.write`, which
 * truncates in place — the torn state exists, the old test simply never looked at it. Here a
 * second task reads the file in a tight loop while the writes run and every single read must
 * parse.
 */
async function readUntilDone(path: string, done: () => boolean): Promise<number> {
  let reads = 0
  while (!done()) {
    let text: string
    try {
      text = await readFile(path, 'utf-8')
    } catch {
      continue // not created yet, or observed exactly between unlink and rename — not a tear
    }
    if (text === '') continue
    reads++
    JSON.parse(text) // throws → the reader observed a partially written file
    await new Promise(r => setTimeout(r, 0))
  }
  return reads
}

test('a concurrent reader NEVER observes a partially written file', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, { monthlyBudgetUSD: -1 })
  let finished = false
  const reader = readUntilDone(primary, () => finished)
  const writes = Array.from({ length: 40 }, (_, i) => writePreferencesTo(primary, legacy, { monthlyBudgetUSD: i, theme: i % 2 ? 'dark' : 'light' }))
  await Promise.all(writes)
  finished = true
  const reads = await reader
  expect(reads).toBeGreaterThan(0)
  const text = await readFile(primary, 'utf-8')
  expect(() => JSON.parse(text)).not.toThrow()
  const leftoverTmp = (await readdir(dirname(primary))).filter(f => f.includes('.tmp-'))
  expect(leftoverTmp).toEqual([])
})

// Follow-up fix (review): writeFileAtomic's tmp name used to be unique only per PROCESS
// (`${path}.tmp-${process.pid}`), not per call. readPreferencesFrom's legacy-migration branch
// called writeFileAtomic directly, outside the write chain writePreferencesTo uses — two
// concurrent migration writes (or a migration racing writePreferencesTo) could pick the
// IDENTICAL tmp filename and interleave/corrupt it before either rename() fired. Fixed by (1)
// mixing a monotonic counter + random suffix into the tmp name so every call gets a distinct
// path, and (2) routing the migration write through the SAME `enqueueWrite` chain as
// writePreferencesTo (via a non-writing `readEffective` helper so the chain can't re-enter
// itself and deadlock).

test('concurrent legacy-migration reads never collide on the tmp filename — a reader mid-flight always sees whole JSON', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writeFile(legacy, JSON.stringify({ archiveMode: 'full', theme: 'light' }))
  let finished = false
  const reader = readUntilDone(primary, () => finished)
  const results = await Promise.all(Array.from({ length: 20 }, () => readPreferencesFrom(primary, legacy)))
  finished = true
  await reader
  for (const r of results) {
    expect(r.archiveMode).toBe('full')
    expect(r.theme).toBe('light')
  }
  const text = await readFile(primary, 'utf-8')
  expect(() => JSON.parse(text)).not.toThrow()
  const leftoverTmp = (await readdir(dirname(primary))).filter(f => f.includes('.tmp-'))
  expect(leftoverTmp).toEqual([])
})

test('a legacy migration racing an explicit write never loses either — both survive', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writeFile(legacy, JSON.stringify({ archiveMode: 'full', theme: 'light' }))
  const [migrated] = await Promise.all([
    readPreferencesFrom(primary, legacy),
    writePreferencesTo(primary, legacy, { installDismissed: true }),
  ])
  // The migration read itself always sees the legacy content (in-memory result), regardless
  // of which write wins the race to land on disk first.
  expect(migrated.archiveMode).toBe('full')
  expect(migrated.theme).toBe('light')
  // The FINAL on-disk state must have both the migrated legacy fields and the explicit write —
  // neither the migration's write nor writePreferencesTo's write may clobber the other's data.
  const final = await readPreferencesFrom(primary, legacy)
  expect(final.archiveMode).toBe('full')
  expect(final.theme).toBe('light')
  expect(final.installDismissed).toBe(true)
})

test('a corrupt LEGACY file does not throw — the primary is authoritative and legacy corruption is not fatal', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writeFile(legacy, '{not valid json')
  const prefs = await readPreferencesFrom(primary, legacy)
  expect(prefs.customLayout).toEqual([])
})

// ---------------------------------------------------------------------------
// Cross-process lock (Task 5) — `enqueueWrite` only serializes writes WITHIN one process; Bun
// serves dashboard requests concurrently in the long-running server while a CLI subcommand
// (`cli-member.ts` et al.) can write the SAME preferences.json from a SEPARATE `bun` process with
// its own, independent write chain. This spawns a REAL second OS process (see
// preferences.lock-test-child.ts) racing the SAME read-modify-write against the main test
// process, proving the O_EXCL lock file — not just the in-process chain — is what prevents a lost
// update across process boundaries.
//
// R5 (round-2 review): a `bun run <script>` child's own startup/import cost (~100ms+) dwarfs the
// sub-millisecond time a handful of sequential fs writes take, so without synchronization the
// MAIN process routinely finishes its entire loop before the child has even started — no overlap
// ever happens, and the test would stay green whether or not the lock exists. `waitForFile` below
// is a barrier: the child writes a ready-marker right after its own startup completes and right
// before its write loop starts; the parent waits for that marker before starting its own loop, so
// both loops actually run concurrently for their full duration instead of hoping for scheduling
// luck.
// ---------------------------------------------------------------------------

const childScriptPath = join(
  // `new URL(import.meta.url).pathname` yields a leading-slash path like `/C:/…` on Windows,
  // which breaks the spawned `bun run` — `fileURLToPath` handles the platform difference.
  dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'preferences.lock-test-child.ts',
)

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await Bun.file(path).exists())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path} to appear`)
    await new Promise(r => setTimeout(r, 5))
  }
}

/** Outcome of `raceTwoProcesses`. With the lock disabled, either side can encounter IO errors
 *  while another process replaces/quarantines a torn file, or continue from defaults and lose
 *  connections. Both the exception and the final entry count are evidence of missing
 *  synchronization, so failures from `updatePreferencesAt` are captured here rather than
 *  left to crash the test. */
interface RaceResult {
  ids: string[] | null
  /** The final file failed to parse, OR either process's write loop threw (almost always because
   *  it tried to read a torn file mid-race) OR the child exited non-zero. */
  corrupted: boolean
}

/** Spawns the child fixture, waits for both sides to be ready, then races `COUNT` sequential
 *  `updatePreferencesAt` appends from THIS process against `COUNT` from the child — the real
 *  production write path, from two real OS processes, synchronized to actually overlap.
 *  `disableLock` plumbs `__setTestOnlyDisableLock` through to BOTH sides (it's a per-process
 *  module-level flag, so the child needs its own `--disable-lock` flag; setting it only in the
 *  parent would leave the child still locking and prove nothing). */
async function raceTwoProcesses(opts: { primary: string; legacy: string; count: number; disableLock: boolean }): Promise<RaceResult> {
  const { primary, legacy, count } = opts
  const childReady = `${primary}.child-ready`
  const childArgs = [childScriptPath, primary, legacy, 'bbbb', String(count), childReady]
  if (opts.disableLock) childArgs.push('--disable-lock')
  const child = Bun.spawn(['bun', 'run', ...childArgs], { stdout: 'pipe', stderr: 'pipe' })

  if (opts.disableLock) __setTestOnlyDisableLock(true)
  let mainCorrupted = false
  try {
    await waitForFile(childReady, 10_000) // barrier: don't start until the child is about to loop

    const mainWrites = (async () => {
      for (let i = 0; i < count; i++) {
        await updatePreferencesAt(primary, legacy, (current) => ({
          scanRoots: [...(current.scanRoots ?? []), `aaaa${i.toString(16).padStart(8, '0')}`],
        }))
      }
    })().catch(() => { mainCorrupted = true }) // a torn read mid-race throws — that IS the finding

    const [exitCode] = await Promise.all([child.exited, mainWrites])
    if (exitCode !== 0) mainCorrupted = true // the child hit the same class of failure
  } finally {
    if (opts.disableLock) __setTestOnlyDisableLock(false) // never leak into a later test
  }

  let text: string
  try {
    text = await readFile(primary, 'utf-8')
    JSON.parse(text) // torn writes from two processes racing rename() fail to parse
  } catch {
    return { ids: null, corrupted: true }
  }
  if (mainCorrupted) return { ids: null, corrupted: true }
  const final = await readPreferencesFrom(primary, legacy)
  return { ids: final.scanRoots ?? [], corrupted: false }
}

test('two SEPARATE OS processes writing the same preferences file concurrently lose no updates', async () => {
  const { primary, legacy } = await tmpPaths2()
  // Seed the file so both writers start from a real, parseable base rather than racing the
  // very first mkdir/create.
  await writePreferencesTo(primary, legacy, { scanRoots: [] })

  const COUNT = 15
  const { ids, corrupted } = await raceTwoProcesses({ primary, legacy, count: COUNT, disableLock: false })

  expect(corrupted).toBe(false) // the file on disk is whole JSON, not a torn write, and neither side threw
  // Every single one of the 2×COUNT appends survived — no lost update across the process
  // boundary, which is exactly what a missing/ineffective cross-process lock would drop.
  expect(ids).toHaveLength(2 * COUNT)
  expect(new Set(ids).size).toBe(2 * COUNT) // no duplicate/corrupted id either
  const mainIds = ids!.filter(id => id.startsWith('aaaa'))
  const childIds = ids!.filter(id => id.startsWith('bbbb'))
  expect(mainIds).toHaveLength(COUNT)
  expect(childIds).toHaveLength(COUNT)
}, 20_000)

test('control: with the lock disabled via the test-only seam, the SAME synchronized race loses or corrupts data — proves the guard above is not vacuous on this hardware', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, { scanRoots: [] })

  // A much higher COUNT than the guard test above: each individual read-modify-write is a
  // handful of fast fs syscalls, so even with synchronized starts the contention window per
  // iteration is small — more iterations means more chances for the two processes' operations to
  // actually interleave mid-cycle instead of happening to serialize by accident.
  const COUNT = 200
  const { ids, corrupted } = await raceTwoProcesses({ primary, legacy, count: COUNT, disableLock: true })

  // With BOTH processes' lock acquisition short-circuited to a no-op (same synchronized-start
  // race as the guard test above — same COUNT, same barrier, same production `updatePreferencesAt`
  // call), the read-modify-write MUST tear or lose an update: either the file fails to parse or a
  // process throws reading a torn file mid-race (both captured as `corrupted`), or fewer than
  // 2×COUNT ids survive. If this assertion ever starts failing, it means EITHER the hardware
  // genuinely stopped reproducing the race (investigate before trusting the guard test's green as
  // meaningful) OR something reintroduced accidental serialization outside the lock.
  const lostOrTorn = corrupted || ids === null || ids.length < 2 * COUNT
  expect(lostOrTorn).toBe(true)
}, 20_000)

// The exact bug R1/R2 fixed: LOCK_ACQUIRE_TIMEOUT_MS being <= LOCK_STALE_MS makes the stale-reclaim
// path unreachable for ordinary contention (a waiter always gives up before a fresh-looking lock
// could ever be judged stale) — this is a standing regression guard against that specific
// inversion recurring, not just documentation of the current values.
test('LOCK_ACQUIRE_TIMEOUT_MS is strictly greater than LOCK_STALE_MS — the waiter always gets a turn at reclaiming a stale lock', () => {
  expect(LOCK_ACQUIRE_TIMEOUT_MS).toBeGreaterThan(LOCK_STALE_MS)
})

// ---------------------------------------------------------------------------
// R2-regression bound (round-3 review): the fix that let a known-free retry bypass the deadline
// check (so a stale reclaim landing right at the deadline isn't discarded, see R2 above) has to
// stay BOUNDED — a waiter that keeps landing on `staleReclaimed`/`lockVanished` on every single
// iteration must not spin past `LOCK_ACQUIRE_TIMEOUT_MS` forever. `__setTestOnlyForceLockVanished`
// makes every contention iteration report "known free" without touching the real lock file (which
// this test holds open and never releases, so `open('wx')` genuinely keeps failing EEXIST) —
// reproducing sustained "known-free-but-still-contended" pressure deterministically, instead of
// needing to win a real race against another process. `__setTestOnlyAcquireTimeoutMs` shortens the
// bound so this doesn't take the real ~70s.
// ---------------------------------------------------------------------------

test('a waiter that keeps seeing the lock as free-but-uncontested is still bounded — it throws PreferencesLockTimeoutError instead of spinning forever', async () => {
  const { primary, legacy } = await tmpPaths2()
  const lockPath = `${primary}.lock`

  // A REAL lock file, held forever (never released) — every `open(lockPath, 'wx')` inside
  // `acquireFileLock` genuinely fails EEXIST for the rest of this test.
  const handle = await open(lockPath, 'wx')
  await handle.writeFile('some-other-process-holds-this-forever', 'utf-8')
  await handle.close()

  __setTestOnlyAcquireTimeoutMs(300)
  __setTestOnlyForceLockVanished(true)
  try {
    const start = Date.now()
    await expect(writePreferencesTo(primary, legacy, { installDismissed: true }))
      .rejects.toBeInstanceOf(PreferencesLockTimeoutError)
    const elapsed = Date.now() - start
    // Bounded near the shortened 300ms deadline (plus at most one grace retry's worth of
    // overhead), not spinning for seconds — a regression here would mean the R2 fix's "retry
    // without waiting" path became unbounded again.
    expect(elapsed).toBeLessThan(2_000)
  } finally {
    __setTestOnlyForceLockVanished(false)
    __setTestOnlyAcquireTimeoutMs(null)
  }
}, 3_000) // explicit timeout: bun's internal 5s default marks a hang FAILED but doesn't cancel
// the still-spinning acquireFileLock promise, so `bun test` never exits on its own if this bound
// ever regresses — it has to be killed externally (as verified in round 4). A short explicit
// timeout, well above the shortened 300ms bound this test actually uses but well below the
// default, turns a future regression into a fast, legible red instead of a hung pipeline.

// ---------------------------------------------------------------------------
// Stale-lock reclaim (Task 5) — a process killed mid-write (SIGKILL, OOM, crash) leaves its
// `<primary>.lock` file behind forever; without a staleness bound every later write on this
// machine would fail/hang permanently, since nothing else ever deletes it. `acquireFileLock`
// treats a lock file older than `LOCK_STALE_MS` (60s — see the comment on the constant in
// preferences.ts) as abandoned and reclaims it. This test plants exactly that: a lock file with
// an mtime far in the past, held by no real process.
// ---------------------------------------------------------------------------

test('a stale lock file (planted, mtime far in the past) is reclaimed — a write succeeds instead of hanging', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, { scanRoots: [] })

  // Plant an abandoned lock file next to primary, backdated well past LOCK_STALE_MS (60s). Its
  // content deliberately does NOT match any real owner token — that's fine, `acquireFileLock`
  // only checks content on RELEASE (to avoid deleting someone else's lock), never as a condition
  // for reclaiming a stale one.
  const lockPath = `${primary}.lock`
  const handle = await open(lockPath, 'w')
  await handle.close()
  // Comfortably past LOCK_STALE_MS — 5x, not just barely over it, so the comparison can never
  // flake on the few ms this test itself takes to reach the stat() call, and never silently goes
  // stale itself if the threshold is retuned again later.
  const longAgo = new Date(Date.now() - 5 * LOCK_STALE_MS)
  await utimes(lockPath, longAgo, longAgo)

  const start = Date.now()
  await writePreferencesTo(primary, legacy, { scanRoots: ['/after-the-stale-lock'] })
  const elapsed = Date.now() - start

  // Reclaimed almost immediately — nowhere near LOCK_ACQUIRE_TIMEOUT_MS (70s), which is the
  // bound for a LIVE lock that never frees, not a stale one. A missing staleness check would
  // block here until that full timeout elapsed and then throw `PreferencesLockTimeoutError`.
  expect(elapsed).toBeLessThan(2_000)

  const after = await readPreferencesFrom(primary, legacy)
  expect(after.scanRoots).toContain('/after-the-stale-lock')
  // The reclaim left a fresh lock behind only transiently — writePreferencesTo released it.
  const stillLocked = await Bun.file(lockPath).exists()
  expect(stillLocked).toBe(false)
})

import {
  clampSessionPollMs, sessionPollMsOrDefault,
  SESSION_POLL_DEFAULT_MS, SESSION_POLL_MIN_MS, SESSION_POLL_MAX_MS,
} from './preferences'

test('sessionPollMsOrDefault falls back to the built-in default when unset', () => {
  expect(sessionPollMsOrDefault({})).toBe(SESSION_POLL_DEFAULT_MS)
})

test('sessionPollMsOrDefault clamps a stored value to the floor and ceiling', () => {
  expect(sessionPollMsOrDefault({ sessionPollMs: 1 })).toBe(SESSION_POLL_MIN_MS)
  expect(sessionPollMsOrDefault({ sessionPollMs: 1_000_000 })).toBe(SESSION_POLL_MAX_MS)
  expect(sessionPollMsOrDefault({ sessionPollMs: 2_000 })).toBe(2_000)
})

test('clampSessionPollMs falls back to the default for a non-finite value', () => {
  expect(clampSessionPollMs(NaN)).toBe(SESSION_POLL_DEFAULT_MS)
  expect(clampSessionPollMs(Infinity)).toBe(SESSION_POLL_DEFAULT_MS)
})

// THREE — the persisted search-scope preference the cockpit (j-20260826-fi) builds on.
// The scope SET rides `sessionView` and its whole-object write; this file owns where it lives,
// its default, and its validation. The renderer is the TUI's.
import { resolveSessionSearchScopes, DEFAULT_SESSION_SEARCH_SCOPES } from './preferences'

test('search scopes: never chosen reads as the default (all own fields, no transcript)', () => {
  expect(resolveSessionSearchScopes({})).toEqual([...DEFAULT_SESSION_SEARCH_SCOPES])
  expect(DEFAULT_SESSION_SEARCH_SCOPES).not.toContain('transcript')
  expect(DEFAULT_SESSION_SEARCH_SCOPES).toContain('name')
})

test('search scopes: a stored set is honoured, in canonical order and deduped', () => {
  const p = { sessionView: { grouping: 'none', showClosed: false, showExited: false, showUnfiled: false, searchScopes: ['prompt', 'name', 'prompt', 'transcript'] } } as never
  expect(resolveSessionSearchScopes(p)).toEqual(['name', 'prompt', 'transcript'])
})

test('search scopes: an empty stored array is a real (empty) choice, distinct from never-chosen', () => {
  const p = { sessionView: { grouping: 'none', showClosed: false, showExited: false, showUnfiled: false, searchScopes: [] } } as never
  expect(resolveSessionSearchScopes(p)).toEqual([])
})

test('search scopes: unknown values are dropped rather than crashing', () => {
  const p = { sessionView: { grouping: 'none', showClosed: false, showExited: false, showUnfiled: false, searchScopes: ['name', 'bogus', 'folder'] } } as never
  expect(resolveSessionSearchScopes(p)).toEqual(['name', 'folder'])
})

test('updatePreferencesAt: two concurrent updates to the same key both survive (neither writes a stale read)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-prefs-upd-'))
  const file = join(dir, 'preferences.json')
  const { updatePreferencesAt, writePreferencesTo, readPreferencesFrom } = await import('./preferences')
  await writePreferencesTo(file, null, { pinnedSessions: [] })
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      updatePreferencesAt(file, null, cur => ({ pinnedSessions: [...(cur.pinnedSessions ?? []), `k${i}`] }))),
  )
  const out = await readPreferencesFrom(file, null)
  expect([...(out.pinnedSessions ?? [])].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `k${i}`).sort())
})

test('updatePreferencesAt: returning undefined writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-prefs-upd-'))
  const file = join(dir, 'preferences.json')
  const { updatePreferencesAt } = await import('./preferences')
  await updatePreferencesAt(file, null, () => undefined)
  expect(await Bun.file(file).exists()).toBe(false)
})

test('a `team` block written by an older version is dropped on read and leaves with the next write', async () => {
  const { primary } = await tmpPaths2()
  await writeFile(primary, JSON.stringify({ theme: 'dark', team: { mode: 'member', token: 'old-bearer' } }))
  const read = await readPreferencesFrom(primary, null)
  expect((read as Record<string, unknown>).team).toBeUndefined()
  expect(read.theme).toBe('dark')
  await writePreferencesTo(primary, null, { lang: 'en' })
  const raw = await readFile(primary, 'utf8')
  expect(raw).not.toContain('old-bearer')
  expect(raw).not.toContain('"team"')
})
