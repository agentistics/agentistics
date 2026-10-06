/** PURE: which project directories need their git facts read, and where those facts land.
 */
import { projectPathKey } from '@agentistics/core'

/**
 *  `getGitRemote` and `getProjectGitStats` used to be called from inside `scanProjectDir`, which
 *  exists inside the walk of `~/.claude/projects`. A repository was therefore discovered as a SIDE
 *  EFFECT of Claude having a project directory: sessions from every other harness inherited a remote
 *  only through `backfillGitRemote`, which links a remote-less session to one that another session
 *  at the same path already resolved — and until a Claude session existed there, none had.
 *
 *  Measured on a real machine before this change: claude 163 sessions / 95 with a remote, codex
 *  10 / 0, copilot 8 / 1, gemini 15 / 1.
 *
 *  A repository is a property of a DIRECTORY. So the plan is keyed on `project_path` from any
 *  harness, and the resolution runs once per path. */

export interface PathFacts {
  path: string
  /** Earliest session at this path, from ANY harness — the window `getProjectGitStats` scopes to.
   *  `''` when nothing is known, which the caller passes through as "no lower bound". */
  earliest: string
}

interface PlanSession { project_path?: string; start_time?: string }
interface PlanProject { path: string }

/** One entry per distinct path, in first-seen order, carrying the earliest session at it.
 *
 *  `alreadyResolved` are the paths the Claude walk has already read git for. They are skipped
 *  rather than re-read: a path that IS resolved and has no remote is not a repository, and asking
 *  git again every build would spend a process to learn the same nothing. This is what keeps the
 *  change close to cost-neutral — the extra reads are exactly the paths that report nothing today. */
export function planProjectFacts(
  sessions: PlanSession[],
  projects: PlanProject[],
  alreadyResolved: ReadonlySet<string> = new Set(),
): PathFacts[] {
  const resolvedKeys = new Set([...alreadyResolved].map(p => projectPathKey(p)))
  const earliest = new Map<string, string>()
  const order: string[] = []

  const see = (path: string, start: string) => {
    if (!path) return
    const key = projectPathKey(path)
    if (!earliest.has(key)) { earliest.set(key, start); order.push(key); return }
    const known = earliest.get(key)!
    // `''` means unknown, and unknown must never win a comparison against a real date.
    if (start && (!known || start < known)) earliest.set(key, start)
  }

  for (const s of sessions) see(s.project_path ?? '', s.start_time ?? '')
  for (const p of projects) see(p.path, '')

  return order
    .filter(path => !resolvedKeys.has(path))
    .map(path => ({ path, earliest: earliest.get(path) ?? '' }))
}

export interface ResolvedFacts {
  /** Normalized remote, or `''` when the directory is not a git repo / has no origin. */
  remote: string
  stats?: unknown
}

interface StampSession { project_path?: string; git_remote?: string }
interface StampProject { path: string; gitRemote?: string; git_stats?: unknown }

/** Stamp resolved facts onto the sessions and projects at each path.
 *
 *  Two rules, both about not destroying something truer than what we just read:
 *  - a `git_remote` already on a session is LEFT ALONE. CI ingest stamps it authoritatively from a
 *    repo-bound token (`stampCiSessions`); a local `git config` read must not be able to override
 *    that, and neither must a second pass over the same session.
 *  - an EMPTY resolved remote clears nothing. "This directory is not a repo" is not evidence that a
 *    remote recorded elsewhere is wrong — most often the directory is simply gone from this machine. */
export function applyProjectFacts(
  facts: Map<string, ResolvedFacts>,
  sessions: StampSession[],
  projects: StampProject[],
): void {
  for (const s of sessions) {
    if (s.git_remote) continue
    const f = s.project_path ? facts.get(projectPathKey(s.project_path)) : undefined
    if (f?.remote) s.git_remote = f.remote
  }
  for (const p of projects) {
    const f = facts.get(projectPathKey(p.path))
    if (!f) continue
    if (!p.gitRemote && f.remote) p.gitRemote = f.remote
    if (p.git_stats === undefined && f.stats !== undefined) p.git_stats = f.stats
  }
}
