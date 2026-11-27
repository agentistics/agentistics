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
import { realpathSync } from 'node:fs'
import {
  harnessOf, harnessOfProcess, isNonInteractiveInvocation, sessionIdFromArgv, sessionIdFromFdPaths, type HarnessProcess,
} from './live-sessions'
import {
  cwdFromLsof, executableFromLsofTxt, macExecutable, parseLsofFields, parsePsCommands, parsePsList, processStartFromEtime, splitPsCommand,
} from './macos-processes'

const JS_RUNTIME_COMMS = new Set(['node', 'bun', 'deno'])

const realPath = (p: string): string | undefined => { try { return realpathSync(p) } catch { return undefined } }

/** Runs one command and returns its stdout. ASYNC on purpose (MAC.OPENCODE-MUDO): a `spawnSync` of `ps`/`lsof` holds
 *  the whole server — every HTTP request, the fleet stream, an action's answer — for as long as the command runs,
 *  and `lsof` on a Mac routinely takes seconds. Bounded by `timeoutMs`; a timeout or a spawn failure is `ok: false`. */
export type MacRun = (argv: string[], timeoutMs?: number) => Promise<{ ok: boolean; stdout: string }>

export const runAsync: MacRun = async (argv, timeoutMs = 4000) => {
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const timer = setTimeout(() => { try { proc.kill() } catch { /* gone */ } }, timeoutMs)
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return { ok: code === 0, stdout }
    } finally { clearTimeout(timer) }
  } catch {
    return { ok: false, stdout: '' }
  }
}

/** Every candidate's full argv in ONE `ps` call (the bulk scan's `comm` alone is not enough to identify a
 *  script-installed harness or read a `--resume` flag). A pid absent from the answer exited between the reads. */
