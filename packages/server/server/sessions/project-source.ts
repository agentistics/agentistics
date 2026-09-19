/**
 * project-source.ts — where the wizard's candidates come from.
 *
 * THREE sources, merged, in descending order of how much we know about them:
 *
 *  1. **History** — the local consolidate store. Places you have actually worked, so they can be
 *     ranked by recency and carry their repository.
 *  2. **The home directory, walked** — because any folder should be startable. Limiting the wizard
 *     to places with history made it useless for the most ordinary case there is: a repository
 *     cloned five minutes ago.
 *  3. **A path typed in full** — the escape hatch for anywhere else on the machine, including
 *     outside `$HOME`.
 *
 * All three are read from disk directly rather than through the API, for the same reason
 * `conversations.ts` is: the control center must work with the server stopped, which is exactly the
 * state a user is in when they open it to start something.
 */

import { homedir } from 'node:os'
import { countPerKind, PROJECTS_PER_KIND, projectKind, takePerKind, type ProjectKind } from '@agentistics/core'
import { loadConsolidated } from '../consolidate'
import { isDirectory, isWorktreeDir, scanDirectories } from './dir-scan'
import {
  buildCandidates, mergeWalkedAndHistory, searchCandidates, withFixedCandidates,
  type ProjectCandidate,
} from './project-search'

/** Long enough that reopening the wizard is instant, short enough that a repo cloned a minute ago
 *  shows up without restarting the control center. */
const CACHE_TTL_MS = 60_000

let cache: { at: number; candidates: ProjectCandidate[] } | null = null

async function allCandidates(): Promise<ProjectCandidate[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.candidates

  const [history, scanned] = await Promise.all([
    loadConsolidated()
      .then(m => buildCandidates([...m.values()]))
      // A store that cannot be read is a wizard with no history, never one that fails to open.
      .catch(() => [] as ProjectCandidate[]),
    scanDirectories().catch(() => []),
  ])

  // History WINS on a path both know about: it carries the repository and the recency, and the walk
  // knows only that the directory exists. `mergeWalkedAndHistory` keeps the richer entry and lets
  // the other one say why it is there — here the walk says nothing history has not already said
  // better, EXCEPT `worktree`, which only the walk can know for free and history cannot know at
  // all — see that function's own note; it is the whole reason this is no longer a bare
  // `Map.set` overwrite.
  const walked: ProjectCandidate[] = scanned.map(d => ({
    path: d.path,
    name: d.name,
    remote: '',
    lastSeenMs: 0,
    sessions: 0,
    // A linked worktree still "has a `.git`", so it keeps the same PROVENANCE as a repository the
    // walk found — `worktree` is what tells the two apart for `projectKind`, and this is the field
    // every OTHER reader of `source` (the terminal wizard included) already expects.
    source: d.repo || d.worktree ? 'repo' : 'folder',
    worktree: d.worktree,
  }))

  let candidates = mergeWalkedAndHistory(walked, history)

  // A history path the walk never reached (outside the scan depth, or outside `$HOME`) still needs
  // to know whether it is a linked worktree — one `.git`-type `stat` per SUCH path, bounded by how
  // many directories this machine has actually worked in, never by the whole home tree the walk
  // covers. Distinct paths only (the Map above already deduped them), and this runs once per
  // `CACHE_TTL_MS`, not once per keystroke.
  const unresolved = candidates.filter(c => c.worktree === undefined)
  if (unresolved.length > 0) {
    const flags = await Promise.all(unresolved.map(c => isWorktreeDir(c.path)))
    const resolved = new Map(unresolved.map((c, i) => [c.path, flags[i]!]))
    candidates = candidates.map(c => resolved.has(c.path) ? { ...c, worktree: resolved.get(c.path) } : c)
  }

  cache = { at: now, candidates }
  return candidates
}

/** Drop the index, so a directory created seconds ago is findable without waiting out the TTL. */
export function forgetProjects(): void {
  cache = null
}

/**
 * The places worth offering for `query`, best first.
 *
 * `cwd` is always a candidate, with or without history — starting where you already are is the
 * single most common thing anyone wants, and routing that through a search would bury it.
 */
export interface ProjectSearch {
  /** The rows to offer, ranked then capped per kind. */
  rows: ProjectCandidate[]
  /**
   * How many MATCHED, per kind — before the cap.
   *
   * The tabs carry these. Counting the returned rows instead made every tab read `12`, which is the
   * cap: a number that can never be anything else, stated as though it were a fact about the
   * machine. `rows` is what fits on screen; this is what is there.
   */
  totals: Record<ProjectKind, number>
}

export async function findProjects(
  query: string, cwd: string, perKind = PROJECTS_PER_KIND,
): Promise<ProjectSearch> {
  const known = await allCandidates()

  // Only worth a `stat` when the path is not already KNOWN — `withFixedCandidates` keeps the known
  // entry's already-resolved `worktree` and merely overrides `source`, so paying for this twice
  // would be wasted the moment the cache is warm (the ordinary case: `cwd` is almost always
  // somewhere the walk or history has already seen).
  const cwdKnownWorktree = known.find(c => c.path === cwd)?.worktree
  const fixed: ProjectCandidate[] = [{
    path: cwd,
    name: baseName(cwd),
    remote: '',
    lastSeenMs: 0,
    sessions: 0,
    source: 'cwd',
    worktree: cwdKnownWorktree ?? await isWorktreeDir(cwd),
  }]

  // A typed path that exists but is nowhere in the index — outside `$HOME`, or deeper than the walk
  // goes. Checked only when it LOOKS like a path, so an ordinary word never costs a stat.
  const typed = query.trim()
  if (typed.startsWith('/') || typed.startsWith('~')) {
    const path = typed.startsWith('~') ? typed.replace(/^~/, homedir()) : typed
    if (!known.some(c => c.path === path) && await isDirectory(path)) {
      fixed.push({
        path, name: baseName(path), remote: '', lastSeenMs: 0, sessions: 0, source: 'typed',
        worktree: await isWorktreeDir(path),
      })
    }
  }

  /**
   * RANKED IN FULL, then capped PER KIND — never a global cap after ranking.
   *
   * Measured on a real machine: `portif` ranked twenty rows of which fifteen were plain folders
   * with no git and no history, and the three repositories the person was looking for were what
   * the cap was spending its budget on. A directory named like the one you want must not be able
   * to push the one you want off the list. See `takePerKind`.
   */
  const ranked = searchCandidates(withFixedCandidates(known, fixed), query, Number.MAX_SAFE_INTEGER)
  return {
    rows: takePerKind(ranked, c => projectKind(c), perKind),
    totals: countPerKind(ranked, c => projectKind(c)),
  }
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? path
}
