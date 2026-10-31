/**
 * opencode-run-link.ts — PURE. Which `ses_…` a running opencode TUI process is driving, read off the
 * log opencode itself writes.
 *
 * ## Why a log, and why this one
 *
 * Measured against opencode 1.19.5 under tmux on 2026-10-31 (throwaway HOME, `leader/qa/opencode-wp-a-probe`):
 *
 * - the TUI cannot be TOLD an id: `-s/--session` continues an EXISTING session and nothing assigns a fresh one;
 * - it holds exactly one store open — `opencode.db` (+ `-wal`/`-shm`) — for EVERY session, so an open fd names
 *   no conversation (the route `process-transcript.ts` takes for codex and kimi does not exist here);
 * - the session row is created on the FIRST prompt, not at spawn, so "the newest session in this folder" is
 *   wrong in both directions: empty before the first message, and somebody else's when two TUIs share a folder.
 *
 * What it DOES write is one shared `<data>/log/opencode.log` where every line carries the writing process's
 * own `run=<hex>` tag. A run opens with `message="creating instance" directory=<cwd>` within moments of the
 * process starting, and every turn names its session: `message=created id=ses_…` when one is made and
 * `message=loop session.id=ses_…` each time the agent loop runs one. So a process is paired with the run that
 * started in ITS directory at ITS start time, and the run says which session it is working on — the LAST
 * session it named, which follows `/new` and the session picker too.
 *
 * ## Refusals — every ambiguity is no answer
 *
 * A link here is treated as exact everywhere downstream (it opens a chat under this row's name), so:
 * - a run is only a candidate when its directory is the process's cwd AND it began within `START_SKEW_MS` of
 *   the process's own start time (the kernel's, from `/proc/<pid>/stat`);
 * - two candidate runs for one process → no answer;
 * - one run that is the candidate of two processes → neither gets it (two TUIs started in one folder in the
 *   same instant are indistinguishable from here);
 * - a run that has named no session yet (no first message) → no answer, which is the truth: there is none.
 *
 * The log is a private convention, read TOTALLY: any line this does not positively recognise is skipped.
 */

/** How far the run's first log line may sit from the process's start time. MEASURED on this machine
 *  (WSL2, 2026-10-31): +6,3 s on one TUI and −9 s on another — the start time is the kernel's tick count
 *  turned into wall time, the log line is wall time, and WSL's wall clock is corrected in jumps between
 *  the two. So the window is wide on purpose: it only ever REFUSES more (two TUIs started in one folder
 *  within a minute of each other), it never links the wrong one. */
export const START_SKEW_MS = 60_000

export interface OpencodeRun {
  run: string
  /** When the run's first line was written (epoch ms). */
  startMs: number
  /** The directory its first `creating instance` names. */
  directory: string
  /** The last `ses_…` the run named, or `null` before its first message. */
  sessionId: string | null
  /** When it last named one. */
  sessionAtMs: number | null
}

const LINE_RE = /^timestamp=(\S+) level=\S+ run=([0-9a-f]+) (.*)$/
const SES = String.raw`(ses_[A-Za-z0-9]{20,40})`
const SESSION_RE = new RegExp(String.raw`(?:^|\s)(?:session\.id|id|sessionID)=${SES}(?=\s|$)`)

/** The value of `key=` on a log line — bare, or double-quoted (opencode quotes values with spaces). */
function field(rest: string, key: string): string | null {
  const at = rest.search(new RegExp(String.raw`(?:^|\s)${key.replace('.', '\\.')}=`))
  if (at < 0) return null
  const start = rest.indexOf('=', at) + 1
  if (rest[start] === '"') {
    const end = rest.indexOf('"', start + 1)
    return end < 0 ? null : rest.slice(start + 1, end)
  }
  const end = rest.indexOf(' ', start)
  return end < 0 ? rest.slice(start) : rest.slice(start, end)
}

/** Every run in a slice of `opencode.log`, keyed by its tag. A partial first line (a byte-tail cut) is skipped. */
export function parseOpencodeRuns(text: string): Map<string, OpencodeRun> {
  const runs = new Map<string, OpencodeRun>()
  // A subagent (opencode's `task` tool) is its own session, created with `parentID=ses_…` and looped by the
  // same run. It is the parent's work, never the conversation the person is looking at, so a line naming a
  // child never moves the run's session.
  const children = new Set<string>()
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line)
    if (!m) continue
    const at = Date.parse(m[1]!)
    if (!Number.isFinite(at)) continue
    const tag = m[2]!, rest = m[3]!
    let run = runs.get(tag)
    if (!run) {
      // A run is only known from its OPENING line: one first seen mid-way (its start cut off by a tail window)
      // has no trustworthy start time, so it is never a candidate.
      if (!/(?:^|\s)message="creating instance"/.test(rest)) continue
      const directory = field(rest, 'directory')
      if (!directory) continue
      run = { run: tag, startMs: at, directory, sessionId: null, sessionAtMs: null }
      runs.set(tag, run)
      continue
    }
    const parent = field(rest, 'parentID')
    const created = /(?:^|\s)message=created(?:\s|$)/.test(rest) ? field(rest, 'id') : null
    if (created && parent && parent.startsWith('ses_')) { children.add(created); continue }
    const ses = SESSION_RE.exec(rest)
    if (ses && !children.has(ses[1]!)) { run.sessionId = ses[1]!; run.sessionAtMs = at }
  }
  return runs
}

export interface OpencodeProcessRef {
  pid: number
  cwd: string
  /** The kernel's start time (epoch ms). Without it a process can be paired with nothing. */
  startedMs?: number
}

/**
 * The session each process is driving, by pid. Processes with no answer are ABSENT from the map — see the
 * header for every refusal.
 */
export function linkOpencodeProcesses(
  procs: readonly OpencodeProcessRef[],
  runs: ReadonlyMap<string, OpencodeRun>,
  skewMs: number = START_SKEW_MS,
): Map<number, string> {
  const candidateOf = new Map<number, OpencodeRun>()
  const claimants = new Map<string, number>()
  for (const p of procs) {
    if (p.startedMs === undefined) continue
    const hits = [...runs.values()].filter(r => r.directory === p.cwd && Math.abs(r.startMs - p.startedMs!) <= skewMs)
    if (hits.length !== 1) continue
    const run = hits[0]!
    candidateOf.set(p.pid, run)
    claimants.set(run.run, (claimants.get(run.run) ?? 0) + 1)
  }
  const out = new Map<number, string>()
  for (const [pid, run] of candidateOf) {
    if (claimants.get(run.run) !== 1 || !run.sessionId) continue
    out.set(pid, run.sessionId)
  }
  return out
}
