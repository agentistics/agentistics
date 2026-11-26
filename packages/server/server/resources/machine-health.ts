/**
 * resources/machine-health.ts — PURE. Is this machine heading for the state that took the disk down?
 *
 * Spec: docs/superpowers/specs/2026-11-26-machine-health-guard.md §1 (slice G1: OBSERVE ONLY — nothing
 * here gates, notifies or kills; the governor records what it decides and `/api/hardware-resources`
 * shows it).
 *
 * WHY: on 2026-11-25 the WSL2 ext4 root went read-only after 867 `page allocation failure: order:7`
 * lines — a Hyper-V channel could not get a 512 KB physically contiguous block. The next morning
 * `/proc/buddyinfo` again showed ZERO free blocks of order >= 7 in DMA32 and Normal while
 * `MemAvailable` read 4,4 GB, i.e. every memory brake said "fine". So the primary signal is
 * fragmentation (S1), with memory, swap RATE, disk, inodes, PSI, writeback and the kernel's own
 * failure lines beside it.
 *
 * Shape: `evaluateHealth(sample, previous)` → the next state. The sample is RAW TEXT (the files as
 * read) plus `statfs` facts, so every parser here is a function of a fixture. An unreadable source is
 * `null` and its signal is `unavailable` — never `ok` (the N/A-versus-a-confident-0 rule).
 *
 * Hysteresis: every signal ENTERS at one value and LEAVES at a safer one, and both need a number of
 * consecutive ticks (one tick = `HEALTH_TICK_MS`, 10 s). A value hovering at a line is therefore one
 * transition, not a stream of them.
 */

import { parseMeminfo } from '../sessions/memory-budget'

export const HEALTH_TICK_MS = 10_000

export type Level = 'ok' | 'tight' | 'critical' | 'readonly'
/** The hysteresis levels a single signal can hold; `readonly` is decided by S9 alone. */
type SignalLevel = 'ok' | 'tight' | 'critical'

export type SignalId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5.memory' | 'S5.io' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10'
export const SIGNAL_IDS: readonly SignalId[] = ['S1', 'S2', 'S3', 'S4', 'S5.memory', 'S5.io', 'S6', 'S7', 'S8', 'S9', 'S10']

export type Unit = 'blocks' | 'bytes' | 'pages/s' | 'percent' | 'seconds' | 'flag'

export interface Bound { op: '<' | '<=' | '>' | '>='; value: number }

/** `statfs` of one path, in bytes / inode counts. `freeBytes` is what an unprivileged writer gets (`bavail`). */
export interface FsFacts { totalBytes: number; freeBytes: number; files: number; freeFiles: number }

/** Everything one tick read. Text is the file as read; `null` = could not be read here. */
export interface HealthSample {
  /** Wall clock — what is SHOWN (`since`, `sampledAtMs`, the sample log). Never used to measure a duration. */
  atMs: number
  /**
   * Monotonic clock (`performance.now()`) — what every duration is measured on: S2's 10 min window, S9's kernel
   * window and S4's swap windows. A WSL clock resync can leap the wall clock forward, which would age a fresh
   * failure past its window and release `critical` early.
   */
  monoMs: number
  platform: string
  /** Linux running under WSL (decides where S6 looks). */
  wsl: boolean
  buddyinfo: string | null
  meminfo: string | null
  vmstat: string | null
  /** `/proc/pressure/memory` and `/proc/pressure/io` — absent on kernels without CONFIG_PSI (this WSL). */
  psiMemory: string | null
  psiIo: string | null
  /** `dmesg` output (`[seconds.micro] text` lines). `null` when restricted or not runnable. */
  kernelLog: string | null
  mounts: string | null
  /** The agentistics data directory (S7 and S9 also look at the filesystem holding it). */
  dataDir: string
  rootFs: FsFacts | null
  dataFs: FsFacts | null
  /** S6: WSL → the Windows drive holding the `.vhdx` (`/mnt/<x>`); native → the data dir's filesystem. */
  hostDrive: { path: string; fs: FsFacts | null } | null
  /** Why `hostDrive` is null, in words (e.g. the BasePath lookup failed). */
  hostDriveWhy?: string
}

