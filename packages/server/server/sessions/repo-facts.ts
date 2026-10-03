/**
 * repo-facts.ts — which REPOSITORY a directory belongs to, and whether it is a linked worktree.
 *
 * A session is opened in a directory, but the thing a person thinks in is the repository: three
 * worktrees of `agentistics` are three places to work on ONE project, and a list that files them
 * under `session-monitor`, `billing-basis` and `agentistics` has taken the one grouping that
 * matches how the work is organised and split it into three.
 *
 * The identity is the git REMOTE wherever there is one, because that is the only key a worktree
 * provably shares with its main checkout — the directory names deliberately differ, and the
 * toplevel of a linked worktree is the worktree itself. With no remote it falls back to the
 * COMMON git dir's parent, which is the main checkout even when asked from inside a worktree.
 *
 * ## A directory that is GONE is not a directory that is not in a repository
 *
 * `ExitWorktree --remove`, `git worktree remove` and an ordinary `rm -rf` all leave the session
 * registered at a path that no longer names anything. Every `git -C <gone>` then fails, the facts
 * come back empty, and the grouping falls through to the last path segment — so the deleted
 * worktree `.claude/worktrees/member-connect-rotate` appeared on screen as a PROJECT of its own,
 * standing beside `Agentistics`, which is the project it was a worktree of. A folder name is a
 * guess, and inventing a project from a path that resolves to nothing is the same error as
 * reporting a confident `0` for a metric a harness cannot produce.
 *
 * So the discriminator is whether the DIRECTORY EXISTS, not whether git answered:
 *  - it exists and git named a repo  → that, live;
 *  - the session RECORDED its repo when it started → that, and it is the only fact left;
 *  - it exists and nothing names a repo → not in a repository, and its own folder name is real;
 *  - it is gone and nothing was recorded → `missing`, said in WORDS by the UI and never grouped
 *    under a name derived from the path.
 *
 * ## What may be memoized, and what may not
 *
 * A POSITIVE answer is permanent: a directory does not change repository, and the fleet poller runs
 * every five seconds over every session, so asking git three times per session per tick is a hundred
 * processes a minute to learn the same thing. A NEGATIVE one is not a fact about the directory, it
 * is a fact about this MOMENT — the worktree had been removed, or git was briefly unavailable — and
 * caching it for the life of the process meant a cwd probed once while absent stayed repo-less
 * forever, even after `agentop session open` or `git worktree add` put it back. Negatives therefore
 * expire (`NEGATIVE_TTL_MS`), which costs one re-probe a minute for a directory genuinely outside a
 * repository, and nothing at all for one that is missing — that case never spawns git.
 */

import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { repoShortName, normalizeGitRemote } from '@agentistics/core'
import { createLimiter } from '../utils'

export interface RepoFacts {
  /** `org/repo` from the remote, else the main checkout's folder name. Absent outside a repo. */
  repo?: string
  /**
   * The MAIN checkout's folder name — `agentistics` even when asked from inside one of its
   * worktrees. Absent outside a repository.
   *
   * Separate from `repo` because it is a different question: `repo` identifies the project across
   * machines and needs the remote, this one is what the project is CALLED here and exists whether
   * or not anything was ever pushed. It is what the "by project" grouping keys on — a worktree
   * grouped under its own directory name files three checkouts of one project as three projects,
   * which is the same split the repository dimension exists to avoid.
   */
  root?: string
  /**
   * The main checkout's DIRECTORY — `/home/d/agentistics` even when asked from inside one of its
   * worktrees. Absent outside a repository, exactly like `root`, whose basename it is.
   *
   * Separate from `root` because a name cannot be measured against a path. The cascade arrangement
   * files a session under the segments of its `cwd` BELOW the project, and deriving those by
   * string-matching the project's NAME against the cwd is a guess that goes wrong wherever a
   * segment repeats along the path. This is the fact that guess was standing in for — it was
   * already computed here, to take the basename off, and then thrown away.
   */
  rootPath?: string
  /** True only for a LINKED worktree — the main checkout of a repo is not one. */
  worktree: boolean
}

/**
 * The same facts, plus what could not be learned live — what every CALLER should be reading.
 *
 * `RepoFacts` alone cannot distinguish "this directory is not in a repository" from "this directory
 * is not there any more", and the two must be rendered differently: the first has a real folder
 * name to group under, the second has only a path that names nothing.
 */
