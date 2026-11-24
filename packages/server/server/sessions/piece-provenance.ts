/**
 * piece-provenance.ts — PURE. LIVE.COLUNAS-PRESAS, the FLOW side. Write onto a piece WHERE its work lives while its worker is
 * still registered, so proving the piece shipped never depends on the live session registry.
 *
 * Why: the release proof (`delivery/host.ts` `boardReviewPieces`) read a piece's repository only from registry rows filed on it.
 * `fechar-entregue` (and a leader's kill) end the worker right after its handback, the row leaves, and the piece is left with
 * `repos: []` — "no repository is known", never checked, never published (173 of 183 review cards on 2026-11-23).
 *
 * When: at the worker's handback (`session-message.ts`) and again just before a session is ended (`registry.ts`
 * `killAndRetireSession`, the one door every kill passes). The IO lives in `delivery/host.ts` (`stampProvenanceOfSession`);
 * this module decides only WHAT is stamped, with every fact handed in. A failure costs the stamp, never the handback or the kill.
 *
 * What (facts, never a verdict): the repository (`owner/name`, from the row's spawn record or the checkout's remote), the branch
 * the checkout stood on, and FULL commit ids — the branch tip when it is work the release line does not hold yet, plus every
 * commit the piece's handbacks declare that this checkout can resolve. The proof still decides with gh's facts; this only says
 * where to look. Zero imports on purpose: the store guard's inventory (`doors.lint.test.ts`) forbids a new module that writes
 * or reaches a writer.
 */

/** See the header. Stored on `Subtask.provenance`. */
export interface SubtaskProvenance { repos: string[]; branches: string[]; commits: string[]; at: string }

/** At most this many of each kind are kept (the newest win): a provenance is a pointer, not a history. */
export const MAX_PROVENANCE = 30
/** Branch names that are a release line, not a piece's own branch. */
const RELEASE_LINES = new Set(['HEAD', 'main', 'master', 'dev', 'develop'])
const FULL = /^[0-9a-f]{40}$/

export interface ProvenanceFacts { repos: readonly string[]; branches: readonly string[]; commits: readonly string[] }

/** PURE: the merged provenance, or null when `add` brings nothing new (no write is needed). */
export function mergeProvenance(prev: SubtaskProvenance | undefined, add: ProvenanceFacts, at: string): SubtaskProvenance | null {
  const merge = (a: readonly string[] = [], b: readonly string[]) => {
    const out = [...a.filter(x => !b.includes(x)), ...b.filter((x, i) => b.indexOf(x) === i)]
    return out.slice(-MAX_PROVENANCE)
  }
  const next = { repos: merge(prev?.repos, add.repos), branches: merge(prev?.branches, add.branches), commits: merge(prev?.commits, add.commits) }
  const same = (a: readonly string[] = [], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])
  if (prev && same(prev.repos, next.repos) && same(prev.branches, next.branches) && same(prev.commits, next.commits)) return null
  if (next.repos.length + next.branches.length + next.commits.length === 0) return null
  return { ...next, at }
}

export interface ProvenanceRow { id: string; subtaskId?: string | undefined; cwd?: string | undefined; repo?: { repo?: string | undefined } | undefined; role?: string | undefined }

export interface ProvenanceDeps {
  /** Whether the checkout directory still exists. */
  exists(cwd: string): boolean
  /** `git -C cwd …`, trimmed stdout ('' on success with no output), or null on any failure. */
  git(cwd: string, args: string[]): Promise<string | null>
  /** `owner/name` of the checkout's remote, or null. */
  repoOf(cwd: string): Promise<string | null>
  subtask(id: string): Promise<{ provenance?: SubtaskProvenance | undefined } | null>
  /** The bodies of the piece's handback comments, oldest first. */
  handbacks(subtaskId: string): Promise<string[]>
  /** The commit ids a statement DECLARES as delivered (the Live's own reading, `deliveredShasIn`). */
  declared(body: string): string[]
  write(subtaskId: string, provenance: SubtaskProvenance): Promise<void>
  now(): string
}

/** What one registered session can tell about its piece right now. Never throws. */
export async function provenanceOf(row: ProvenanceRow, deps: ProvenanceDeps): Promise<ProvenanceFacts> {
  const repos: string[] = []
  const branches: string[] = []
  const commits: string[] = []
  if (row.repo?.repo?.includes('/')) repos.push(row.repo.repo)
  const cwd = row.cwd
  if (cwd && deps.exists(cwd)) {
    if (repos.length === 0) { const r = await deps.repoOf(cwd).catch(() => null); if (r) repos.push(r) }
    const branch = await deps.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch && !RELEASE_LINES.has(branch)) branches.push(branch)
    // The tip counts only when it is the piece's own work: a checkout sitting on the release line holds nothing to prove.
    const head = await deps.git(cwd, ['rev-parse', 'HEAD'])
    if (head && FULL.test(head)) {
      const upstream = await deps.git(cwd, ['rev-parse', '--verify', '--quiet', 'origin/main'])
      const onLine = upstream ? (await deps.git(cwd, ['merge-base', '--is-ancestor', head, 'origin/main'])) !== null : false
      if (!onLine) commits.push(head)
    }
    // Every commit the piece's handbacks DECLARE (short, as people write them), resolved to its full id in this checkout.
    for (const body of row.subtaskId ? await deps.handbacks(row.subtaskId).catch(() => []) : []) {
      for (const sha of deps.declared(body)) {
        const full = await deps.git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
        if (full && FULL.test(full) && !commits.includes(full)) commits.push(full)
      }
    }
  }
  return { repos, branches, commits }
}

/** Stamp the row's piece. Leaders file no piece of their own here; a row with no subtask has nothing to stamp. Never throws. */
export async function recordPieceProvenance(row: ProvenanceRow, deps: ProvenanceDeps): Promise<SubtaskProvenance | null> {
  try {
    if (!row.subtaskId || row.role === 'leader') return null
    const sub = await deps.subtask(row.subtaskId)
    if (!sub) return null
    const next = mergeProvenance(sub.provenance, await provenanceOf(row, deps), deps.now())
    if (next) await deps.write(row.subtaskId, next)
    return next
  } catch { return null }
}