export interface HealthReason {
  signal: SignalId
  level: Exclude<Level, 'ok'>
  value: number
  unit: Unit
  /** The line this level was entered at. */
  enter: Bound
  /** The line the value must cross (for the dwell) to leave this level — still past `enter` or not. */
  exit: Bound | null
}

interface SignalMemory {
  level: SignalLevel
  /** Consecutive ticks the value satisfied the tight / critical ENTER bound. */
  tightStreak: number
  critStreak: number
  /** Consecutive ticks the value satisfied the current level's EXIT bound. */
  exitStreak: number
}

export interface HealthState {
  level: Level
  reasons: HealthReason[]
  unavailable: SignalId[]
  /** One sentence per unavailable signal. */
  unavailableWhy: Partial<Record<SignalId, string>>
  /** When this level was entered (ms). */
  since: number
  sampledAtMs: number
  /** `false` when no signal at all could be read (darwin, win32, a sandbox) — the level is then nominal. */
  measured: boolean
  /** The value each available signal read on this tick (S2 = seconds since a new failure line was first seen, `null` = none since the guard started). */
  values: Partial<Record<SignalId, number | null>>
  /** Hysteresis memory — internal, carried tick to tick. */
  memory: Partial<Record<SignalId, SignalMemory>>
  /** `pswpin` readings over the last ~130 s (monotonic time), for S4's windows. */
  swapHistory: Array<{ monoMs: number; pswpin: number }>
  /** The kernel-log cursor — see `KernelCursor`. Absent until the first readable kernel log. */
  kernel?: KernelCursor
}

/**
 * Which kernel lines have already been seen, and WHEN a new one was first observed.
 *
 * `dmesg`'s `[seconds]` stamp cannot be turned into an age: on WSL its clock runs AHEAD of `/proc/uptime`
 * (measured 2026-11-26: a line stamped 44495 s with uptime at 40643 s), so "uptime − stamp" calls an hour-old
 * failure brand new. The stamp is only used to ORDER lines within a boot: a matching line newer than the
 * cursor is a NEW event, dated by the MONOTONIC clock of the tick that first saw it (at most `KERNEL_LOG_EVERY_MS`
 * late). Lines already in the buffer when the guard starts are history and start no window — the cost is that
 * a failure in the seconds before a server restart is not counted; `failuresSeen` still says the boot had some.
 */
export interface KernelCursor {
  failTs: number | null
  failSeenMonoMs: number | null
  roTs: number | null
  roSeenMonoMs: number | null
  /** Matching allocation-failure lines in the current kernel buffer. */
  failuresInLog: number
}

export interface HealthStep { state: HealthState; transition: { from: Level; to: Level } | null }

const GiB = 1024 ** 3
const MiB = 1024 ** 2

// ---------------------------------------------------------------------------------------------------------------------
// Thresholds. Every number says where it came from (spec §1.2).

