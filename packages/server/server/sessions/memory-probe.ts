/**
 * memory-probe.ts — the impure half of the memory budget: reading this machine.
 *
 * Split from `memory-budget.ts` for the usual reason — the arithmetic is tested and the syscalls are
 * not — and kept deliberately small: two reads and a sum.
 *
 * **Where it cannot read, it returns `null` and the whole gauge is absent.** Not zero, not a
 * placeholder. `/proc` exists on Linux and on WSL; it does not on macOS or Windows, and a machine
 * that cannot be measured must show no gauge rather than a confident wrong one — the same rule
 * `ControlService.boot` follows for systemd and `HARNESS_CAPABILITIES` for metrics.
 */

import { readFile, readdir } from 'node:fs/promises'
import type { MemoryBudget, MemorySample } from './memory-budget'
import type { Hog, SpawnBudget } from './spawn-admission'
import { memoryBudget, parseMeminfo } from './memory-budget'

/** The machine's memory, or `null` where it cannot be read. */
export async function readMemory(): Promise<MemorySample | null> {
  try {
    return parseMeminfo(await readFile('/proc/meminfo', 'utf8'))
  } catch {
    return null
  }
}

/**
 * Total resident bytes of a set of pids, and how many were actually readable.
 *
 * `VmRSS` from `/proc/<pid>/status` rather than `statm`, because it is already in kB and labelled —
 * no page-size arithmetic to get wrong.
 *
 * **RSS of processes that share pages does not sum exactly.** It over-counts shared libraries, so
 * this figure is an upper bound. That is the right direction for this use — a budget that errs
 * toward "fewer sessions fit" fails safe — but it is stated here rather than left for someone to
 * discover, and it is why the surface says "recommended" and not "available".
 */
export async function readRss(pids: readonly number[]): Promise<{ bytes: number; read: number }> {
  let bytes = 0
  let read = 0
  for (const pid of pids) {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8')
      const m = /^VmRSS:\s+(\d+) kB$/m.exec(status)
      if (!m) continue
      // RSS + SWAP (RES.1): a session the kernel pushed into swap still needs that memory back the
      // moment it works, and RSS alone under-measured the incident machine by gigabytes.
      const swap = /^VmSwap:\s+(\d+) kB$/m.exec(status)
      bytes += (Number(m[1]) + (swap ? Number(swap[1]) : 0)) * 1024
      read++
    } catch {
      // Gone between listing and reading, or a uid that may not look. Skipped, and the count says so.
    }
  }
  return { bytes, read }
}

/**
 * The budget a spawn is admitted against — the ONE measurement behind both the cockpit's gauge and
 * the spawn gate (`spawn-admission.ts`), so the number a person reads and the number that refuses
 * them can never disagree. `null` when this machine cannot be measured (no `/proc/meminfo`).
 *
 * The pids are the assistants: every harness process `scanProcesses()` finds, plus every harness
 * record Claude Code marks alive (a managed session whose process the scan could not attribute),
 * deduplicated. The whole machine is deliberately NOT priced — `MemAvailable` already accounts for
 * everything else and `RESERVED_BYTES` holds room back for it.
 *
 * Both sources are imported lazily: `live-sessions.ts` and `harness-sessions.ts` pull in `config.ts`
 * and the process walkers, and this module's two syscall helpers must stay cheap to import. A pid
 * source that throws costs its pids, never the measurement: the budget then falls back to the
 * `assumed` cost, which the result says.
 */
export async function readSpawnBudget(): Promise<SpawnBudget | null> {
  const sample = await readMemory()
  if (!sample) return null

  // RES.1 — the heavy-job reserve, the CPU load and the biggest consumer, read beside the memory.
  const heavyReserveBytes = await import('../resources/heavy-io')
    .then(async m => {
      const st = await m.readHeavyState()
      const { heavyReserveBytes } = await import('../resources/heavy')
      return heavyReserveBytes(st.running.reduce((n, r) => n + (r.usedBytes ?? 0), 0))
    })
    .catch(() => 0)
  const load = await readLoad()
  const hog = await readBiggestConsumer().catch(() => null)

  const pidsFromProc = await import('../live-sessions')
    .then(m => m.scanProcesses())
    .then(scan => scan.procs.map(p => p.pid).filter((pid): pid is number => pid !== undefined))
    .catch(() => [] as number[])

  const pidsFromHarness = await import('./harness-sessions')
    .then(m => m.loadHarnessSessions())
    .then(index => [...index.byConversation.values()]
      .filter(f => f.alive === true && f.pid !== undefined)
      .map(f => f.pid!))
    .catch(() => [] as number[])

  const pids = Array.from(new Set([...pidsFromProc, ...pidsFromHarness]))
  const { bytes, read } = await readRss(pids)
  return {
    budget: memoryBudget({ sample, sessionBytes: bytes, sessions: read, heavyReserveBytes, ...reserveOverride() }),
    sample,
    heavyReserveBytes,
    ...(load ? { load } : {}),
    ...(hog ? { hog } : {}),
  }
}