export interface ResolvedRepoFacts extends RepoFacts {
  /** True when the directory itself no longer exists on this machine. */
  missing: boolean
  /**
   * Where the repository above came from.
   *
   * `live` — git answered just now. `recorded` — the session wrote it down when it started, which
   * is the only fact that survives the directory being deleted. `none` — nothing names a repository,
   * and `repo`/`root` are absent.
   */
  source: 'live' | 'recorded' | 'none'
}

const NONE: RepoFacts = { worktree: false }

/**
 * How long a NEGATIVE answer stands before git is asked again.
 *
 * A minute: long enough that a directory genuinely outside a repository is not re-probed on every
 * five-second poll (12 ticks, not 1), short enough that a worktree recreated by `agentop session
 * open` is recognised while the person who recreated it is still looking at the screen.
 */
export const NEGATIVE_TTL_MS = 60_000

interface CacheEntry {
  facts: RepoFacts
  /** When git was asked, epoch ms. */
  atMs: number
}

const cache = new Map<string, CacheEntry>()

/**
 * May a cached answer be reused? — PURE.
 *
 * A POSITIVE one always: a directory does not change repository. A NEGATIVE one only inside the
 * TTL, because it is a statement about a moment rather than about the directory — the whole reason
 * a cwd first seen while its worktree was deleted no longer stays repo-less for the life of the
 * process.
 */
export function repoFactsFresh(entry: CacheEntry, nowMs: number, ttlMs = NEGATIVE_TTL_MS): boolean {
  if (entry.facts.repo !== undefined) return true
  return nowMs - entry.atMs < ttlMs
}

/**
 * The answer a caller should render, from the three things that can be known — PURE.
 *
 * Order matters and is the whole content of this function:
 *  1. what git says NOW outranks everything, because it is the only one measured against the
 *     directory as it is;
 *  2. what the session RECORDED when it started is next — it was measured the same way, once, and
 *     it is all that is left of a worktree somebody has since removed;
 *  3. otherwise there is no repository, and `missing` says which of the two silences this is.
 *
 * Step 2 runs even when the directory still EXISTS: git can fail for reasons that are not "no
 * repository here" (it is not installed in this container, the index is locked, a filesystem is
 * unmounted mid-poll), and preferring a fact recorded at spawn over a momentary silence is strictly
 * better than falling back to the folder name. `missing` is reported independently of it, because
 * the directory being gone is worth saying whether or not the repository could be recovered.
 */
export function resolveRepoFacts(o: {
  /** What git answered just now — `NONE` when it could not be asked or said nothing. */
  live: RepoFacts
  /** What the session recorded when it started, if it recorded anything. */
  recorded?: RepoFacts | undefined
  /** Whether the directory exists right now. */
  exists: boolean
}): ResolvedRepoFacts {
  if (o.live.repo !== undefined) return { ...o.live, missing: false, source: 'live' }
  if (o.recorded?.repo !== undefined) {
    return { ...o.recorded, missing: !o.exists, source: 'recorded' }
  }
  return { ...NONE, missing: !o.exists, source: 'none' }
}

/** Reset the memo. Tests only. */
export function forgetRepoFacts(): void {
  cache.clear()
  inFlight.clear()
}

/**
 * Decide the facts from what git printed — PURE, so the parsing is testable without a repository.
 *
 * `gitDir` and `commonDir` are what `--git-dir` / `--git-common-dir` gave; they DIFFER exactly when
 * the caller is inside a linked worktree, which is the canonical test and the only one that does
 * not depend on a path convention someone can rename.
 */
export function decideRepoFacts(o: {
  remote: string
  gitDir: string
  commonDir: string
}): RepoFacts {
  const inRepo = o.commonDir !== ''
  if (!inRepo) return NONE
  const worktree = o.gitDir !== '' && o.gitDir !== o.commonDir
  // The COMMON git dir's parent is the main checkout even when asked from a worktree, which is the
  // whole reason it is read instead of `--show-toplevel`. Computed always, not only as a fallback:
  // it is what the project is CALLED here, and a repository with no remote still has a name.
  const rootPath = dirname(o.commonDir.replace(/[/\\]+$/, ''))
  const root = basename(rootPath)
  // The two travel together or not at all: `root` is this path's basename, so a row carrying one
  // without the other would let the cascade measure branches against a directory the project is not
  // actually named after.
  const at = root ? { root, rootPath } : {}
  const named = normalizeGitRemote(o.remote)
  if (named) return { repo: repoShortName(named), worktree, ...at }
  return root ? { repo: root, ...at, worktree } : { worktree }
}

