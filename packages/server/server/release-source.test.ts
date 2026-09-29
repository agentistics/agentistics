import { describe, expect, test } from 'bun:test'
import {
  PRIMARY_REPO, RELEASE_REPOS, fetchFirstOk, releaseAssetUrls, releasesApiUrls, type FetchLike,
} from './release-source.ts'
import { resolveUpgradeAsset } from './upgrade.ts'

const NEW = 'agentistics/agentistics'
const OLD = 'blpsoares/agentistics'

/** A GitHub that serves the repository under exactly the owners given, 404 everywhere else. */
function github(owners: string[], opts: { down?: string[] } = {}): { fetch: FetchLike; seen: string[] } {
  const seen: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    seen.push(url)
    const owner = [NEW, OLD].find(o => url.includes(`/${o}/`))
    if (owner && opts.down?.includes(owner)) throw new Error('network down')
    if (!owner || !owners.includes(owner)) return new Response('Not Found', { status: 404 })
    if (url.includes('api.github.com')) {
      return Response.json([{ tag_name: 'v9.9.9', draft: false, prerelease: false, body: '' }])
    }
    return new Response('binary', { status: 200 })
  }
  return { fetch: fetchImpl, seen }
}

describe('release lookups across the repository move', () => {
  test('the new owner is asked first and the legacy owner stays as the fallback', () => {
    expect(RELEASE_REPOS).toEqual([NEW, OLD])
    expect(PRIMARY_REPO).toBe(NEW)
    expect(releasesApiUrls(30)).toEqual([
      `https://api.github.com/repos/${NEW}/releases?per_page=30`,
      `https://api.github.com/repos/${OLD}/releases?per_page=30`,
    ])
  })

  // BEFORE the transfer: only the old owner exists. This build must keep upgrading.
  test('before the transfer: the new owner 404s and the version + asset come from the old one', async () => {
    const gh = github([OLD])
    const list = await fetchFirstOk(releasesApiUrls(), undefined, gh.fetch)
    expect(list.ok).toBe(true)
    expect(((await list.json()) as { tag_name: string }[])[0]!.tag_name).toBe('v9.9.9')

    const asset = resolveUpgradeAsset('linux', 'x64', '9.9.9')!
    const bin = await fetchFirstOk(asset.urls, undefined, gh.fetch)
    expect(bin.ok).toBe(true)
    expect(gh.seen.at(-1)).toBe(`https://github.com/${OLD}/releases/download/v9.9.9/agentop`)
  })

  // AFTER the transfer, with the redirect gone (e.g. the old name re-used): the new owner answers.
  test('after the transfer: the new owner answers and the old one is never reached', async () => {
    const gh = github([NEW])
    const list = await fetchFirstOk(releasesApiUrls(), undefined, gh.fetch)
    expect(list.ok).toBe(true)
    const bin = await fetchFirstOk(resolveUpgradeAsset('win32', 'x64', '9.9.9')!.urls, undefined, gh.fetch)
    expect(bin.ok).toBe(true)
    expect(gh.seen.some(u => u.includes(`/${OLD}/`))).toBe(false)
  })

  test('a network error on one owner falls through to the other', async () => {
    const gh = github([NEW, OLD], { down: [NEW] })
    const resp = await fetchFirstOk(releaseAssetUrls('9.9.9', 'agentop'), undefined, gh.fetch)
    expect(resp.ok).toBe(true)
    expect(gh.seen.at(-1)).toContain(`/${OLD}/`)
  })

  test('when no owner has it, the LAST status is returned so the caller can still say "404"', async () => {
    const resp = await fetchFirstOk(releaseAssetUrls('9.9.9', 'agentop'), undefined, github([]).fetch)
    expect(resp.status).toBe(404)
  })

  test('when every owner is unreachable, the error is thrown rather than read as "no update"', async () => {
    const gh = github([NEW, OLD], { down: [NEW, OLD] })
    await expect(fetchFirstOk(releasesApiUrls(), undefined, gh.fetch)).rejects.toThrow('network down')
  })
})
