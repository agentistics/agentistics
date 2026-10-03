import { open, readFile, unlink, stat } from 'fs/promises'
import { readFileSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { mkdir } from 'fs/promises'

/**
 * One server per machine, decided BEFORE any work is spent.
 *
 * Four server processes were once found running side by side on one laptop, each independently
 * walking every repository — the same work, four times, for one dashboard. They were not
 * malicious or exotic: a `dev:api` left running in a worktree, an autostart service, and two
 * copies launched in the SAME SECOND by a supervisor that did not check.
 *
 * The port bind cannot be what prevents this. It happens ~2200 lines into `index.ts`, long after
 * the file watcher and the first data build have started, so a duplicate has already spent minutes
 * of CPU and hundreds of megabytes before it ever learns the address is taken. And two processes
 * starting together both pass a "is the port free?" probe, which is exactly what happened.
 *
 * So the claim is made with `O_EXCL`, which is atomic: of two processes racing to create the same
 * file, the kernel lets exactly one win. The loser exits immediately, having spent nothing.
 */
export interface InstanceLock {
  /** Release the claim. Safe to call twice, and safe when the file is already gone. */
  release(): Promise<void>
  /**
   * The same release, finished before it returns — for a signal or `exit` handler.
   *
   * Those handlers call `process.exit` on the next line, and an async release never got past its
   * first `await`: every clean stop left the lock on disk, so the NEXT start's correctness rested
   * entirely on the stale-lock check below. That check is only as good as a pid is an identity,
   * which after a reboot or a container restart it is not.
   */
  releaseSync(): void
}

export interface LockHeld {
  ok: false
  /** PID of the process that holds it, when it could be read. */
  holder?: number
}

export type LockResult = ({ ok: true } & InstanceLock) | LockHeld

/** How long a lock whose contents cannot be read is still believed.
 *
 *  Creating the file and writing the pid into it are two operations, so there is a moment where a
 *  winner's lock is EMPTY. A reader arriving in that moment must not conclude "unreadable, so
 *  stale" and delete the claim out from under it — that turns the guard into the very race it
 *  exists to prevent. An empty lock is therefore obeyed while it is fresh, and only treated as
 *  debris once it is older than any plausible gap between those two operations. */
const UNREADABLE_GRACE_MS = 5_000

/** Is this PID a live process? `kill(pid, 0)` signals nothing and only tests reachability. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to someone else — alive for our purposes.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * When a process started, as epoch ms, or `undefined` when the OS will not say.
 *
 * Linux only: `/proc/<pid>/stat` field 22 is the start time in clock ticks since boot, and
 * `/proc/uptime` is seconds since boot — both on the kernel's boot clock, so their difference is the
 * process's age with no dependence on the wall clock having been right at boot (WSL's is routinely
 * wrong after the host sleeps). Anchored to `Date.now()`, which is the clock the lock's mtime was
 * written with. USER_HZ is 100 on every Linux ABI Bun runs on. Anywhere else — macOS, a /proc that
 * cannot be read — the answer is `undefined`, and the caller keeps the old, pid-only reading.
 */
export function linuxProcessStartMs(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    // `comm` (field 2) is parenthesised and may itself contain spaces or parens, so the fields are
    // counted from the LAST `)`: what follows it starts at field 3, which puts field 22 at index 19.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTicks = Number(fields[19])
    const uptimeSec = Number(readFileSync('/proc/uptime', 'utf-8').split(' ')[0])
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSec)) return undefined
    const ageMs = uptimeSec * 1000 - (startTicks / 100) * 1000
    return Date.now() - ageMs
  } catch {
    return undefined
  }
}

/** How much later than the lock a holder may appear to have started and still be believed.
 *
 *  The two instants come from different clocks (a file mtime, and an age derived from ticks), so
 *  they are compared with slack. It is biased toward BELIEVING the holder: the only case it could
 *  misjudge is a pid reused within this window of its previous owner writing the lock and dying,
 *  and then the answer is the old one — refuse — which is no worse than before. */
const START_SKEW_MS = 2_000

/** Seams for the facts this module reads off the OS, so the decision can be tested exactly. */
export interface LockProbe {
  processStartMs(pid: number): number | undefined
  /**
   * The process's start in BOOT-CLOCK ticks (`/proc/<pid>/stat` field 22), or `undefined` off
   * Linux. Recorded in the lock by the writer and compared ticks-to-ticks — exact, and immune to the
   * wall-clock steps WSL makes (2026-10-03: a live holder read as recycled, 153 s "too young").
   */
  processStartTicks?(pid: number): number | undefined
}

/** `/proc/<pid>/stat` field 22 — never rewritten by a wall-clock step. */
export function linuxProcessStartTicks(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
    return Number.isFinite(ticks) ? ticks : undefined
  } catch {
    return undefined
  }
}

const OS_PROBE: LockProbe = { processStartMs: linuxProcessStartMs, processStartTicks: linuxProcessStartTicks }

/** A lock's contents: `<pid>` (older writers) or `<pid> <startTicks>`. */
function parseLock(raw: string): { pid?: number; ticks?: number } {
  const [a, b] = raw.trim().split(/\s+/)
  const pid = parseInt(a ?? '', 10)
  const ticks = b === undefined ? NaN : Number(b)
  return {
    ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    ...(Number.isFinite(ticks) ? { ticks } : {}),
  }
}

