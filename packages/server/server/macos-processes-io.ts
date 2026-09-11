/**
 * macos-processes-io.ts — the IO half of macOS process detection: shells out to `ps` and `lsof`,
 * hands the raw text to the PURE parsers in `macos-processes.ts`, and assembles the same
 * `HarnessProcess[]` shape the Linux `/proc` reader produces so `live-sessions.ts` never has to
 * know which platform it is running on past this one call.
 *
 * See `macos-processes.ts`'s header for the STATED LIMIT — this was written against documented
 * `ps`/`lsof` behaviour, not measured on a live Mac.
 *
 * Two calls per scan, not one per process: a bulk `ps -axwwo pid=,etime=,comm=` identifies every
 * HARNESS candidate cheaply (comm/runtime match, same rule the Linux reader applies), and only
 * THOSE pids pay for the expensive per-pid follow-ups (`ps … command=` for full argv, `lsof` for
 * cwd and open files) — the same shape as `/proc`, where reading every pid's `cmdline` is cheap
 * but a harness match is confirmed before anything else is read.
 */

import type { HarnessId } from '@agentistics/core'
import {
  harnessOfProcess, sessionIdFromArgv, sessionIdFromFdPaths, type HarnessProcess,
} from './live-sessions'
import {
  cwdFromLsof, parseLsofFields, parsePsList, processStartFromEtime, splitPsCommand,
} from './macos-processes'

const JS_RUNTIME_COMMS = new Set(['node', 'bun', 'deno'])

function run(argv: string[], timeoutMs = 4000): { ok: boolean; stdout: string } {
  try {
    const proc = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
    return { ok: proc.exitCode === 0, stdout: proc.stdout.toString('utf-8') }
  } catch {
    return { ok: false, stdout: '' }
  }
}

/** The full argv for one pid, via a per-pid `ps -o command=` (the bulk scan's `comm` alone is not
 *  enough to identify a script-installed harness or read a `--resume` flag). `undefined` when the
 *  process already exited between the bulk scan and this call. */
function fullArgv(pid: number): string[] | undefined {
  const { ok, stdout } = run(['ps', '-p', String(pid), '-o', 'command='])
  const line = stdout.trim()
  if (!ok || !line) return undefined
  return splitPsCommand(line)
}

/** Every open file `lsof` names for a set of pids, in ONE call — `-Fpn` gives the parseable field
 *  form and no per-pid round trip. `-a -p <list>` intersects "these pids" with the default filter
 *  (every open file), which is what makes a single call answer for every candidate at once. */
function openFilesFor(pids: number[]): Map<number, string[]> {
  if (pids.length === 0) return new Map()
  const { ok, stdout } = run(['lsof', '-a', '-p', pids.join(','), '-Fpn'])
  return ok ? parseLsofFields(stdout) : new Map()
}

/** The cwd for a set of pids, in ONE call — `-d cwd` narrows lsof to just that file descriptor,
 *  so this is cheap even for a large candidate list. */
function cwdsFor(pids: number[]): Map<number, string[]> {
  if (pids.length === 0) return new Map()
  const { ok, stdout } = run(['lsof', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'])
  return ok ? parseLsofFields(stdout) : new Map()
}

export interface MacScanResult {
  procs: HarnessProcess[]
  /** `ps` itself could not be run at all (missing from PATH, or exited non-zero) — the bulk scan
   *  never happened, so this is distinct from "ran, found nothing". */
  psFailed: boolean
  /** How many OTHER processes `ps` reported, for the same "is this configuration isolated"
   *  question `detectionUnavailable` asks on Linux. */
  foreignPids: number
  /** A harness candidate was identified but `lsof` could not resolve its cwd. */
  cwdDenied: boolean
}

/** Read every running harness process via `ps` + `lsof`. Bun's own pid is excluded from
 *  `foreignPids`, matching the Linux reader's own-pid exclusion. */
export function scanMacProcesses(nowMs: number = Date.now()): MacScanResult {
  const bulk = run(['ps', '-axwwo', 'pid=,etime=,comm='])
  if (!bulk.ok) return { procs: [], psFailed: true, foreignPids: 0, cwdDenied: false }

  const entries = parsePsList(bulk.stdout)
  const ownPid = process.pid
  const foreignPids = entries.filter(e => e.pid !== ownPid).length

  // First pass: which pids are even worth the expensive follow-ups. `harnessOfProcess` needs argv
  // for a JS-runtime comm, so a runtime candidate is provisionally kept and resolved below; a comm
  // matching neither a known harness NOR a runtime is dropped here, before any lsof/ps call spends
  // a process on it.
  const candidates = entries.filter(e => {
    const base = e.comm.slice(e.comm.lastIndexOf('/') + 1)
    return JS_RUNTIME_COMMS.has(base) || harnessOfProcess(base, e.comm, [e.comm]) !== undefined
  })
  if (candidates.length === 0) return { procs: [], psFailed: false, foreignPids, cwdDenied: false }

  const pids = candidates.map(c => c.pid)
  const cwds = cwdsFor(pids)
  let cwdDenied = false
  const procs: HarnessProcess[] = []

  for (const entry of candidates) {
    const argv = fullArgv(entry.pid)
    if (!argv || argv.length === 0) continue // exited between the two reads
    const comm = entry.comm.slice(entry.comm.lastIndexOf('/') + 1)
    const harness: HarnessId | undefined = harnessOfProcess(comm, entry.comm, argv)
    if (!harness) continue
    const cwd = cwdFromLsof(cwds, entry.pid)
    if (cwd === undefined) { cwdDenied = true; continue }
    const startedMs = processStartFromEtime(entry.etime, nowMs)
    // argv is the WEAKEST identity signal (see `harness-sessions.ts`'s file-based record and the
    // fd-derived id below, both stronger) — kept as the fallback here, overwritten below in that
    // priority order, matching the `??` chain the Linux reader uses.
    const sessionId = sessionIdFromArgv(argv)
    procs.push({ harness, cwd, startedMs, pid: entry.pid, ...(sessionId ? { sessionId } : {}) })
  }

  // Session ids from open files (the macOS equivalent of reading /proc/<pid>/fd/* symlinks) —
  // one more lsof call, scoped to the pids that actually became rows, never the whole candidate
  // list. This OUTRANKS the argv-derived id above (the kernel's own open-file record beats a
  // guess read off the command line), so it overwrites rather than only filling gaps.
  if (procs.length > 0) {
    const openFiles = openFilesFor(procs.map(p => p.pid!))
    for (const p of procs) {
      const paths = openFiles.get(p.pid!)
      if (!paths) continue
      const sid = sessionIdFromFdPaths(paths, p.harness)
      if (sid) p.sessionId = sid
    }
  }

  return { procs, psFailed: false, foreignPids, cwdDenied }
}
