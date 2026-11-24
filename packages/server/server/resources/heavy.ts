/**
 * resources/heavy.ts — PURE. The machine-wide HEAVY-JOB slot.
 *
 * ## Why (RES.1 addendum 2, 2026-10-03)
 *
 * The real memory peaks on this machine are not the assistant sessions (~300-450 MB each) but the
 * heavy jobs those sessions run AT THE SAME TIME: two full `tsc -b` at 1.7 GB each took the machine to
 * 1.4 GB available + 6 GB swap. The stopgap was a manual `flock /tmp/agentistics-heavy.lock <cmd>`;
 * agentop now owns that slot (`agentop heavy -- <cmd>`), shows the queue, and sizes the number of
 * slots from `MemAvailable` — and the admission gate reserves room for one.
 *
 * Slot 0 IS `/tmp/agentistics-heavy.lock`, so a session still using the manual `flock` and a job
 * under `agentop heavy` exclude each other exactly as before. Extra slots exist only while the
 * machine has room for another heavy job beside the ones running.
 */

const GB = 1024 * 1024 * 1024

/** What one heavy job is taken to cost. Measured: a full `tsc -b` of this repo peaks at 1.7 GB. */
export const HEAVY_JOB_BYTES = 1.8 * GB

/** Never hand a heavy slot out of the last of this — the desktop and the sessions need it. */
export const HEAVY_FLOOR_BYTES = 2 * GB

/** More slots than this is never useful on a laptop, whatever the arithmetic says. */
export const MAX_HEAVY_SLOTS = 4

/** Slot 0 is the lock sessions already use by hand; the rest are numbered beside it. */
export function heavyLockPath(slot: number, dir = '/tmp'): string {
  return slot === 0 ? `${dir}/agentistics-heavy.lock` : `${dir}/agentistics-heavy.${slot}.lock`
}

/**
 * How many heavy jobs may run at once right now — PURE.
 *
 * `availableBytes` is `MemAvailable`; `runningBytes` is what the heavy jobs already running hold
 * (they are part of the envelope — counting only what is free would shrink the slot count the
 * moment a job started, and a running job would lock out its own slot). Always at least 1: one heavy
 * job must always be able to run, or the queue never drains.
 */
export function heavySlots(availableBytes: number, runningBytes = 0): number {
  const room = availableBytes + runningBytes - HEAVY_FLOOR_BYTES
  return Math.max(1, Math.min(MAX_HEAVY_SLOTS, Math.floor(room / HEAVY_JOB_BYTES)))
}

/**
 * What the ADMISSION gate keeps back for heavy work — PURE. Room for one heavy job, minus what the
 * running ones already hold (that is already out of `MemAvailable`). With no running jobs, reserve
 * zero; a new lock holder with no measurable RSS keeps the full reservation.
 */
export function heavyReserveBytes(runningBytes: number, runningJobs = 1): number {
  if (runningJobs === 0) return 0
  return Math.max(0, HEAVY_JOB_BYTES - Math.max(0, runningBytes))
}

export interface HeavyWaiter {
  pid: number; sinceMs: number; command: string
  /** Started with bare flock rather than through the agentop queue. */
  manual?: boolean
  /** Blocking flock child, kept with its queued parent until the kernel grants the lock. */
  flockPid?: number
}

export interface HeavyRunning extends HeavyWaiter {
  slot: number
  usedBytes: number | null
}

/** Associate a queued parent's blocking flock child with its actual kernel state. */
export function mergeHeavyJobs(ours: readonly HeavyRunning[], queued: readonly HeavyWaiter[], manual: {
  running: readonly HeavyRunning[]; waiting: readonly HeavyWaiter[]
}): { running: HeavyRunning[]; waiting: HeavyWaiter[] } {
  const ourPids = new Set(ours.map(r => r.pid))
  const running = [...ours, ...manual.running.filter(r => !ourPids.has(r.pid)).map(r => {
    const parent = queued.find(w => w.flockPid === r.pid)
    return parent ? { ...r, command: parent.command, sinceMs: parent.sinceMs, manual: false } : r
  })]
  const waiting = [
    ...queued.filter(w => !running.some(r => r.pid === w.flockPid)),
    ...manual.waiting.filter(w => !queued.some(q => q.flockPid === w.pid)),
  ].filter((w, i, all) => all.findIndex(x => x.pid === w.pid) === i)
    .sort((a, b) => a.sinceMs - b.sinceMs || a.pid - b.pid)
  return { running, waiting }
}

