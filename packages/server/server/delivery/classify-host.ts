/**
 * delivery/classify-host.ts — the IO half of classification (spec §3.2): which checkout is the piece's, and what git says
 * about it. The pure verdict is `classify.ts`'s `classifyPiece`.
 *
 * The checkout is the `cwd` of the sessions filed under the piece (newest first); a worktree, a removed directory or a
 * folder that is not a repository is skipped. HEAD, `git status`, the release line and its merge-base are read on EVERY
 * call — the guard runs at every guarded move, and a commit, a dirty file or a moved base between two moves must be seen.
 * Only the diff is cached, by (repository, HEAD, merge-base, dirty hash): a pure function of exactly those.
 *
 * Paths are read NUL-delimited (`-z`) and verbatim: git quotes non-ASCII names in line mode (`"packages/web/\303\247.tsx"`),
 * which would not match `packages/web/` and silently turn a screen change into a code change. A rename or copy counts BOTH
 * sides — `src/a.ts → docs/a.md` removes code, it is not a documentation-only change.
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

/**
 * Paths out of `git status --porcelain -z` (v1). Each entry is `XY <path>\0`; a rename or copy (X or Y is R or C) is followed
 * by a second NUL-terminated token, the ORIGINAL path — both are returned. Names are verbatim (no unquoting, no trimming).
 */
export function parseStatusZ(text: string): string[] {
  const tok = text.split('\0')
  const out: string[] = []
  for (let i = 0; i < tok.length; i++) {
    const entry = tok[i]!
    if (entry.length < 4) continue
    out.push(entry.slice(3))
    if (/[RC]/.test(entry.slice(0, 2))) { const orig = tok[++i]; if (orig) out.push(orig) }
  }
  return out
}

/** Paths out of `git diff --name-status -z -M`: `S\0path\0` or, for R/C, `Sxxx\0old\0new\0` — both sides of a rename/copy. */
export function parseNameStatusZ(text: string): string[] {
  const tok = text.split('\0')
  const out: string[] = []
  for (let i = 0; i < tok.length;) {
    const st = tok[i++]!
    if (!st) continue
    const n = st[0] === 'R' || st[0] === 'C' ? 2 : 1
    for (let k = 0; k < n; k++) { const p = tok[i++]; if (p) out.push(p) }
  }
  return out
}

const diffCache = new Map<string, string[]>()
const DIFF_CACHE_MAX = 500
export function forgetClassifyCache(): void { diffCache.clear() }

const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** The release line this repository compares against, as a resolvable ref; null when none exists. */
export async function resolveBase(deps: Pick<ClassifyDeps, 'git'>, cwd: string): Promise<string | null> {
  for (const cand of RELEASE_LINES) {
    try { await deps.git(cwd, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]); return cand } catch { /* next */ }
  }
  return null
}

/** The merge-base of `base` and `head` (a full sha). Throws when git cannot say. */
export async function mergeBaseOf(deps: Pick<ClassifyDeps, 'git'>, cwd: string, base: string, head: string): Promise<string> {
  return (await deps.git(cwd, ['merge-base', base, head])).trim()
}

/** Paths changed between `mb` and `head` (renames/copies count both sides). Throws when git cannot say. */
export async function diffPathsBetween(deps: Pick<ClassifyDeps, 'git'>, cwd: string, mb: string, head: string): Promise<string[]> {
  return parseNameStatusZ(await deps.git(cwd, ['diff', '--name-status', '-z', '-M', '--no-color', `${mb}..${head}`]))
}

/** Paths changed between the merge-base of `base` and `head`, and `head`. Throws when git cannot say. */
export async function diffAgainstBase(deps: Pick<ClassifyDeps, 'git'>, cwd: string, base: string, head: string): Promise<string[]> {
  return diffPathsBetween(deps, cwd, await mergeBaseOf(deps, cwd, base, head), head)
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
      status = await deps.git(top, ['status', '--porcelain', '-z', '--untracked-files=all'])
    } catch { return { ...none, checkout: 'unreadable', everHadRepoCwd: true } }
    const dirtyPaths = parseStatusZ(status)
    // The release line is MUTABLE (a fetch, a force-update, a deleted ref): it is re-resolved on every call, and the cache key
    // carries the merge-base it produced, so a moved or vanished base can never be answered from a stale diff.
    const base = await resolveBase(deps, top)
    if (!base) return { checkout: 'base-unresolved', everHadRepoCwd: true, headSha: head, dirtyPaths, diffPaths: [] }
    let mb: string
    try { mb = await mergeBaseOf(deps, top, base, head) } catch { return { checkout: 'unreadable', everHadRepoCwd: true, headSha: head, dirtyPaths, diffPaths: [] } }
    const key = `${top}|${head}|${mb}|${digest(status)}`
    let diffPaths = diffCache.get(key)
    if (!diffPaths) {
      try { diffPaths = await diffPathsBetween(deps, top, mb, head) } catch { return { checkout: 'unreadable', everHadRepoCwd: true, headSha: head, dirtyPaths, diffPaths: [] } }
      if (diffCache.size >= DIFF_CACHE_MAX) diffCache.delete(diffCache.keys().next().value as string)
      diffCache.set(key, diffPaths)
    }
    return { checkout: 'resolved', everHadRepoCwd: true, headSha: head, dirtyPaths, diffPaths }
  }
  return { ...none, everHadRepoCwd: sawRepo }
}
