/**
 * run-scope-stats.ts — what an `agentop run` cost, said in one line when it ends.
 *
 * RUN.LENTIDAO-SUITE (2026-11-23): the full suite took 5538 s inside one run (69 timeouts) and ~1400 s
 * in another, and nothing on screen could say why. Measured afterwards, no isolation layer explained
 * it (the netns, the read-only binds, the tmpfs masks and the 2G cap each cost ~0 on the same files),
 * but systemd's journal showed the slow scope had CONSUMED 2h09m of CPU against 18m for a quiet one —
 * a fact the run itself had and never printed. So the launcher samples its own scope (cgroup v2) while
 * the command runs and prints CPU over wall time, the memory peak against the cap, how often the cap
 * was reached and the swap peak. A slow run then says whether it was CPU-starved, memory-bound or
 * neither, the moment it ends.
 *
 * Linux 5.15 (WSL) has no `memory.peak` / `memory.swap.peak`, so the peaks are the max over the
 * samples (every few seconds): a lower bound, said as a peak because it is the highest value seen.
 * Every field is `null` when it could not be read — an unmeasured value is never printed as a zero.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ScopeSample {
  /** cpu.stat usage_usec: every process of the scope, children included. Monotonic. */
  cpuUsec: number | null
  /** The highest memory.current seen (page cache included — that is what the cap charges). */
  memoryPeakBytes: number | null
  /** memory.events `max`: how many times an allocation hit MemoryMax and had to reclaim. Monotonic. */
  capHits: number | null
  /** memory.events `oom_kill`. Monotonic. */
  oomKills: number | null
  /** The highest memory.swap.current seen. */
  swapPeakBytes: number | null
}

/** PURE. The cgroup v2 directory named by a `/proc/<pid>/cgroup` text, or null (v1 only, root, or a path that climbs). */
export function cgroupDirOf(procCgroup: string, root = '/sys/fs/cgroup'): string | null {
  const line = procCgroup.split('\n').find(l => l.startsWith('0::'))
  const path = line?.slice(3).trim()
  if (!path || path === '/' || !path.startsWith('/') || path.split('/').includes('..')) return null
  return root + path
}

function num(text: string | undefined): number | null {
  if (text === undefined) return null
  const t = text.trim()
  return /^\d+$/.test(t) ? Number(t) : null
}

function keyed(text: string | undefined, key: string): number | null {
  if (text === undefined) return null
  const line = text.split('\n').find(l => l.startsWith(`${key} `))
  return line ? num(line.slice(key.length + 1)) : null
}

/** PURE. One sample from the raw file texts; a file that was not read is `undefined`. */
export function parseScopeSample(files: { cpuStat?: string; memoryCurrent?: string; memoryEvents?: string; swapCurrent?: string }): ScopeSample {
  return {
    cpuUsec: keyed(files.cpuStat, 'usage_usec'),
    memoryPeakBytes: num(files.memoryCurrent),
    capHits: keyed(files.memoryEvents, 'max'),
    oomKills: keyed(files.memoryEvents, 'oom_kill'),
    swapPeakBytes: num(files.swapCurrent),
  }
}

const maxOf = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b)

/** PURE. Peaks keep the max, counters keep the latest measured; a null never erases a measurement. */
export function foldScopeSample(prev: ScopeSample | null, next: ScopeSample): ScopeSample {
  if (!prev) return next
  return {
    cpuUsec: next.cpuUsec ?? prev.cpuUsec,
    memoryPeakBytes: maxOf(prev.memoryPeakBytes, next.memoryPeakBytes),
    capHits: next.capHits ?? prev.capHits,
    oomKills: next.oomKills ?? prev.oomKills,
    swapPeakBytes: maxOf(prev.swapPeakBytes, next.swapPeakBytes),
  }
}

function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const mm = String(m).padStart(2, '0'), rr = String(r).padStart(2, '0')
  return h ? `${h}h${mm}m${rr}s` : `${m}m${rr}s`
}

function bytes(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`
}

/** PURE. The line printed when the run ends, or null when nothing was measured. */
export function scopeStatsLine(s: ScopeSample | null, wallMs: number, capBytes: number): string | null {
  if (!s) return null
  const parts: string[] = []
  if (s.cpuUsec !== null) parts.push(`cpu ${duration(s.cpuUsec / 1000)} over ${duration(wallMs)} wall (${(s.cpuUsec / 1000 / Math.max(wallMs, 1)).toFixed(2)} cores)`)
  if (s.memoryPeakBytes !== null) parts.push(`memory peak ${bytes(s.memoryPeakBytes)} of the ${bytes(capBytes)} cap`)
  if (s.capHits) parts.push(`cap reached ${s.capHits}×`)
  if (s.swapPeakBytes) parts.push(`swap peak ${bytes(s.swapPeakBytes)}`)
  if (s.oomKills) parts.push(`OOM-killed ${s.oomKills} process(es)`)
  return parts.length ? `agentop run: ${parts.join(' · ')}` : null
}

function readOr(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

/** IO. One sample of a scope directory; a vanished scope is an all-null sample. */
export function readScopeSample(dir: string): ScopeSample {
  return parseScopeSample({
    cpuStat: readOr(join(dir, 'cpu.stat')),
    memoryCurrent: readOr(join(dir, 'memory.current')),
    memoryEvents: readOr(join(dir, 'memory.events')),
    swapCurrent: readOr(join(dir, 'memory.swap.current')),
  })
}

/** PURE. The cgroup v2 directory for a `systemctl show -p ControlGroup --value` answer ("/user.slice/.../x.scope"), or null. */
export function scopeDirOf(controlGroup: string, unit: string, root = '/sys/fs/cgroup'): string | null {
  const path = controlGroup.trim()
  if (!path.startsWith('/') || path.split('/').includes('..') || !path.endsWith(`/${unit}`)) return null
  return root + path
}

/** IO. The real cgroup directory of `unit` (empty ControlGroup = not started yet or already gone), or null. Never throws, never hangs (2 s). */
export function resolveUnitDir(unit: string): string | null {
  try {
    const r = spawnSync('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--value', unit], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
    return r.status === 0 ? scopeDirOf(r.stdout ?? '', unit) : null
  } catch { return null }
}

/**
 * IO. Samples the scope `unit` (e.g. `agentistics-throwaway-x.scope`) every `everyMs` until `stop()`, which
 * returns the folded sample. The directory is asked of systemd by UNIT NAME (`resolve`) and NEVER read from
 * the spawned child's /proc cgroup: that child is `systemd-run`, which stays in the LAUNCHER's cgroup while
 * the command runs in the scope (QA 2026-11-23: the line never printed). Resolved on each tick until it
 * answers; the last sample before the scope vanishes is kept. Never resolved: `stop` says null.
 */
export function watchScope(unit: string, everyMs = 1000, resolve: (unit: string) => string | null = resolveUnitDir): { stop: () => ScopeSample | null } {
  let dir: string | null = null
  let acc: ScopeSample | null = null
  const tick = () => {
    if (!dir) dir = resolve(unit)
    if (dir) acc = foldScopeSample(acc, readScopeSample(dir))
  }
  tick()
  const t = setInterval(tick, everyMs)
  t.unref?.()
  return { stop: () => { clearInterval(t); tick(); return acc } }
}
