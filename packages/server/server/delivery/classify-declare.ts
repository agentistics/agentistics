/**
 * delivery/classify-declare.ts — the leader's classification declaration (spec §3.2 "Leader declaration", review r2 N9).
 *
 * A piece stuck at `unknown` for a legitimate reason (session filed late, worktree already removed) can be classified by
 * its filed leader. The declaration names WHERE to look — a repository (path or remote) and a commit — NEVER the category:
 * the server re-runs the classification host against that repository and commit, which must exist and be reachable from a
 * remote branch. Authority (leader only, a worker is refused) lives in the service; this file is the verdict on the
 * facts, plus the health count.
 */
import { stat } from 'node:fs/promises'
import { normalizeGitRemote } from '@agentistics/core'
import { classifyPiece, type Classification } from './classify'
import { cwdsOfPiece, diffAgainstBase, resolveBase, type ClassifyDeps } from './classify-host'

export interface DeclarationInput { piece: { taskId: string; subtaskId?: string }; repo: string; head: string }
export interface DeclaredWhere { repo: string; head: string; category: string }
export type DeclareResult =
  | { ok: true; classification: Extract<Classification, { ok: true }>; declaration: DeclaredWhere }
  | { ok: false; code: 'declaration_invalid' | 'declaration_repo_unresolved' | 'declaration_commit_missing' | 'declaration_unpushed' | 'declaration_unclassifiable'; message: string; classification?: Classification }

const bad = (code: Extract<DeclareResult, { ok: false }>['code'], message: string): DeclareResult => ({ ok: false, code, message })

async function isDir(p: string): Promise<boolean> { try { return (await stat(p)).isDirectory() } catch { return false } }

/** A local directory as given, else the piece's own known checkouts whose `origin` is the named remote. */
export async function resolveRepoPath(deps: ClassifyDeps, input: DeclarationInput): Promise<string | null> {
  if (await isDir(input.repo)) {
    try { return (await deps.git(input.repo, ['rev-parse', '--show-toplevel'])).trim() } catch { return null }
  }
  const want = normalizeGitRemote(input.repo)
  if (!want) return null
  const rows = await deps.sessions()
  const known = [...new Set([...cwdsOfPiece(rows, input.piece), ...rows.filter(r => r.taskId === input.piece.taskId && r.rootPath).map(r => r.rootPath!)])]
  for (const dir of known) {
    try {
      const top = (await deps.git(dir, ['rev-parse', '--show-toplevel'])).trim()
      const url = (await deps.git(top, ['config', '--get', 'remote.origin.url'])).trim()
      if (normalizeGitRemote(url) === want) return top
    } catch { /* not a usable checkout */ }
  }
  return null
}

export async function declareClassification(deps: ClassifyDeps, input: DeclarationInput): Promise<DeclareResult> {
  if (typeof input.repo !== 'string' || !input.repo.trim()) return bad('declaration_invalid', 'a declaration needs --repo <path|remote>')
  if (typeof input.head !== 'string' || !/^[0-9a-f]{7,40}$/i.test(input.head.trim())) return bad('declaration_invalid', 'a declaration needs --head <sha> (7–40 hex characters)')
  const repo = await resolveRepoPath(deps, { ...input, repo: input.repo.trim() })
  if (!repo) return bad('declaration_repo_unresolved', `the repository "${input.repo}" could not be found here (give a path to a checkout, or a remote one of the piece's checkouts uses)`)
  let head: string
  try { head = (await deps.git(repo, ['rev-parse', '--verify', `${input.head.trim()}^{commit}`])).trim() } catch {
    return bad('declaration_commit_missing', `commit ${input.head} does not exist in ${input.repo}`)
  }
  let remotes = ''
  try { remotes = await deps.git(repo, ['branch', '-r', '--contains', head]) } catch { /* treated as unpushed */ }
  if (!remotes.trim()) return bad('declaration_unpushed', `commit ${head.slice(0, 7)} is not reachable from any remote branch — push it first`)
  const base = await resolveBase(deps, repo)
  if (!base) return bad('declaration_unclassifiable', 'no release line (origin/dev, origin/main, dev, main) found to compare against')
  let diffPaths: string[]
  try { diffPaths = await diffAgainstBase(deps, repo, base, head) } catch { return bad('declaration_unclassifiable', 'git could not compute the diff at that commit') }
  // A commit, not a working tree: nothing is uncommitted by construction. The category is DERIVED here, from the diff.
  const classification = classifyPiece({ checkout: 'resolved', everHadRepoCwd: true, headSha: head, dirtyPaths: [], diffPaths })
  if (!classification.ok) return { ok: false, code: 'declaration_unclassifiable', message: classification.message, classification }
  return { ok: true, classification, declaration: { repo: input.repo.trim(), head, category: classification.category } }
}

/**
 * The git facts `validateReport` needs for a `repoRef`: does `sha:path` exist, and is `sha` reachable from a remote branch?
 * The repository is found like a declaration's (a checkout path, or a remote one of the piece's checkouts uses).
 */
export async function repoRefFacts(deps: ClassifyDeps, piece: { taskId: string; subtaskId?: string }, ref: { repo: string; sha: string; path: string }): Promise<{ exists: boolean; reachableFromRemote: boolean }> {
  const repo = await resolveRepoPath(deps, { piece, repo: ref.repo, head: ref.sha })
  if (!repo) return { exists: false, reachableFromRemote: false }
  let exists = false
  try { await deps.git(repo, ['cat-file', '-e', `${ref.sha}:${ref.path}`]); exists = true } catch { /* missing */ }
  if (!exists) return { exists: false, reachableFromRemote: false }
  let remotes = ''
  try { remotes = await deps.git(repo, ['branch', '-r', '--contains', ref.sha]) } catch { /* unreachable */ }
  return { exists, reachableFromRemote: remotes.trim() !== '' }
}

/** Health: how many declarations exist, and by whom (`classification-declared`, by leader). */
export function classificationHealth(records: ReadonlyArray<{ classificationDeclared?: ReadonlyArray<{ by: string }> }>): { id: 'classification-declared'; count: number; byLeader: Record<string, number> } {
  const byLeader: Record<string, number> = {}
  let count = 0
  for (const r of records) for (const d of r.classificationDeclared ?? []) { count++; byLeader[d.by] = (byLeader[d.by] ?? 0) + 1 }
  return { id: 'classification-declared', count, byLeader }
}