/**
 * Is the process holding this pid the one that WROTE the lock?
 *
 * `kill(pid, 0)` alone answers "is some process using this number", and after a reboot, a
 * `wsl --shutdown` or a container restart that is routinely yes for a process that never saw this
 * file — measured: a systemd unit that refused to start for seven hours after a boot, because the
 * lock named pid 2826 and pid 2826 was by then something else. In a container it is certain: the
 * server is PID 1 in a fresh namespace every time, the lock sits on a persistent volume, and the
 * new PID 1 found its OWN number in the file and refused itself on every restart, forever.
 *
 * The writer was alive at the moment it wrote the lock, so no OTHER process holding that pid can
 * have started before the write — pids are not reused while their owner lives. A holder that
 * started after the lock's mtime therefore cannot be the writer, whoever it is — including us.
 */
async function holdsLock(file: string, holder: number, probe: LockProbe, recordedTicks?: number): Promise<boolean> {
  if (!isAlive(holder)) return false
  // EXACT when the writer recorded its start ticks: same pid AND same boot-clock start is the same
  // process, and nothing else is. The mtime comparison below is only for locks written without them.
  if (recordedTicks !== undefined) {
    const now = probe.processStartTicks?.(holder)
    if (now !== undefined) return now === recordedTicks
  }
  const started = probe.processStartMs(holder)
  if (started === undefined) return true // cannot tell — keep the pid-only answer
  let writtenMs: number
  try {
    writtenMs = (await stat(file)).mtimeMs
  } catch {
    return false // gone since we read it — nobody holds it
  }
  return started <= writtenMs + START_SKEW_MS
}

/** Was this file written recently enough that an unreadable one deserves the benefit of doubt? */
async function isFresh(file: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(file)).mtimeMs < UNREADABLE_GRACE_MS
  } catch {
    // Gone between the failed create and now — nobody holds it.
    return false
  }
}

/**
 * Claim the lock at `file`, or report who holds it.
 *
 * A STALE lock — one naming a pid that is gone, which is what a crash or a `kill -9` leaves
 * behind — is removed and re-claimed, because refusing to start after a crash would be a worse
 * failure than the one this prevents. The re-claim goes through the same `O_EXCL` create, so two
 * processes finding the same stale lock still produce exactly one winner.
 */
export async function claimInstanceLock(
  file: string,
  pid: number = process.pid,
  probe: LockProbe = OS_PROBE,
): Promise<LockResult> {
  await mkdir(dirname(file), { recursive: true }).catch(() => {})

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' — create, and FAIL if it exists. The atomicity this whole module rests on.
      const handle = await open(file, 'wx')
      try {
        const ticks = probe.processStartTicks?.(pid)
        await handle.writeFile(ticks === undefined ? String(pid) : `${pid} ${ticks}`)
      } finally {
        await handle.close()
      }
      return {
        ok: true,
        async release() {
          // Only remove a lock that is still OURS: on a slow shutdown the pid may already have
          // been re-claimed by the next server, and deleting it would let a third one in.
          try {
            const held = parseInt((await readFile(file, 'utf-8')).trim(), 10)
            if (held === pid) await unlink(file)
          } catch { /* already gone, or unreadable — nothing to release */ }
        },
        releaseSync() {
          try {
            const held = parseInt(readFileSync(file, 'utf-8').trim(), 10)
            if (held === pid) unlinkSync(file)
          } catch { /* already gone, or unreadable — nothing to release */ }
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // The lock cannot be created at all (read-only home, no permission). Refusing to start
        // over that would be worse than the duplicate it guards against — degrade to allowed.
        return { ok: true, async release() { /* nothing was claimed */ }, releaseSync() { /* nothing was claimed */ } }
      }
      let holder: number | undefined
      let ticks: number | undefined
      try {
        const parsed = parseLock(await readFile(file, 'utf-8'))
        holder = parsed.pid
        ticks = parsed.ticks
      } catch { /* unreadable — handled with the same grace as an empty file */ }

      if (holder !== undefined) {
        if (await holdsLock(file, holder, probe, ticks)) return { ok: false, holder }
      } else if (await isFresh(file)) {
        // Empty or unparseable, but new: almost certainly a winner mid-write. Yield to it.
        return { ok: false }
      }

      // Stale (or unreadable): drop it and go round once more. Bounded at one retry so a lock
      // being recreated as fast as we delete it ends as "held" rather than as a spin.
      await unlink(file).catch(() => {})
    }
  }
  return { ok: false }
}

/**
 * Who holds the lock at `file`, WITHOUT claiming or cleaning anything — `null` when nobody live
 * does (no file, an unreadable one, or a dead / recycled writer).
 *
 * `claimInstanceLock` is called from `index.ts`, after the vault, the watcher daemon and every
 * import of the app have already run. A duplicate start therefore paid seconds of CPU to learn it
 * was a duplicate, and a service manager restarting it every five seconds paid that over and over
 * — 190 times in one incident (docs/incidents/2026-10-03-restart-loop.md). `agentop server` asks
 * this first and exits with `EXIT_INSTANCE_HELD` before loading anything. The claim stays the
 * authority: a probe that says "free" can still lose the race, and then the claim refuses.
 */
export async function probeInstanceLock(file: string, probe: LockProbe = OS_PROBE): Promise<number | null> {
  let raw: string
  try {
    raw = (await readFile(file, 'utf-8')).trim()
  } catch {
    return null
  }
  const { pid: holder, ticks } = parseLock(raw)
  if (holder === undefined) return null
  return (await holdsLock(file, holder, probe, ticks)) ? holder : null
}
