/**
 * WHERE releases are looked up, across the repository's move from `blpsoares/agentistics` to
 * `agentistics/agentistics`.
 *
 * The move is a GitHub transfer, and a transfer leaves a redirect behind — but only for as long as
 * nothing is created at the old name, and a redirect is a promise made by a third party. So every
 * lookup this binary makes names BOTH owners explicitly, the new one first:
 *
 * - before the transfer the new name answers 404 and the old one answers — nothing breaks the day
 *   this ships;
 * - after the transfer the new name answers directly and the old name is never reached;
 * - an install built BEFORE this module existed knows only the old name and depends on the
 *   redirect. That is why `blpsoares/agentistics` must never be re-created as a new repository:
 *   doing so would silently strand every such install on its current version.
 *
 * Pure except `fetchFirstOk`, which takes its `fetch` as a parameter so the fallback is testable.
 */

/** New owner first, legacy owner as the fallback. Order is the whole contract. */
export const RELEASE_REPOS = ['agentistics/agentistics', 'blpsoares/agentistics'] as const

/** The repository user-facing links point at. */
export const PRIMARY_REPO = RELEASE_REPOS[0]

/** The releases API list, per owner, in lookup order. */
export function releasesApiUrls(perPage = 30): string[] {
  return RELEASE_REPOS.map(r => `https://api.github.com/repos/${r}/releases?per_page=${perPage}`)
}

/** A version-addressed release asset, per owner, in lookup order. The tag is `v<version>`. */
export function releaseAssetUrls(version: string, asset: string): string[] {
  return RELEASE_REPOS.map(r => `https://github.com/${r}/releases/download/v${version}/${asset}`)
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Tries each URL in order and returns the first `ok` response. A network error or a non-ok status
 * moves on to the next URL; when every URL fails, the LAST outcome is reported (a response is
 * returned so the caller keeps its status-specific wording, an error is re-thrown).
 */
export async function fetchFirstOk(
  urls: readonly string[],
  init: RequestInit | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  if (urls.length === 0) throw new Error('no release URL to try')
  let last: Response | null = null
  let lastErr: unknown = null
  for (const url of urls) {
    try {
      const resp = await fetchImpl(url, init)
      if (resp.ok) return resp
      last = resp
      lastErr = null
    } catch (err) {
      lastErr = err
      last = null
    }
  }
  if (last) return last
  throw lastErr
}