/**
 * At most this many `git` processes at once, across every caller of `repoFacts`.
 *
 * RES.1, measured 2026-10-03: the cockpit's poll asks for every row of the fleet in one
 * `Promise.all` — 780 rows over 237 directories on the owner's machine — and each miss spawned three
 * gits with nothing bounding them, so ONE poll forked ~2.300 processes and took the host from 76 MB
 * to 690 MB RSS. The allocator rarely hands that back, and it recurred every `NEGATIVE_TTL_MS` for
 * the repo-less directories. Bounded here, beside the spawn, so no caller can forget it.
 */
export const GIT_CONCURRENCY = 6
const gitLimit = createLimiter(GIT_CONCURRENCY)

/** The memo's ceiling. Directories are not unbounded in practice, but a five-second poll is. */
export const REPO_FACTS_CACHE_MAX = 2000

/**
 * One lookup per directory IN FLIGHT. 780 rows over 237 directories used to be 780 lookups, because
 * the memo is only written once a lookup FINISHES — every concurrent caller missed it.
 */
const inFlight = new Map<string, Promise<RepoFacts>>()

function remember(cwd: string, entry: CacheEntry): void {
  cache.delete(cwd)
  cache.set(cwd, entry)
  // Insertion order is the eviction order: the oldest answer goes first.
  while (cache.size > REPO_FACTS_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Test seam: how many directories are memoized / being asked about right now. */
export function repoFactsCacheSize(): { cached: number; inFlight: number } {
  return { cached: cache.size, inFlight: inFlight.size }
}

function git(cwd: string, args: string[]): Promise<string> {
  return gitLimit(() => gitNow(cwd, args))
}

async function gitNow(cwd: string, args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
      // Never let git open a credential helper or an editor: this runs on a poll, behind a screen
      // the user is reading, and a prompt with nowhere to draw is a hang with no explanation.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    const out = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? out.trim() : ''
  } catch {
    return ''
  }
}

/** Does this directory exist right now? Never throws — anything unreadable answers "no". */
async function dirExists(cwd: string): Promise<boolean> {
  try {
    return (await stat(cwd)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The repository a directory belongs to, as a caller should render it. Never throws.
 *
 * `recorded` is what the session wrote down when it started — pass it and a removed worktree keeps
 * its project, omit it and the answer is the live one plus whether the directory is still there.
 *
 * A MISSING directory never spawns git: three processes to be told a path does not exist is three
 * processes wasted on every poll, and the `stat` has already answered the question.
 */
export async function repoFacts(cwd: string, recorded?: RepoFacts): Promise<ResolvedRepoFacts> {
  if (!cwd) return { ...NONE, missing: false, source: 'none' }

  const exists = await dirExists(cwd)
  if (!exists) return resolveRepoFacts({ live: NONE, recorded, exists: false })

  const nowMs = Date.now()
  const hit = cache.get(cwd)
  if (hit && repoFactsFresh(hit, nowMs)) {
    return resolveRepoFacts({ live: hit.facts, recorded, exists: true })
  }

  let pending = inFlight.get(cwd)
  if (!pending) {
    pending = (async () => {
      const [commonDir, gitDir, remote] = await Promise.all([
        git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']),
        git(cwd, ['config', '--get', 'remote.origin.url']),
      ])
      const live = decideRepoFacts({ remote, gitDir, commonDir })
      remember(cwd, { facts: live, atMs: nowMs })
      return live
    })().finally(() => { inFlight.delete(cwd) })
    inFlight.set(cwd, pending)
  }
  const live = await pending
  return resolveRepoFacts({ live, recorded, exists: true })
}

/**
 * What to RECORD on a session being started — shaped to spread straight into `addSession`.
 *
 * Only ever the LIVE answer, and only when it names a repository. An empty record would be
 * indistinguishable from an older build that recorded nothing, while being preferred over a
 * repository the directory acquires later; and a recorded value copied from another recorded value
 * would let one stale answer propagate through every session ever reopened from it.
 *
 * Never throws — a session must start even when git does not answer. It simply records nothing,
 * which is what every row written before this existed already does.
 */
export async function recordedRepo(cwd: string): Promise<{ repo?: RepoFacts }> {
  const facts = await repoFacts(cwd).catch(() => undefined)
  if (facts?.source !== 'live' || facts.repo === undefined) return {}
  return {
    repo: {
      repo: facts.repo,
      ...(facts.root ? { root: facts.root } : {}),
      ...(facts.rootPath ? { rootPath: facts.rootPath } : {}),
      worktree: facts.worktree,
    },
  }
}