/** S1: free blocks of order >= 7 (512 KB contiguous) summed over DMA32 + Normal. The allocation that failed 867 times. */
export const S1_MIN_ORDER = 7
/** `tight` < 20: the leader's heavy-work brake since 26/11 ("order 7–10 >= 20"). `critical` = 0: measured on crash day and on 26/11 morning. Leaves at >= 40 for 6 ticks (60 s): compaction can recover in seconds, so entry needs 2 ticks and exit a full minute. */
export const S1 = { tight: 20, critical: 0, exit: 40, enterTicks: 2, exitTicks: 6 } as const
/** S2: a `page allocation failure: order:N` (N >= 4) line within the last 10 min. A failure that already happened outranks any prediction. */
export const S2 = { minOrder: 4, windowSec: 600 } as const
/** S3: `MemAvailable` — the leader's brakes since 25/11 (open >= 4 GB, pause < 2,5 GB). `HARD_FLOOR_BYTES` (2 GiB) stays the spawn floor beneath. */
export const S3 = { tight: 4 * GiB, critical: 2.5 * GiB, exitTight: 4.5 * GiB, exitCritical: 3 * GiB, exitTicks: 3 } as const
/** S4: swap-in RATE (Δpswpin), not swap used. First cut: this boot's 15 h average was ~350 pages/s. G1 LOGS it for a week before G2 acts on it. */
export const S4 = { tight: 1000, critical: 5000, exit: 300, enterWindowMs: 60_000, exitWindowMs: 120_000 } as const
/** S5: PSI where the kernel has it (this WSL has `CONFIG_PSI is not set` → unavailable). Leaves at half the entry, 120 s. */
export const S5 = { memSome: { tight: 20, critical: 50 }, ioFull: { tight: 10, critical: 30 }, exitTicks: 12 } as const
/** S6: the drive holding the `.vhdx` — owner's 50 GB (DONO D5 recommendation: 20 % / 8 % on drives under 256 GB). GiB, which is what Windows labels "GB". */
export const S6 = { tight: 50 * GiB, critical: 20 * GiB, exitTight: 60 * GiB, exitCritical: 25 * GiB, smallDrive: 256 * GiB, smallPct: { tight: 20, critical: 8, exitTight: 25, exitCritical: 10 }, exitTicks: 3 } as const
/** S7: the Linux root (and the data dir's filesystem): < 10 % or < 30 GB tight, < 5 % or < 10 GB critical, leave +5 points. */
export const S7 = { tightPct: 10, tightBytes: 30 * GiB, criticalPct: 5, criticalBytes: 10 * GiB, exitPoints: 5, exitTicks: 3 } as const
/** S8: free inodes of `/` — a worktree is ~68 000 entries, inodes run out before bytes on a fleet of them. */
export const S8 = { tight: 10, critical: 3, exitPoints: 5, exitTicks: 3 } as const
/** S10: `Dirty` + `Writeback` — a bulk delete or a big install shows here first. */
export const S10 = { tight: 1 * GiB, critical: 2 * GiB, exit: 512 * MiB, exitTicks: 3 } as const

// ---------------------------------------------------------------------------------------------------------------------
// Parsers — pure over the text.

/** Free blocks of order >= `minOrder` summed over the named zones of every node. `null` when no such zone line exists. */
export function contiguousFreeBlocks(buddyinfo: string, minOrder = S1_MIN_ORDER, zones: readonly string[] = ['DMA32', 'Normal']): number | null {
  let sum = 0
  let seen = false
  for (const line of buddyinfo.split('\n')) {
    const m = /^Node\s+\d+,\s+zone\s+(\S+)\s+(.*)$/.exec(line.trim())
    if (!m || !zones.includes(m[1]!)) continue
    const counts = m[2]!.trim().split(/\s+/).map(Number)
    if (counts.some(n => !Number.isFinite(n))) continue
    seen = true
    for (let order = minOrder; order < counts.length; order++) sum += counts[order]!
  }
  return seen ? sum : null
}

/** `Dirty` + `Writeback` in bytes, or `null` when either line is missing. */
export function dirtyWritebackBytes(meminfo: string): number | null {
  const kb = (key: string) => { const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(meminfo); return m ? Number(m[1]) * 1024 : null }
  const d = kb('Dirty'), w = kb('Writeback')
  return d === null || w === null ? null : d + w
}

/** One counter out of `/proc/vmstat`. */
export function vmstatCounter(vmstat: string, key: string): number | null {
  const m = new RegExp(`^${key}\\s+(\\d+)$`, 'm').exec(vmstat)
  return m ? Number(m[1]) : null
}

/** `avg60` of the `some` or `full` line of a `/proc/pressure/*` file. */
export function psiAvg60(text: string, kind: 'some' | 'full'): number | null {
  const m = new RegExp(`^${kind}\\s.*\\bavg60=([\\d.]+)`, 'm').exec(text)
  return m ? Number(m[1]) : null
}

/** The newest `dmesg` stamp (`[seconds]`) among lines matching `test`, and how many matched. Stamps ORDER lines; they are not an age (see `KernelCursor`). */
export function newestKernelLine(kernelLog: string, test: (line: string) => boolean): { ts: number | null; count: number } {
  let newest: number | null = null
  let count = 0
  for (const line of kernelLog.split('\n')) {
    const m = /^\[\s*(\d+(?:\.\d+)?)\]\s?(.*)$/.exec(line)
    if (!m || !test(m[2]!)) continue
    count += 1
    const t = Number(m[1])
    if (newest === null || t > newest) newest = t
  }
  return { ts: newest, count }
}