async function fullArgvs(run: MacRun, pids: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  if (pids.length === 0) return out
  const { stdout } = await run(['ps', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')])
  // `ps -p` exits 1 when ANY listed pid is gone, while still printing the rest — so the text decides, not the code.
  for (const [pid, line] of parsePsCommands(stdout)) out.set(pid, splitPsCommand(line))
  return out
}

/** Every open file `lsof` names for a set of pids, in ONE call — `-Fpn` gives the parseable field
 *  form and no per-pid round trip. `-a -p <list>` intersects "these pids" with the default filter
 *  (every open file), which is what makes a single call answer for every candidate at once. */
async function openFilesFor(run: MacRun, pids: number[]): Promise<Map<number, string[]>> {
  if (pids.length === 0) return new Map()
  const { stdout } = await run(['lsof', '-a', '-p', pids.join(','), '-Fpn'])
  return parseLsofFields(stdout)
}

/** `lsof` narrowed to one descriptor (`cwd`, `0`) for a set of pids, in ONE call. `lsof` exits 1 when some pid has
 *  no such descriptor (or is gone) while still printing the others, so its text is parsed whatever the exit code. */
async function fdFor(run: MacRun, fd: string, pids: number[]): Promise<Map<number, string[]>> {
  if (pids.length === 0) return new Map()
  const { stdout } = await run(['lsof', '-a', '-d', fd, '-p', pids.join(','), '-Fpn'])
  return parseLsofFields(stdout)
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

/**
 * PERF.SERVIDOR-OCIOSO — the processes already found NOT to be a harness, by pid, with the comm and start time that
 * identify that very process (a recycled pid has another start, an exec another comm). The Linux reader has had this
 * memo since PERF.SLOW; the macOS one had none, so every `node`/`bun` on a developer's Mac (VS Code, MCP servers,
 * Electron helpers) paid `ps -o command` + two `lsof` on EVERY sweep — measured on a simulated 600-process host with 60
 * `node` and no harness: 4 children and 120 pids handed to `lsof` per sweep, forever. With the memo a warm sweep with no
 * harness is ONE `ps`. Only decisions that rest on what an exec fixes for good (comm, executable, argv) are remembered.
 */
export type MacNotHarnessMemo = Map<number, { comm: string; startMs: number | undefined }>
const defaultMacMemo: MacNotHarnessMemo = new Map()
/** `etime` has one-second resolution and is read against our clock: the same process reads a start ±1 s apart. */
const START_TOLERANCE_MS = 2_000
/** Test seam: forget what the default memo learned. */
export function resetMacNotHarnessMemo(): void { defaultMacMemo.clear() }

/** Read every running harness process via `ps` + `lsof`. Bun's own pid is excluded from
 *  `foreignPids`, matching the Linux reader's own-pid exclusion. */
export async function scanMacProcesses(nowMs: number = Date.now(), run: MacRun = runAsync, memo: MacNotHarnessMemo = defaultMacMemo): Promise<MacScanResult> {
  const bulk = await run(['ps', '-axwwo', 'pid=,etime=,comm='])
  if (!bulk.ok) return { procs: [], psFailed: true, foreignPids: 0, cwdDenied: false }

  const entries = parsePsList(bulk.stdout)
  const ownPid = process.pid
  const foreignPids = entries.filter(e => e.pid !== ownPid).length
  // The memo is as large as the process table and no larger.
  const alive = new Set(entries.map(e => e.pid))
  for (const pid of memo.keys()) if (!alive.has(pid)) memo.delete(pid)
  const startOf = (e: { etime: string }) => processStartFromEtime(e.etime, nowMs)
  const known = (e: { pid: number; comm: string; etime: string }): boolean => {
    const m = memo.get(e.pid)
    if (!m || m.comm !== e.comm) return false
    const s = startOf(e)
    return s === undefined || m.startMs === undefined || Math.abs(s - m.startMs) <= START_TOLERANCE_MS
  }
  const notHarness = (e: { pid: number; comm: string; etime: string }): void => { memo.set(e.pid, { comm: e.comm, startMs: startOf(e) }) }

  // First pass: which pids are even worth the expensive follow-ups. `harnessOfProcess` needs argv
  // for a JS-runtime comm, so a runtime candidate is provisionally kept and resolved below; a comm
  // matching neither a known harness NOR a runtime is dropped here, before any lsof/ps call spends
  // a process on it.
  // `ps` names the path the process was EXECUTED by — a symlink for an npm/nvm/volta install — while the install
  // layouts are written against the real file (`/proc/<pid>/exe` on Linux). Resolved only for a name that is a
  // harness at all, so the rest of the process table costs no syscall.
  const exeOf = new Map<number, string>()
  // MAC.OPENCODE r2 — a harness NAME with no path (`ps` printed argv[0] = `opencode`, typed in a shell): only the
  // kernel knows which file it runs (see `executableFromLsofTxt`). Resolved below in ONE `lsof` for all of them.
  const bareNamed: typeof entries = []
  const candidates = entries.filter(e => {
    if (known(e)) return false
    const base = e.comm.slice(e.comm.lastIndexOf('/') + 1)
    if (JS_RUNTIME_COMMS.has(base)) return true
    if (harnessOf(base, e.comm) === undefined) return false
    // The path as executed first (a Homebrew `/opt/homebrew/bin/<tool>` link is itself a known layout and would
    // stop being one once resolved into the Cellar), the resolved file second.
    if (harnessOfProcess(base, e.comm, [e.comm]) !== undefined) return true
    if (!e.comm.startsWith('/')) { bareNamed.push(e); return false }
    const exe = macExecutable(e.comm, realPath)
    if (exe === e.comm || harnessOfProcess(base, exe, [e.comm]) === undefined) return false
    exeOf.set(e.pid, exe)
    return true
  })
  if (bareNamed.length > 0) {
    const txt = await fdFor(run, 'txt', bareNamed.map(e => e.pid))
    for (const e of bareNamed) {
      const exe = executableFromLsofTxt(txt, e.pid, e.comm, path => harnessOfProcess(e.comm, path, [e.comm]) !== undefined)
      if (!exe) { if (txt.has(e.pid)) notHarness(e); continue }
      exeOf.set(e.pid, exe)
      candidates.push(e)
    }
  }
  if (candidates.length === 0) return { procs: [], psFailed: false, foreignPids, cwdDenied: false }

  // argv FIRST (one `ps` for every candidate), and `lsof` only for what argv says is a harness: a `node` running
  // VS Code's helper is decided here and never costs a descriptor read.
  const argvs = await fullArgvs(run, candidates.map(c => c.pid))
  const harnesses: Array<{ entry: (typeof candidates)[number]; argv: string[]; harness: HarnessId }> = []
  for (const entry of candidates) {
    const argv = argvs.get(entry.pid)
    if (!argv || argv.length === 0) continue // exited between the two reads
    const comm = entry.comm.slice(entry.comm.lastIndexOf('/') + 1)
    const harness: HarnessId | undefined = harnessOfProcess(comm, exeOf.get(entry.pid) ?? entry.comm, argv)
    // `isNonInteractiveInvocation` without a tty answer reads argv alone, which an exec fixes for good.
    if (!harness || isNonInteractiveInvocation(harness, argv)) { notHarness(entry); continue }
    harnesses.push({ entry, argv, harness })
  }
  if (harnesses.length === 0) return { procs: [], psFailed: false, foreignPids, cwdDenied: false }

  const pids = harnesses.map(h => h.entry.pid)
  const [cwds, stdins] = await Promise.all([fdFor(run, 'cwd', pids), fdFor(run, '0', pids)])
  let cwdDenied = false
  const procs: HarnessProcess[] = []

  for (const { entry, argv, harness } of harnesses) {
    const stdinPath = cwdFromLsof(stdins, entry.pid)
    const stdinIsTty = stdinPath === undefined ? undefined : /^\/dev\/(ttys?\d*|pts\/)/.test(stdinPath)
    if (isNonInteractiveInvocation(harness, argv, stdinIsTty)) continue
    const cwd = cwdFromLsof(cwds, entry.pid)
    if (cwd === undefined) { cwdDenied = true; continue }
    const startedMs = processStartFromEtime(entry.etime, nowMs)
    // argv is the WEAKEST identity signal (see `harness-sessions.ts`'s file-based record and the
    // fd-derived id below, both stronger) — kept as the fallback here, overwritten below in that
    // priority order, matching the `??` chain the Linux reader uses.
    const sessionId = sessionIdFromArgv(argv)
    procs.push({ harness, cwd, startedMs, pid: entry.pid, stdinIsTty, ...(sessionId ? { sessionId } : {}) })
  }

  // Session ids from open files (the macOS equivalent of reading /proc/<pid>/fd/* symlinks) —
  // one more lsof call, scoped to the pids that actually became rows, never the whole candidate
  // list. This OUTRANKS the argv-derived id above (the kernel's own open-file record beats a
  // guess read off the command line), so it overwrites rather than only filling gaps.
  if (procs.length > 0) {
    const openFiles = await openFilesFor(run, procs.map(p => p.pid!))
    for (const p of procs) {
      const paths = openFiles.get(p.pid!)
      if (!paths) continue
      const sid = sessionIdFromFdPaths(paths, p.harness)
      if (sid) p.sessionId = sid
    }
  }

  return { procs, psFailed: false, foreignPids, cwdDenied }
}
