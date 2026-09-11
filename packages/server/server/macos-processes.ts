/**
 * macos-processes.ts — PURE parsers for macOS's process sources.
 *
 * macOS has no `/proc`: `live-sessions.ts`'s Linux reader has nothing to fall back to, so this
 * reads the same facts (pid, comm, argv, cwd, start time, open files) from the two tools every
 * macOS ships with — `ps` and `lsof` — through the IO layer in `macos-processes-io.ts`.
 *
 * STATED LIMIT, matching this repo's own rule for an unverified reading: every parser below is
 * written against the DOCUMENTED output shapes of `ps -o etime,command` and `lsof -F` (both
 * stable, long-standing BSD/macOS interfaces), not against a capture from a running Mac — this
 * environment has no macOS machine to drive one on. Unlike every other "measured on <date>"
 * comment in this codebase, this one cannot make that claim. Treat it as a first cut that wants
 * verification against a real Mac before being trusted the way the Linux reader is.
 *
 * Two consequences of that limit, both leaning toward under-reporting rather than a wrong answer:
 *   - `ps`'s `command=` field joins argv with plain spaces and carries no quoting, so an argument
 *     that itself contains a space (a path, a prompt) cannot be told apart from two arguments.
 *     Splitting on whitespace is the same imperfect approach the Linux reader already applies to
 *     a pty host's rewritten `argv[0]` (see `isHarnessInfrastructure`'s header) — not a new risk,
 *     but a real one, and worth remembering if a macOS session's argv-derived id ever looks wrong.
 *   - `ps -o comm=` is assumed to print the full executable PATH on macOS, the way it does for a
 *     non-app process there — unlike Linux, where `comm` is the kernel's 15-character-truncated
 *     process name (see `harnessOf`'s header) and the reader turns to `/proc/<pid>/exe` instead.
 *     If that assumption is wrong for some processes, `comm` alone still carries the identical
 *     information `harnessOf` already uses for its exact matches (`PROCESS_HARNESS`), so the
 *     worst case is losing the version-install and script-runtime fallbacks, not the direct one.
 */

/** One process from a bulk `ps -axwwo pid=,etime=,comm=` scan. */
export interface PsListEntry {
  pid: number
  /** `ps`'s own elapsed-time token, e.g. `03:12`, `1-04:03:12`. Kept raw; `etimeToMs` converts it. */
  etime: string
  /** The executable — assumed to be the full path (see header). May itself be `node`/`bun`/etc. */
  comm: string
}

/**
 * Parse a bulk `ps -axwwo pid=,etime=,comm=` listing.
 *
 * `pid` and `etime` are single tokens with no internal whitespace (verified against `ps(1)`'s own
 * documented `etime` format, `[[dd-]hh:]mm:ss`), so splitting the line on the first TWO runs of
 * whitespace and keeping everything after as `comm` is exact even when `comm` itself is a path
 * containing spaces — which `command=` (used for the per-pid follow-up) cannot promise once argv
 * joins it. A line that does not start with a pid is skipped rather than guessed at.
 */
export function parsePsList(raw: string): PsListEntry[] {
  const out: PsListEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = /^(\d+)\s+(\S+)\s+(.+)$/.exec(trimmed)
    if (!m) continue
    const pid = Number(m[1])
    if (!Number.isFinite(pid)) continue
    out.push({ pid, etime: m[2]!, comm: m[3]! })
  }
  return out
}

/**
 * `ps`'s `etime` token → elapsed milliseconds. Formats, per `ps(1)`: `mm:ss`, `hh:mm:ss`,
 * `dd-hh:mm:ss`. Returns `undefined` for anything that does not match one of the three — a
 * process whose start time cannot be read should bound nothing rather than be assigned `0`
 * (which would make it look like it started at the epoch and satisfy every "started before X"
 * check it should not).
 */
export function etimeToMs(etime: string): number | undefined {
  const dayMatch = /^(\d+)-(\d{1,2}):(\d{2}):(\d{2})$/.exec(etime)
  const hourMatch = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(etime)
  const minMatch = /^(\d{1,2}):(\d{2})$/.exec(etime)
  let days = 0, hours = 0, mins = 0, secs = 0
  if (dayMatch) {
    days = Number(dayMatch[1]); hours = Number(dayMatch[2]); mins = Number(dayMatch[3]); secs = Number(dayMatch[4])
  } else if (hourMatch) {
    hours = Number(hourMatch[1]); mins = Number(hourMatch[2]); secs = Number(hourMatch[3])
  } else if (minMatch) {
    mins = Number(minMatch[1]); secs = Number(minMatch[2])
  } else {
    return undefined
  }
  return ((days * 24 + hours) * 60 + mins) * 60_000 + secs * 1000
}

/** `nowMs - elapsed` — the process's start time. `undefined` when `etime` could not be parsed. */
export function processStartFromEtime(etime: string, nowMs: number): number | undefined {
  const elapsed = etimeToMs(etime)
  return elapsed === undefined ? undefined : nowMs - elapsed
}

/**
 * Split a `ps -o command=` joined argv string into tokens.
 *
 * Naive whitespace splitting — see the header's stated limit. Collapses runs of spaces so a
 * double space (which `ps` sometimes pads with) does not produce an empty argv element the way
 * `String.split(' ')` would.
 */
export function splitPsCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

/**
 * Parse `lsof -F pfn` "field output" — one attribute per line, first letter is the field id.
 * Stable, documented format (`lsof(1)`, "OUTPUT FOR OTHER PROGRAMS"): a `p<pid>` line opens a
 * process block, and every `n<path>` line until the next `p` line names one of ITS open files.
 *
 * Returns every pid lsof reported, each with the full list of paths its open files resolve to
 * (the `cwd` fd's target included, indistinguishable here from any other open file — the caller
 * selects it by having asked `lsof` to list only `-d cwd`, or filters by descriptor separately).
 */
export function parseLsofFields(raw: string): Map<number, string[]> {
  const byPid = new Map<number, string[]>()
  let currentPid: number | null = null
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const pid = Number(value)
      currentPid = Number.isFinite(pid) ? pid : null
      if (currentPid !== null && !byPid.has(currentPid)) byPid.set(currentPid, [])
      continue
    }
    if (tag === 'n' && currentPid !== null) {
      byPid.get(currentPid)!.push(value)
    }
  }
  return byPid
}

/** The single cwd path for a pid, from a `lsof -a -d cwd -Fpn` listing — `undefined` when lsof
 *  named no cwd file for it (the process exited between the `ps` scan and this call, or its cwd
 *  could not be read). */
export function cwdFromLsof(byPid: Map<number, string[]>, pid: number): string | undefined {
  const paths = byPid.get(pid)
  return paths && paths.length > 0 ? paths[0] : undefined
}