/** Advance the cursor with one kernel log read at monotonic `monoMs`. A stamp going BACKWARDS means a new boot/buffer: re-baseline. */
export function advanceKernelCursor(prev: KernelCursor | undefined, kernelLog: string, monoMs: number): KernelCursor {
  const fail = newestKernelLine(kernelLog, isAllocFailure)
  const ro = newestKernelLine(kernelLog, isReadonlyRemount)
  const bump = (prevTs: number | null | undefined, prevSeen: number | null | undefined, ts: number | null): { ts: number | null; seen: number | null } => {
    if (prev === undefined) return { ts, seen: null } // the baseline: what is already in the buffer is history
    if (ts === null) return { ts, seen: null } // nothing matching in the buffer any more
    if (prevTs === null || prevTs === undefined || ts > prevTs) return { ts, seen: monoMs } // a NEW line
    if (ts < prevTs) return { ts, seen: null } // stamps went backwards: another buffer — re-baseline
    return { ts, seen: prevSeen ?? null }
  }
  const f = bump(prev?.failTs, prev?.failSeenMonoMs, fail.ts)
  const r = bump(prev?.roTs, prev?.roSeenMonoMs, ro.ts)
  return { failTs: f.ts, failSeenMonoMs: f.seen, roTs: r.ts, roSeenMonoMs: r.seen, failuresInLog: fail.count }
}

export const isAllocFailure = (text: string): boolean => {
  const m = /page allocation failure: order:(\d+)/.exec(text)
  return m !== null && Number(m[1]) >= S2.minOrder
}
export const isReadonlyRemount = (text: string): boolean => /EXT4-fs error|Remounting filesystem read-only/.test(text)

export interface MountEntry { device: string; mountPoint: string; options: string[] }

/** `/proc/mounts` → entries; `\040`-style octal escapes in the mount point are decoded. */
export function parseMounts(text: string): MountEntry[] {
  const out: MountEntry[] = []
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue
    out.push({ device: f[0]!, mountPoint: f[1]!.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))), options: f[3]!.split(',') })
  }
  return out
}

/** The mount holding `path` (longest mount-point prefix; the LAST entry wins on a stacked mount point). */
export function mountOf(path: string, mounts: readonly MountEntry[]): MountEntry | null {
  let best: MountEntry | null = null
  for (const m of mounts) {
    const mp = m.mountPoint
    const covers = mp === '/' || path === mp || path.startsWith(mp.endsWith('/') ? mp : `${mp}/`)
    if (covers && (!best || mp.length >= best.mountPoint.length)) best = m
  }
  return best
}

// ---------------------------------------------------------------------------------------------------------------------
// The hysteresis step for one signal.

interface Rule {
  unit: Unit
  tight?: { enter: Bound; exit: Bound }
  critical?: { enter: Bound; exit: Bound }
  enterTicks: number
  exitTicks: number
}

const holds = (b: Bound, v: number): boolean =>
  b.op === '<' ? v < b.value : b.op === '<=' ? v <= b.value : b.op === '>' ? v > b.value : v >= b.value

const rank = (l: Level): number => (l === 'ok' ? 0 : l === 'tight' ? 1 : l === 'critical' ? 2 : 3)
const fresh = (): SignalMemory => ({ level: 'ok', tightStreak: 0, critStreak: 0, exitStreak: 0 })

/**
 * One tick of one signal. `enterV` decides entering, `exitV` leaving (they differ only for S4, whose exit is
 * measured over a longer window); a `null` value (S4 still warming up) moves nothing. `exitBlocked` holds the
 * level where the table adds a condition to the exit line (S2: "AND S1 not critical") — the dwell restarts.
 */
function stepSignal(rule: Rule, prev: SignalMemory, enterV: number | null, exitV: number | null, instant: boolean, exitBlocked = false): SignalMemory {
  const m = { ...prev }
  const need = instant ? 1 : rule.enterTicks
  const needExit = instant ? 1 : rule.exitTicks
  if (enterV !== null) {
    const crit = rule.critical ? holds(rule.critical.enter, enterV) : false
    const tight = crit || (rule.tight ? holds(rule.tight.enter, enterV) : false)
    m.critStreak = crit ? m.critStreak + 1 : 0
    m.tightStreak = tight ? m.tightStreak + 1 : 0
    const target: SignalLevel = rule.critical && m.critStreak >= need ? 'critical' : rule.tight && m.tightStreak >= need ? 'tight' : 'ok'
    if (rank(target) > rank(m.level)) return { ...m, level: target, exitStreak: 0 }
  }
  if (m.level === 'ok' || exitV === null) return m
  const band = m.level === 'critical' ? rule.critical : rule.tight
  if (!band || exitBlocked || !holds(band.exit, exitV)) return { ...m, exitStreak: 0 }
  m.exitStreak += 1
  if (m.exitStreak < needExit) return m
  // Leave to the highest level below whose own exit line the value has NOT crossed yet.
  const next: SignalLevel = m.level === 'critical' && rule.tight && !holds(rule.tight.exit, exitV) ? 'tight' : 'ok'
  return { ...m, level: next, exitStreak: 0 }
}

