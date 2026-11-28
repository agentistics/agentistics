/**
 * merged-prs.ts — "was this branch's pull request merged?" (DISCO.WORKTREES). Parsing and caching only;
 * the `gh` call and the cache file live in `clean-io.ts`.
 *
 * A squash merge of several commits leaves no ancestry and no patch-id twin, so git alone reads it as
 * unmerged. One `gh pr list --state merged` per repository per run answers it, cached for a day. No gh,
 * no login, no GitHub remote: UNKNOWN (null), never "none merged".
 */
export interface MergedPr { branch: string; oid: string }
export type MergedPrReader = (repo: string) => Promise<MergedPr[] | null>
export type MergedPrCache = Record<string, { at: number; prs: MergedPr[] }>

export const PR_CACHE_MS = 86_400_000

/** Pure. Anything that is not a JSON array is unknown. */
export function parseMergedPrs(text: string): MergedPr[] | null {
  let rows: unknown
  try { rows = JSON.parse(text) } catch { return null }
  if (!Array.isArray(rows)) return null
  return rows.flatMap(r => {
    const { headRefName, headRefOid } = (r ?? {}) as { headRefName?: unknown; headRefOid?: unknown }
    return typeof headRefName === 'string' && typeof headRefOid === 'string' ? [{ branch: headRefName, oid: headRefOid }] : []
  })
}

export function createMergedPrReader(o: {
  /** The `gh` JSON for one repository, or null when it cannot answer. */
  run: (repo: string) => Promise<string | null>
  load: () => Promise<MergedPrCache>
  save: (cache: MergedPrCache) => Promise<void>
  now?: () => number
}): MergedPrReader {
  const now = o.now ?? Date.now
  /** One answer per repository per process, failures included (never asked twice in one run). */
  const asked = new Map<string, { at: number; prs: Promise<MergedPr[] | null> }>()
  return repo => {
    const memo = asked.get(repo)
    if (memo && now() - memo.at < PR_CACHE_MS) return memo.prs
    const prs = (async () => {
      const hit = (await o.load())[repo]
      if (hit && Array.isArray(hit.prs) && now() - hit.at < PR_CACHE_MS) return hit.prs
      const text = await o.run(repo).catch(() => null)
      const fresh = text === null ? null : parseMergedPrs(text)
      if (fresh) await o.save({ ...(await o.load()), [repo]: { at: now(), prs: fresh } }).catch(() => {})
      return fresh
    })()
    asked.set(repo, { at: now(), prs })
    return prs
  }
}
