/**
 * project-search.ts — PURE. Ranking the places a new session could be started.
 *
 * The wizard's search field is the one control that decides WHERE work happens, so the ordering
 * matters more than the matching: a fuzzy match that puts a repository you last touched in March
 * above the one you are in right now is technically correct and useless.
 *
 * Recency is therefore the base score and the query only filters and refines it. That is the
 * opposite of a plain fuzzy matcher, and deliberately so.
 */

import { normalizeGitRemote, repoShortName } from '@agentistics/core'

/** One place a session could start. */
export interface ProjectCandidate {
  /** The directory a session would be started in. The only field that is load-bearing. */
  path: string
  /** The last path segment — what the row is named. */
  name: string
  /** Normalised git remote (`host/org/repo`), or `''` when the directory is not a repo. */
  remote: string
  /** Epoch ms of the most recent session seen here. 0 when nothing was ever recorded. */
  lastSeenMs: number
  /** How many sessions have run here — the tiebreaker, and a hint that this is a real workspace. */
  sessions: number
  /**
   * True only for a LINKED worktree of a repository — never the repository's own main checkout.
   * `undefined` means "not yet measured" (see `mergeWalkedAndHistory`); a caller that renders
   * before it is resolved should treat that the same as `false`, exactly as `projectKind` does.
   */
  worktree?: boolean
  /**
   * Why this candidate is being offered.
   *
   * `cwd` is the directory the user is standing in and is ALWAYS offered first, even with no history
   * at all: starting a session where you already are is the single most common thing anyone wants,
   * and making that case go through the same search as everything else would bury it.
   * `history` is somewhere sessions have run before, so it carries a repository and a recency;
   * `repo` and `folder` are found by WALKING the home directory, because any folder should be
   * startable and limiting this to places with history made the wizard useless for a repository
   * cloned five minutes ago; `typed` is a path given in full that is in none of the above.
   */
  source: 'cwd' | 'history' | 'repo' | 'folder' | 'typed'
}

/**
 * How much is known about a candidate, which is the primary sort under an equal text match.
 *
 * The order is the point: with the home directory walked, a query like `web` matches a dozen
 * folders, and the one the user means is almost always one they have worked in. Recency alone cannot
 * express that — a scanned folder has no recency at all — so provenance ranks first and recency
 * breaks ties inside it. A `.git` is the strongest hint that a folder is a place someone works
 * rather than a place something is stored.
 */
const SOURCE_RANK: Record<ProjectCandidate['source'], number> = {
  cwd: 0,
  history: 1,
  typed: 2,
  repo: 3,
  folder: 4,
}

/**
 * The PATH, shortened for display — and the reason the list is usable at all.
 *
 * Without it every row is a bare directory name, and a machine with six directories called
 * `portifolio` renders six identical rows with no way to tell which is which. The name answers
 * "what", this answers "which one", and the search is worthless without the second.
 *
 * `$HOME` becomes `~`, and a long path is elided in the MIDDLE rather than at either end.
 *
 * That is the whole point and it took a real machine to see it: cutting the head collapsed
 * `~/aipe-blpsoares/embark-me/packages/portifolio` and `~/embark-me/packages/portifolio` into the
 * same string, so the display re-created the very ambiguity it exists to remove. Cutting the tail
 * would do the same to two siblings. Both ends carry a discriminator; the middle is what can go.
 */
export function candidatePath(c: ProjectCandidate, home: string, max = 44): string {
  const short = home && c.path.startsWith(home) ? `~${c.path.slice(home.length)}` : c.path
  if (short.length <= max) return short

  const parts = short.split('/')
  if (parts.length <= 3) return `…${short.slice(short.length - max + 1)}`

  // The head is the first TWO segments, not one: under `$HOME` the first is always `~`, which
  // distinguishes nothing. `~/aipe-blpsoares/…/portifolio` and `~/embark-me/…/portifolio` are the
  // real case this was got wrong on — with a one-segment head they rendered identically.
  const head = `${parts[0]}/${parts[1]}`
  const tailStart = 2
  let tail = parts[parts.length - 1] ?? ''
  for (let i = parts.length - 2; i >= tailStart; i--) {
    const next = `${parts[i]}/${tail}`
    if (head.length + 2 + next.length > max) break
    tail = next
  }
  const out = `${head}/…/${tail}`
  // A head long enough to blow the budget on its own still has to fit; the tail is the segment that
  // must survive, because it is the directory actually being offered.
  return out.length <= max ? out : `…/${tail}`.slice(0, Math.max(tail.length + 2, max))
}

/**
 * Fold the sessions of the local store into one candidate per DIRECTORY.
 *
 * Per directory rather than per repository: a session starts in a path, and two worktrees of one
 * repo are two different places to work. The remote is carried along for display and for matching,
 * so searching `org/repo` still finds every worktree of it.
 */
export function buildCandidates(
  sessions: ReadonlyArray<{ project_path?: string; current_cwd?: string; git_remote?: string; start_time?: string }>,
): ProjectCandidate[] {
  const byPath = new Map<string, ProjectCandidate>()

  for (const s of sessions) {
    // `project_path` is where the project IS; `current_cwd` may be a worktree of it. Both are real
    // places to start a session, so both become candidates.
    for (const path of [s.project_path, s.current_cwd]) {
      if (!path) continue
      const at = s.start_time ? Date.parse(s.start_time) : NaN
      const seen = Number.isFinite(at) ? at : 0
      const found = byPath.get(path)
      if (found) {
        found.sessions += 1
        if (seen > found.lastSeenMs) found.lastSeenMs = seen
        // A remote learned from any session in this directory applies to the directory. Never
        // overwritten once set: an empty one is "this session did not record it", not evidence.
        if (!found.remote && s.git_remote) found.remote = normalizeGitRemote(s.git_remote)
        continue
      }
      byPath.set(path, {
        path,
        name: baseName(path),
        remote: s.git_remote ? normalizeGitRemote(s.git_remote) : '',
        lastSeenMs: seen,
        sessions: 1,
        source: 'history',
      })
    }
  }

  return [...byPath.values()]
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? path
}