// ---------------------------------------------------------------------------------------------------------------------
// The rules, some of which depend on the sample (a percentage of a drive's size).

const below = (enter: number, exit: number, enterOp: Bound['op'] = '<'): { enter: Bound; exit: Bound } => ({ enter: { op: enterOp, value: enter }, exit: { op: '>=', value: exit } })
const above = (enter: number, exit: number, enterOp: Bound['op'] = '>'): { enter: Bound; exit: Bound } => ({ enter: { op: enterOp, value: enter }, exit: { op: '<', value: exit } })

export const RULES = {
  S1: { unit: 'blocks', tight: below(S1.tight, S1.exit), critical: below(S1.critical, S1.exit, '<='), enterTicks: S1.enterTicks, exitTicks: S1.exitTicks },
  S2: { unit: 'seconds', critical: below(S2.windowSec, S2.windowSec), enterTicks: 1, exitTicks: 1 },
  S3: { unit: 'bytes', tight: below(S3.tight, S3.exitTight), critical: below(S3.critical, S3.exitCritical), enterTicks: 1, exitTicks: S3.exitTicks },
  S4: { unit: 'pages/s', tight: above(S4.tight, S4.exit), critical: above(S4.critical, S4.exit), enterTicks: 1, exitTicks: 1 },
  // S5 enters AT the line: the table says "≥ 20 %" / "≥ 50 %" and "≥ 10 %" / "≥ 30 %".
  'S5.memory': { unit: 'percent', tight: above(S5.memSome.tight, S5.memSome.tight / 2, '>='), critical: above(S5.memSome.critical, S5.memSome.critical / 2, '>='), enterTicks: 1, exitTicks: S5.exitTicks },
  'S5.io': { unit: 'percent', tight: above(S5.ioFull.tight, S5.ioFull.tight / 2, '>='), critical: above(S5.ioFull.critical, S5.ioFull.critical / 2, '>='), enterTicks: 1, exitTicks: S5.exitTicks },
  S8: { unit: 'percent', tight: below(S8.tight, S8.tight + S8.exitPoints), critical: below(S8.critical, S8.critical + S8.exitPoints), enterTicks: 1, exitTicks: S8.exitTicks },
  S10: { unit: 'bytes', tight: above(S10.tight, S10.exit), critical: above(S10.critical, S10.exit), enterTicks: 1, exitTicks: S10.exitTicks },
} satisfies Partial<Record<SignalId, Rule>>

/** S6 depends on the drive's size: GB lines on a big drive, percentages under 256 GB (DONO D5 recommendation). */
export function hostDriveRule(totalBytes: number): Rule {
  if (totalBytes < S6.smallDrive) {
    const p = (pct: number) => (pct / 100) * totalBytes
    return { unit: 'bytes', tight: below(p(S6.smallPct.tight), p(S6.smallPct.exitTight)), critical: below(p(S6.smallPct.critical), p(S6.smallPct.exitCritical)), enterTicks: 1, exitTicks: S6.exitTicks }
  }
  return { unit: 'bytes', tight: below(S6.tight, S6.exitTight), critical: below(S6.critical, S6.exitCritical), enterTicks: 1, exitTicks: S6.exitTicks }
}

