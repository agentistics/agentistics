/**
 * release-repos.ts — PURE. WHICH clones to ask "does a release tag contain this commit?".
 *
 * The first version asked the checkout the server happened to run from (`process.cwd()`). The installed
 * agentop does not run inside a git checkout, so in production every answer was "no" and Publicado stayed
 * empty; and a delivery routinely spans repositories (a commit may live in the public repo or in the engine
 * repo), so even from inside one checkout half of the commits were out of reach.
 *
 * A piece's commit is therefore looked up, in order, in:
 *  1. the repositories of the sessions filed on that subtask (the registry knows each session's cwd and the
 *     main checkout it belongs to — the MAIN checkout first, because a worktree may be gone by now);
 *  2. the sessions filed anywhere on that task;
 *  3. the clones of the repository the task itself names (`Task.repo`, a normalized remote);
 *  4. every repository agentistics already knows (what `/api/repos` lists), most-used first.
 * Order only decides which clone is asked first; the answer is "published" when ANY of them says so.
 */

import { isAbsolute } from 'node:path'

/** The slice of a session row this needs (`BoardRow` satisfies it). */
export interface DirRow {
  cwd?: string
  repo?: { rootPath?: string }
  subtaskId?: string
}

/** The slice of a session record this needs (`SessionMeta` satisfies it). */
export interface DirMeta {
  project_path?: string
  git_remote?: string
}

/** How many clones one commit is ever asked in — a bound on git processes, not a policy. */
export const MAX_DIRS_PER_SHA = 8
/** How many known repositories the last-resort list holds. */
export const MAX_FALLBACK_DIRS = 12

/**
 * The environment a git child runs in: the process's own WITHOUT any `GIT_*` variable. `git -C <dir>` is only
 * authoritative while `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` are unset — inside a git hook (the pre-commit
 * that runs the test suite) they point at the checkout being committed, and every `git -C <tmp>` of a test then
 * operates on THAT repository instead (a stray commit landed on a real branch that way). `extra` is added after.
 */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  return { ...env, ...extra }
}

const usable =(d: string | undefined): d is string => typeof d === 'string' && d.length > 1 && isAbsolute(d)

/** The directories one row can say a commit was made in: its main checkout, then the cwd it ran in. */
export function dirsOfRow(r: DirRow): string[] {
  return [r.repo?.rootPath, r.cwd].filter(usable)
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)]
}

/**
 * The repositories agentistics already knows, from its session records: `git_remote` → the directories
 * sessions of that repository ran in, and the same directories most-used first as the last resort.
 */
export function knownRepos(metas: Iterable<DirMeta>): { byRemote: Map<string, string[]>; ranked: string[] } {
  const count = new Map<string, number>()
  const byRemote = new Map<string, Map<string, number>>()
  for (const m of metas) {
    const dir = m.project_path
    if (!m.git_remote || !usable(dir)) continue
    count.set(dir, (count.get(dir) ?? 0) + 1)
    let per = byRemote.get(m.git_remote)
    if (!per) { per = new Map(); byRemote.set(m.git_remote, per) }
    per.set(dir, (per.get(dir) ?? 0) + 1)
  }
  const rank = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([d]) => d)
  return {
    byRemote: new Map([...byRemote].map(([k, v]) => [k, rank(v)])),
    ranked: rank(count).slice(0, MAX_FALLBACK_DIRS),
  }
}

/**
 * The clones to ask for each commit, from the pieces that named it. The rows of a task are looked up once per
 * task, not once per commit.
 */
export function dirsForShas(o: {
  pieces: ReadonlyMap<string, readonly { taskId: string; subtaskId: string | null; repo?: string }[]>
  rowsOf: (taskId: string) => readonly DirRow[]
  metas: Iterable<DirMeta>
  max?: number
}): (sha: string) => string[] {
  const known = knownRepos(o.metas)
  const rowsMemo = new Map<string, readonly DirRow[]>()
  const rowsOf = (id: string) => { let r = rowsMemo.get(id); if (!r) { r = o.rowsOf(id); rowsMemo.set(id, r) } return r }
  return sha => {
    const ps = o.pieces.get(sha) ?? []
    // every piece that named the commit contributes its own clones, best-placed first
    const lists = ps.map(p => candidateDirs({
      subtaskId: p.subtaskId, taskRows: rowsOf(p.taskId), taskRepo: p.repo, byRemote: known.byRemote, fallback: [], max: Infinity,
    }))
    return uniq([...lists.flat(), ...known.ranked]).slice(0, o.max ?? MAX_DIRS_PER_SHA)
  }
}

/** The ordered, deduplicated clones to ask for one piece (a subtask of a task, or the task itself). */
export function candidateDirs(o: {
  subtaskId: string | null
  /** Every session row filed on the task, subtask-filed ones included. */
  taskRows: readonly DirRow[]
  taskRepo?: string
  byRemote: ReadonlyMap<string, readonly string[]>
  fallback: readonly string[]
  max?: number
}): string[] {
  const ofSubtask = o.subtaskId === null ? [] : o.taskRows.filter(r => r.subtaskId === o.subtaskId)
  return uniq([
    ...ofSubtask.flatMap(dirsOfRow),
    ...o.taskRows.flatMap(dirsOfRow),
    ...(o.taskRepo ? (o.byRemote.get(o.taskRepo) ?? []) : []),
    ...o.fallback,
  ]).slice(0, o.max ?? MAX_DIRS_PER_SHA)
}
