/**
 * delivery/classify-host.ts — the IO half of classification (spec §3.2): which checkout is the piece's, and what git says
 * about it. The pure verdict is `classify.ts`'s `classifyPiece`.
 *
 * The checkout is the `cwd` of the sessions filed under the piece (newest first); a worktree, a removed directory or a
 * folder that is not a repository is skipped. HEAD and `git status --porcelain` are read on EVERY call — the guard runs
 * at every guarded move, and a commit or a dirty file between two moves must be seen. Only the diff against the release
 * line's merge-base is cached, by (repository, HEAD, dirty hash): the one expensive read, and a pure function of those.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { ClassifyFacts } from './classify'
import { gitSpawnEnv } from './git-env'

/** The slice of a session row the classification reads (structurally a subset of the gates' `SessionFact`). */
export interface ClassifySession { id: string; cwd: string; taskId?: string; subtaskId?: string; createdAt?: string; rootPath?: string }
export interface ClassifyDeps {
  sessions(): Promise<ClassifySession[]>
  git(cwd: string, args: string[]): Promise<string>
}

export const RELEASE_LINES = ['origin/dev', 'origin/main', 'dev', 'main'] as const

export function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Never inherit GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE (set inside a git hook): `-C cwd` must be what decides the repository.
    execFile('git', ['-C', cwd, ...args], { cwd, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: gitSpawnEnv() }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

/** The rows filed under the piece (a task-level piece = rows with no subtask), newest first, unique cwds, non-empty. */
export function cwdsOfPiece(rows: readonly ClassifySession[], piece: { taskId: string; subtaskId?: string }): string[] {
  const own = rows.filter(r => r.cwd && r.taskId === piece.taskId && (piece.subtaskId === undefined ? !r.subtaskId : r.subtaskId === piece.subtaskId))
  const sorted = [...own].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') || 0)
  return [...new Set(sorted.map(r => r.cwd))]
}

/** Paths out of `git status --porcelain` (v1): renames report the destination, quoted names are unquoted. */
export function parsePorcelain(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.length < 4) continue
    let p = line.slice(3)
    const arrow = p.indexOf(' -> ')
    if (arrow !== -1) p = p.slice(arrow + 4)
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
    out.push(p)
  }
  return out
}

const diffCache = new Map<string, string[]>()
const DIFF_CACHE_MAX = 500
export function forgetClassifyCache(): void { diffCache.clear() }

const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean)
const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** The release line this repository compares against, as a resolvable ref; null when none exists. */
export async function resolveBase(deps: Pick<ClassifyDeps, 'git'>, cwd: string): Promise<string | null> {
  for (const cand of RELEASE_LINES) {
    try { await deps.git(cwd, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]); return cand } catch { /* next */ }
  }
  return null
}

/** Paths changed between the merge-base of `base` and `head`, and `head`. Throws when git cannot say. */
export async function diffAgainstBase(deps: Pick<ClassifyDeps, 'git'>, cwd: string, base: string, head: string): Promise<string[]> {
  const mb = (await deps.git(cwd, ['merge-base', base, head])).trim()
  return lines(await deps.git(cwd, ['diff', '--name-only', `${mb}..${head}`]))
}

export async function gatherFacts(deps: ClassifyDeps, piece: { taskId: string; subtaskId?: string }): Promise<ClassifyFacts> {
  const rows = await deps.sessions()
  const own = rows.filter(r => r.taskId === piece.taskId && (piece.subtaskId === undefined ? !r.subtaskId : r.subtaskId === piece.subtaskId))
  const cwds = cwdsOfPiece(rows, piece)
  const none: ClassifyFacts = { checkout: 'none', everHadRepoCwd: own.some(r => !!r.rootPath), headSha: null, dirtyPaths: [], diffPaths: [] }
  let sawRepo = none.everHadRepoCwd
  for (const cwd of cwds) {
    let top: string
    try { top = (await deps.git(cwd, ['rev-parse', '--show-toplevel'])).trim() } catch { continue } // gone, or not a repository
    sawRepo = true
    let head: string; let status: string
    try {
      head = (await deps.git(top, ['rev-parse', 'HEAD'])).trim()
      status = await deps.git(top, ['status', '--porcelain'])
    } catch { return { ...none, checkout: 'unreadable', everHadRepoCwd: true } }
    const dirtyPaths = parsePorcelain(status)
    const key = `${top}|${head}|${digest(status)}`
    let diffPaths = diffCache.get(key)
    if (!diffPaths) {
      const base = await resolveBase(deps, top)
      if (!base) return { checkout: 'base-unresolved', everHadRepoCwd: true, headSha: head, dirtyPaths, diffPaths: [] }
      try { diffPaths = await diffAgainstBase(deps, top, base, head) } catch { return { checkout: 'unreadable', everHadRepoCwd: true, headSha: head, dirtyPaths, diffPaths: [] } }
      if (diffCache.size >= DIFF_CACHE_MAX) diffCache.delete(diffCache.keys().next().value as string)
      diffCache.set(key, diffPaths)
    }
    return { checkout: 'resolved', everHadRepoCwd: true, headSha: head, dirtyPaths, diffPaths }
  }
  return { ...none, everHadRepoCwd: sawRepo }
}