/** S7: "< X % or < Y GB" is one byte line, `max(X % · total, Y)`; leaving adds 5 points to the percentage. */
export function rootFsRule(totalBytes: number): Rule {
  const pct = (n: number) => (n / 100) * totalBytes
  return {
    unit: 'bytes',
    tight: below(Math.max(pct(S7.tightPct), S7.tightBytes), Math.max(pct(S7.tightPct + S7.exitPoints), S7.tightBytes)),
    critical: below(Math.max(pct(S7.criticalPct), S7.criticalBytes), Math.max(pct(S7.criticalPct + S7.exitPoints), S7.criticalBytes)),
    enterTicks: 1,
    exitTicks: S7.exitTicks,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// S4's windows.

const SWAP_KEEP_MS = S4.exitWindowMs + 2 * HEALTH_TICK_MS

/** Pages/s over the last `windowMs` (monotonic time), or `null` until the history spans most of the window. */
export function swapInRate(history: ReadonlyArray<{ monoMs: number; pswpin: number }>, windowMs: number): number | null {
  const last = history.at(-1)
  if (!last) return null
  const from = history.find(h => h.monoMs >= last.monoMs - windowMs - HEALTH_TICK_MS / 2)
  if (!from || last.monoMs - from.monoMs < windowMs - HEALTH_TICK_MS) return null
  return (last.pswpin - from.pswpin) / ((last.monoMs - from.monoMs) / 1000)
}

// ---------------------------------------------------------------------------------------------------------------------
// The evaluation.

export function emptyHealthState(atMs = 0): HealthState {
  return { level: 'ok', reasons: [], unavailable: [], unavailableWhy: {}, since: atMs, sampledAtMs: atMs, measured: false, values: {}, memory: {}, swapHistory: [] }
}

export interface EvaluateOptions {
  /**
   * A single on-demand sample with no history (a route asked and no tick had run): every entry/exit needs ONE tick.
   * The answer says so (`basis` on the API block); it is never fed back as a governor state.
   */
  instant?: boolean
}

/** The next state from one sample and the previous state. */
export function evaluateHealth(sample: HealthSample, prev: HealthState = emptyHealthState(sample.atMs), opts: EvaluateOptions = {}): HealthStep {
  const instant = opts.instant ?? false
  const memory: Partial<Record<SignalId, SignalMemory>> = {}
  const values: Partial<Record<SignalId, number | null>> = {}
  const reasons: HealthReason[] = []
  const unavailableWhy: Partial<Record<SignalId, string>> = {}
  const off = (id: SignalId, why: string) => { unavailableWhy[id] = why }

  const run = (id: SignalId, rule: Rule, enterV: number | null, exitV: number | null = enterV, shown: number | null = enterV, exitBlocked = false) => {
    const m = stepSignal(rule, prev.memory[id] ?? fresh(), enterV, exitV, instant, exitBlocked)
    memory[id] = m
    values[id] = shown === Infinity ? null : shown
    if (m.level === 'ok') return
    const band = m.level === 'critical' ? rule.critical! : rule.tight!
    reasons.push({ signal: id, level: m.level, value: shown ?? exitV ?? NaN, unit: rule.unit, enter: band.enter, exit: band.exit })
  }

  const linux = sample.platform === 'linux'
  const notHere = `not measured on ${sample.platform}: this guard reads Linux/WSL kernel sources only`

  // S1
  const s1 = sample.buddyinfo === null ? null : contiguousFreeBlocks(sample.buddyinfo)
  if (s1 === null) off('S1', linux ? '/proc/buddyinfo could not be read or has no DMA32/Normal zone' : notHere)
  else run('S1', RULES.S1, s1)

  // S2 — seconds (monotonic) since a NEW allocation-failure line was first seen (see `KernelCursor`). It leaves only
  // after 10 min with no new line AND S1 not critical (S1 was evaluated just above, on this same tick).
  const kernel = sample.kernelLog === null ? prev.kernel : advanceKernelCursor(prev.kernel, sample.kernelLog, sample.monoMs)
  const sinceSeen = (seen: number | null | undefined) => (seen === null || seen === undefined ? Infinity : Math.max(0, (sample.monoMs - seen) / 1000))
  if (sample.kernelLog === null) off('S2', linux ? 'the kernel log could not be read (dmesg missing, restricted by kernel.dmesg_restrict, or timed out)' : notHere)
  else run('S2', RULES.S2, sinceSeen(kernel?.failSeenMonoMs), undefined, undefined, memory.S1?.level === 'critical')

  // S3 + S10
  const mem = sample.meminfo === null ? null : parseMeminfo(sample.meminfo)
  if (!mem) off('S3', linux ? '/proc/meminfo could not be read' : notHere)
  else run('S3', RULES.S3, mem.available)
  const dirty = sample.meminfo === null ? null : dirtyWritebackBytes(sample.meminfo)
  if (dirty === null) off('S10', linux ? '/proc/meminfo has no Dirty/Writeback lines' : notHere)
  else run('S10', RULES.S10, dirty)

  // S4
  let swapHistory = prev.swapHistory
  const pswpin = sample.vmstat === null ? null : vmstatCounter(sample.vmstat, 'pswpin')
  if (pswpin === null) { off('S4', linux ? '/proc/vmstat has no pswpin counter' : notHere); swapHistory = [] }
  else {
    const last = swapHistory.at(-1)
    swapHistory = last && (pswpin < last.pswpin || sample.monoMs <= last.monoMs) ? [] : [...swapHistory]
    swapHistory.push({ monoMs: sample.monoMs, pswpin })
    swapHistory = swapHistory.filter(h => h.monoMs >= sample.monoMs - SWAP_KEEP_MS)
    const enterRate = swapInRate(swapHistory, S4.enterWindowMs)
    run('S4', RULES.S4, enterRate, swapInRate(swapHistory, S4.exitWindowMs), enterRate)
  }

  // S5
  const psiMem = sample.psiMemory === null ? null : psiAvg60(sample.psiMemory, 'some')
  if (psiMem === null) off('S5.memory', linux ? 'this kernel has no PSI (/proc/pressure/memory absent — CONFIG_PSI not set)' : notHere)
  else run('S5.memory', RULES['S5.memory'], psiMem)
  const psiIo = sample.psiIo === null ? null : psiAvg60(sample.psiIo, 'full')
  if (psiIo === null) off('S5.io', linux ? 'this kernel has no PSI (/proc/pressure/io absent — CONFIG_PSI not set)' : notHere)
  else run('S5.io', RULES['S5.io'], psiIo)

  // S6
  const host = sample.hostDrive?.fs ?? null
  if (!host || host.totalBytes <= 0) off('S6', linux ? (sample.hostDriveWhy ?? `the drive holding the disk image could not be read${sample.hostDrive ? ` (${sample.hostDrive.path})` : ''}`) : notHere)
  else run('S6', hostDriveRule(host.totalBytes), host.freeBytes)

  // S7 — the root and the data dir's filesystem; the one with the smaller free fraction speaks.
  const fsList = [sample.rootFs, sample.dataFs].filter((f): f is FsFacts => f !== null && f.totalBytes > 0)
  const worst = fsList.sort((a, b) => a.freeBytes / a.totalBytes - b.freeBytes / b.totalBytes)[0]
  if (!worst) off('S7', linux ? 'statfs of / and of the data directory failed' : notHere)
  else run('S7', rootFsRule(worst.totalBytes), worst.freeBytes)

  // S8
  const root = sample.rootFs
  if (!root || root.files <= 0) off('S8', linux ? 'statfs of / reports no inode counts (this filesystem does not have a fixed inode table)' : notHere)
  else run('S8', RULES.S8, (root.freeFiles / root.files) * 100)

  // S9 — read-only: the mount flags say so, or the kernel said it remounted within the window.
  let readonly = false
  if (sample.mounts === null && sample.kernelLog === null) off('S9', linux ? '/proc/mounts and the kernel log could not be read' : notHere)
  else {
    if (sample.mounts !== null) {
      const mounts = parseMounts(sample.mounts)
      readonly = [mountOf('/', mounts), mountOf(sample.dataDir, mounts)].some(m => m?.options.includes('ro') ?? false)
    }
    if (!readonly && sample.kernelLog !== null) readonly = sinceSeen(kernel?.roSeenMonoMs) < S2.windowSec
    values.S9 = readonly ? 1 : 0
  }

  const unavailable = SIGNAL_IDS.filter(id => unavailableWhy[id] !== undefined)
  const measured = unavailable.length < SIGNAL_IDS.length
  if (readonly) reasons.unshift({ signal: 'S9', level: 'readonly', value: 1, unit: 'flag', enter: { op: '>=', value: 1 }, exit: null })
  const level: Level = readonly ? 'readonly' : reasons.reduce<Level>((w, r) => (rank(r.level) > rank(w) ? r.level : w), 'ok')
  reasons.sort((a, b) => rank(b.level) - rank(a.level))
  const changed = level !== prev.level
  const state: HealthState = {
    level,
    reasons,
    unavailable,
    unavailableWhy,
    since: changed ? sample.atMs : prev.since,
    sampledAtMs: sample.atMs,
    measured,
    values,
    memory,
    swapHistory,
    ...(kernel ? { kernel } : {}),
  }
  return { state, transition: changed ? { from: prev.level, to: level } : null }
}

/** What `/api/hardware-resources` carries: the state without its internal memory. */
export interface HealthBlock {
  level: Level
  reasons: HealthReason[]
  unavailable: SignalId[]
  unavailableWhy: Partial<Record<SignalId, string>>
  since: number
  sampledAtMs: number
  measured: boolean
  values: Partial<Record<SignalId, number | null>>
  /** `governor` = the server's 10 s tick (hysteresis applied); `single-sample` = read on request, no history. */
  basis: 'governor' | 'single-sample'
  /** How old this answer is (monotonic ms since its sample was read) — a cached single sample is served with its age. */
  ageMs: number
  /** Allocation-failure lines (order >= 4) in the kernel buffer right now — S2 counts only NEW ones; this says the boot had some. `null` = log unreadable. */
  kernelFailuresInLog: number | null
  /** G1 observes only: nothing is refused or paused because of this block yet. */
  enforced: false
}

export function healthBlock(s: HealthState, basis: HealthBlock['basis'], ageMs: number): HealthBlock {
  return { level: s.level, reasons: s.reasons, unavailable: s.unavailable, unavailableWhy: s.unavailableWhy, since: s.since, sampledAtMs: s.sampledAtMs, measured: s.measured, values: s.values, basis, ageMs: Math.max(0, ageMs), kernelFailuresInLog: s.kernel?.failuresInLog ?? null, enforced: false }
}

// ---------------------------------------------------------------------------------------------------------------------
// The sample log (~/.agentistics/health/samples.jsonl): one line per minute, carrying the WORST value each signal
// read during that minute (min where low is bad, max where high is bad), plus a line at every level transition.
// A week of it is what G2 tunes S4 (and any threshold that cries wolf) against.

const LOW_IS_BAD: ReadonlySet<SignalId> = new Set(['S1', 'S2', 'S3', 'S6', 'S7', 'S8'])

export interface SampleLine {
  t: number
  level: Level
  /** Worst value per signal over the minute; `null` = unavailable (or, for S2, no new failure line since the guard started). */
  v: Partial<Record<SignalId, number | null>>
  /** The signals past their line at the end of the minute. */
  r: SignalId[]
  /** Present on a transition line. */
  from?: Level
}

/** Fold one tick's values into the minute's worst. */
export function foldWorst(acc: Partial<Record<SignalId, number | null>>, values: Partial<Record<SignalId, number | null>>): Partial<Record<SignalId, number | null>> {
  const out = { ...acc }
  for (const id of SIGNAL_IDS) {
    if (!(id in values)) continue
    const v = values[id] ?? null
    const a = out[id]
    if (a === undefined || a === null) { out[id] = v; continue }
    if (v === null) continue
    out[id] = LOW_IS_BAD.has(id) ? Math.min(a, v) : Math.max(a, v)
  }
  return out
}

export const SAMPLE_EVERY_MS = 60_000
export const SAMPLE_RETENTION_DAYS = 7

/** `YYYY-MM-DD` (UTC) of a timestamp — the day a sample line belongs to. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/**
 * Which file a day's lines live in once the day is over. Seven fixed slots by UTC weekday, so the log
 * rotates by OVERWRITING the slot a week later — no deletion is ever needed and the directory never holds
 * more than eight files. A reader filters by `t` (a slot can be older than a week when the machine was off).
 */
export const rotatedSampleName = (day: string): string => `samples.${new Date(`${day}T00:00:00Z`).getUTCDay()}.jsonl`
export const CURRENT_SAMPLE_NAME = 'samples.jsonl'

/** The day of the first parseable line of a samples file, or `null`. */
export function sampleFileDay(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const t = (JSON.parse(line) as { t?: unknown }).t
      if (typeof t === 'number') return utcDay(t)
    } catch { /* a torn line — try the next */ }
  }
  return null
}