/**
 * Does the query match, and how well?
 *
 * Four tiers, strongest first, because they mean different things to a person typing:
 *  3 — the NAME is exactly the query. Typing a project's name means that project.
 *  2 — the NAME starts with the query. "agen" meaning the project called agentistics.
 *  1 — the name or the repo contains it. "vibes" finding `org/opvibes`.
 *  0 — the full path contains it. The fallback for someone typing a directory fragment.
 * `-1` is no match at all.
 *
 * Deliberately NOT a character-skipping fuzzy match: with a hundred directories, `abc` matching
 * `a…b…c` anywhere returns most of them, and a list that always has results is a list that never
 * answers. Substring matching is what makes typing more characters narrow things down.
 */
export function matchScore(c: ProjectCandidate, query: string): number {
  const q = query.trim().toLowerCase()
  if (q === '') return 0

  const name = c.name.toLowerCase()
  // An EXACT name is what someone typing a project's name means, and it must outrank the dozen
  // directories that merely contain those letters — `por` matching `exports`, `Crash Reports` and
  // `import_data` is correct substring behaviour and useless ordering.
  if (name === q) return 3
  if (name.startsWith(q)) return 2
  if (name.includes(q)) return 1
  if (c.remote && c.remote.toLowerCase().includes(q)) return 1
  if (c.path.toLowerCase().includes(q)) return 0
  return -1
}

/**
 * The candidates worth showing, best first.
 *
 * `cwd` is pinned to the top whenever it matches at all — it is where the user is standing, and no
 * amount of history should push it below somewhere they were last week.
 */
export function searchCandidates(
  candidates: readonly ProjectCandidate[],
  query: string,
  limit = 20,
): ProjectCandidate[] {
  const scored: Array<{ c: ProjectCandidate; score: number }> = []
  for (const c of candidates) {
    const score = matchScore(c, query)
    if (score < 0) continue
    scored.push({ c, score })
  }

  scored.sort((a, b) => {
    // Where you are standing outranks everything, always.
    if ((a.c.source === 'cwd') !== (b.c.source === 'cwd')) return a.c.source === 'cwd' ? -1 : 1
    // Then how well the text matches: a name that STARTS with what was typed beats one that merely
    // contains it, whatever either of them is.
    if (a.score !== b.score) return b.score - a.score
    // Then how much is known about it.
    const bySource = SOURCE_RANK[a.c.source] - SOURCE_RANK[b.c.source]
    if (bySource !== 0) return bySource
    if (a.c.lastSeenMs !== b.c.lastSeenMs) return b.c.lastSeenMs - a.c.lastSeenMs
    if (a.c.sessions !== b.c.sessions) return b.c.sessions - a.c.sessions
    // Shallower first: `~/projects/web` is likelier meant than `~/a/b/c/d/web`.
    const byDepth = a.c.path.split('/').length - b.c.path.split('/').length
    if (byDepth !== 0) return byDepth
    return a.c.name.localeCompare(b.c.name)
  })

  return scored.slice(0, limit).map(x => x.c)
}

/**
 * Merge the fixed candidates (the current directory, a typed path) into the history.
 *
 * The current directory REPLACES its history entry rather than joining it, so the list never shows
 * the same place twice — once as "where you are" and once as "somewhere you have been".
 */
export function withFixedCandidates(
  history: readonly ProjectCandidate[],
  fixed: readonly ProjectCandidate[],
): ProjectCandidate[] {
  const out = new Map<string, ProjectCandidate>()
  for (const c of history) out.set(c.path, c)
  for (const c of fixed) {
    const existing = out.get(c.path)
    // Keep what history knows (the remote, the counts) but let the fixed entry say WHY it is here.
    out.set(c.path, existing ? { ...existing, source: c.source } : c)
  }
  return [...out.values()]
}

/**
 * Merge WALKED candidates (which know worktree-ness for FREE, from the walk's own `readdir`) with
 * HISTORY candidates (which know remotes and recency, but nothing about the directory itself as it
 * is right now) — PURE, so the fs cost of measuring `worktree` stays entirely in the caller.
 *
 * History REPLACES a walked entry wholesale on a shared path — it is the richer record, see the
 * module doc — except for `worktree`: the walk already measured that for free and a session record
 * has no way to know it at all. Losing it here is THE REPORTED BUG: a session started inside a git
 * worktree records the shared repository's own `git_remote`, so a plain object-replace let a
 * worktree the walk had correctly flagged surface a remote and read as a repository's own main
 * checkout (`projectKind` treats a recorded remote as proof of `'repo'` unless `worktree` says
 * otherwise).
 *
 * A path history knows that the walk never visited (outside the scan depth, or outside `$HOME`)
 * comes out with `worktree: undefined` — there was nothing to carry over — and the caller measures
 * it separately, bounded by how many directories this machine has actually worked in rather than by
 * the whole walked tree.
 */
export function mergeWalkedAndHistory(
  walked: readonly ProjectCandidate[],
  history: readonly ProjectCandidate[],
): ProjectCandidate[] {
  const byPath = new Map<string, ProjectCandidate>()
  for (const c of walked) byPath.set(c.path, c)
  for (const c of history) {
    const known = byPath.get(c.path)
    byPath.set(c.path, known?.worktree !== undefined ? { ...c, worktree: known.worktree } : c)
  }
  return [...byPath.values()]
}