/** `/proc/loadavg`'s 1-minute figure and the number of CPUs. `null` off Linux. */
export async function readLoad(): Promise<{ load1: number; cores: number } | null> {
  try {
    const load1 = Number((await readFile('/proc/loadavg', 'utf8')).split(' ')[0])
    const { availableParallelism, cpus } = await import('node:os')
    const cores = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length
    return Number.isFinite(load1) && cores > 0 ? { load1, cores } : null
  } catch {
    return null
  }
}

/**
 * The process of this uid holding the most RAM + swap — named in a refusal, because "close a
 * session" is advice and "agentop (pid 15667) holds 8.2 GB, on a binary an upgrade replaced" is a
 * fix. An agentop process carries the governor's own fix (resources/governor.ts).
 */
export async function readBiggestConsumer(): Promise<Hog | null> {
  const uid = process.getuid?.()
  let names: string[]
  try { names = await readdir('/proc') } catch { return null }
  let best: { pid: number; bytes: number } | null = null
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    try {
      const status = await readFile(`/proc/${n}/status`, 'utf8')
      const u = /^Uid:\s+(\d+)/m.exec(status)
      if (uid !== undefined && u && Number(u[1]) !== uid) continue
      const rss = Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1] ?? 0)
      const swap = Number(/^VmSwap:\s+(\d+) kB$/m.exec(status)?.[1] ?? 0)
      const bytes = (rss + swap) * 1024
      if (!best || bytes > best.bytes) best = { pid: Number(n), bytes }
    } catch { /* gone */ }
  }
  if (!best) return null
  const argv = (await readFile(`/proc/${best.pid}/cmdline`, 'utf8').catch(() => '')).split('\0').filter(Boolean)
  const label = processLabel(argv) || `pid ${best.pid}`
  // The governor's verdict on it, when it is one of agentop's.
  let fix: Hog['fix']
  try {
    const { governorFixFor } = await import('../resources/hog-fix')
    fix = await governorFixFor(best.pid)
  } catch { fix = undefined }
  return { pid: best.pid, label, usedBytes: best.bytes, ...(fix ? { fix } : {}) }
}

/**
 * Every pid under a tmux session's process tree is NOT what this needs — the harness process is.
 *
 * The caller passes the pids it already knows about (from the harness records and from the process
 * scan), so this module never has to decide what an assistant is. It exists as a named export
 * because the alternative — each caller writing its own `/proc` read — is how two surfaces end up
 * disagreeing about the same number.
 */
export async function procPidsExist(): Promise<boolean> {
  try {
    await readdir('/proc/self')
    return true
  } catch {
    return false
  }
}

/**
 * A short name for a process — PURE. `node /…/node_modules/typescript/bin/tsc --noEmit` is `tsc
 * --noEmit`, not `node /home/…`: for an interpreter the SCRIPT is the program. Paths are cut to
 * their last segment, and the whole is capped.
 */
export function processLabel(argv: readonly string[]): string {
  const base = (p: string | undefined) => (p ?? '').split('/').filter(Boolean).pop() ?? ''
  const INTERPRETERS = new Set(['node', 'bun', 'python', 'python3', 'deno', 'ruby', 'perl', 'sh', 'bash'])
  let i = 0
  if (INTERPRETERS.has(base(argv[0]))) {
    // Skip the interpreter's own flags (`node --max-old-space-size=… script`).
    i = 1
    while (i < argv.length && argv[i]!.startsWith('-')) i++
    if (i >= argv.length) i = 0
  }
  const head = base(argv[i])
  const rest = argv.slice(i + 1, i + 3).map(a => (a.startsWith('/') ? base(a) : a))
  return [head, ...rest].join(' ').slice(0, 60)
}

/**
 * `AGENTISTICS_ADMISSION_RESERVE_MB` — a machine that wants a bigger floor than the 2 GB held back
 * for everything that is not an assistant (a desktop with a heavy browser, a VM). Nonsense is ignored.
 */
function reserveOverride(): { reservedBytes?: number } {
  const mb = Number(process.env.AGENTISTICS_ADMISSION_RESERVE_MB)
  return Number.isFinite(mb) && mb >= 256 ? { reservedBytes: Math.round(mb * 1024 * 1024) } : {}
}
