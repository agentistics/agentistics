/**
 * delivery/piece-proof-facts.ts — PURE. LIVE.COLUNAS-PRESAS C1: where the release proof looks for a review piece.
 *
 * `boardReviewPieces` read the piece's repositories ONLY from registry rows filed on it. The worker is closed after its
 * handback and its row leaves the registry, so on 2026-11-23 173 of 183 review/PR cards answered `repos: []` and the reconcile
 * stopped at "no repository is known" — never looking at the commits the handbacks declared, 46 of which a release already held.
 *
 * Other witnesses of where the work lives, strongest first, all FACTS (none decides publication — gh's PR facts still do):
 *   1. the registry rows (unchanged);
 *   2. the piece's own `provenance`, stamped at handback / kill while the worker was registered (`piece-provenance.ts`);
 *   3. the task's repository;
 *   4. the commits the newest handback declared that resolve in a product clone of this machine (a short id as people write it
 *      becomes the full one — `matchBatchPr` reads full ids only).
 * The commits found by 2 and 4 join the declared commits; when the handbacks named a "latest" statement, they join it too (they
 * ARE that statement's commits, resolved), so the latest-statement rule keeps its meaning.
 */
/** Structural copy of `batch-proof`'s DeclaredHead: zero imports on purpose (the store guard's inventory, `doors.lint.test.ts`). */
interface DeclaredHead { branch: string; sha: string; atMs?: number }

export interface PieceProofHints { branches: string[]; shas: string[]; heads?: DeclaredHead[]; prs?: number[]; latest?: string[] }

const SLUG = /^[\w.-]+\/[\w.-]+$/

/** PURE: a task's `repo` field as `owner/name`, from either shape it is stored in; null when it names no GitHub repository. */
export function taskRepoSlug(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().replace(/\.git$/, '')
  if (SLUG.test(v)) return v
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/]+\/[^/]+)$/i.exec(v)
  return m ? m[1]! : null
}

export function pieceProofFacts(o: {
  repos: readonly string[]
  hints: PieceProofHints
  provenance?: { repos: readonly string[]; commits: readonly string[] } | undefined
  taskRepo?: string | null | undefined
  declared?: ReadonlyArray<{ repo: string; full: string }>
}): { repos: string[]; hints: PieceProofHints } {
  const repos = new Set(o.repos)
  for (const r of o.provenance?.repos ?? []) if (SLUG.test(r)) repos.add(r)
  const task = taskRepoSlug(o.taskRepo)
  if (task) repos.add(task)
  const resolved = (o.declared ?? []).filter(d => /^[0-9a-f]{40}$/.test(d.full))
  for (const d of resolved) repos.add(d.repo)
  const extra = [...(o.provenance?.commits ?? []), ...resolved.map(d => d.full)].filter(s => /^[0-9a-f]{40}$/.test(s))
  const shas = [...new Set([...o.hints.shas, ...extra])]
  const hints: PieceProofHints = {
    ...o.hints, shas,
    ...(o.hints.latest ? { latest: [...new Set([...o.hints.latest, ...resolved.map(d => d.full)])] } : {}),
  }
  return { repos: [...repos], hints }
}