/** Position of `pid` in the queue (1-based) among waiters still alive — PURE. 0 = not queued. */
export function queuePosition(waiters: HeavyWaiter[], pid: number, alive: (pid: number) => boolean): { position: number; of: number } {
  const live = waiters.filter(w => !w.manual && alive(w.pid)).sort((a, b) => a.sinceMs - b.sinceMs || a.pid - b.pid)
  const i = live.findIndex(w => w.pid === pid)
  return { position: i + 1, of: live.length }
}

/** The exit code `flock -n -E <code>` returns when the slot is busy. Chosen high and unusual. */
export const FLOCK_BUSY_CODE = 254

/** The actual flock argv used by runHeavy, shared by quick probes and the blocking head. */
export function heavyFlockArgs(attempt: { slot: number; blocking: boolean }, cmd: string[], lockDir = '/tmp'): string[] {
  return [...(attempt.blocking ? [] : ['-n', '-E', String(FLOCK_BUSY_CODE)]), heavyLockPath(attempt.slot, lockDir), ...cmd]
}

/** Only the agentop head joins the kernel waiters after a quick pass over the allowed slots. */
export function heavyAttempts(position: number, slots: number): { slot: number; blocking: boolean }[] {
  if (position !== 1) return []
  return [...Array.from({ length: slots }, (_, slot) => ({ slot, blocking: false })), { slot: 0, blocking: true }]
}

/** Queue text includes bare flock holders and waiters, without counting them in agentop order. */
export function heavyWaitLine(state: {
  slots: number; availableBytes: number | null
  running: readonly { command: string; manual?: boolean }[]
  waiting: readonly { manual?: boolean }[]
}, position: number, of: number): string {
  const avail = state.availableBytes === null ? '?' : `${(state.availableBytes / GB).toFixed(1)} GB`
  const holder = state.running[0]
  const manual = state.waiting.filter(w => w.manual).length
  return `agentop heavy: waiting — position ${Math.max(1, position)} of ${Math.max(1, of)}, `
    + `${state.running.length} running in ${state.slots} slot(s), ${avail} available`
    + (holder ? ` (${holder.manual ? 'manual running' : 'running'}: ${holder.command.slice(0, 60)})` : '')
    + (manual ? `, ${manual} manual waiter(s)` : '')
}

/**
 * Holders of an flock(2) lock on `inode`, out of `/proc/locks` — PURE. A line reads
 * `12: FLOCK  ADVISORY  WRITE 4074682 08:20:471070 0 EOF`; blocked waiters carry a `->` prefix and
 * are NOT holders.
 */
export function flockHolders(procLocks: string, inode: number): number[] {
  const out: number[] = []
  for (const line of procLocks.split('\n')) {
    if (line.includes('->')) continue
    const m = /\bFLOCK\s+\S+\s+\S+\s+(-?\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\b/.exec(line)
    if (m && Number(m[2]) === inode) out.push(Number(m[1]))
  }
  return out
}

/**
 * The lock path a `flock` argv names, and the command it runs — PURE. `flock [opts] <file> <cmd…>`;
 * options are the `-x`/`-n`/`-E 254`/`-w 5` family, the ones taking a value are skipped with it.
 */
export function parseFlockArgv(argv: string[]): { lock: string; command: string } | null {
  let i = 1
  while (i < argv.length && argv[i]!.startsWith('-')) {
    const a = argv[i]!
    i += ['-E', '-w', '-c', '--conflict-exit-code', '--timeout', '--wait', '--command'].includes(a) ? 2 : 1
  }
  const lock = argv[i]
  if (!lock) return null
  return { lock, command: argv.slice(i + 1).join(' ').split('\n')[0]!.slice(0, 200) }
}

/** All processes below lock holders, including children started by another thread; each pid once. */
export function heavyTreePids(roots: readonly number[], table: readonly { pid: number; ppid: number }[]): number[] {
  const children = new Map<number, number[]>()
  for (const row of table) {
    const list = children.get(row.ppid) ?? []
    list.push(row.pid)
    children.set(row.ppid, list)
  }
  const seen = new Set<number>()
  const pending = [...roots]
  for (let i = 0; i < pending.length; i++) {
    const pid = pending[i]!
    if (seen.has(pid)) continue
    seen.add(pid)
    pending.push(...(children.get(pid) ?? []))
  }
  return [...seen]
}
