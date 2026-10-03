import { describe, expect, test } from 'bun:test'
import { bundleAssetsToWipe, VAULT_BUNDLE_ASSET, wipeBundleHistory } from './vault-bundle-github'

const rel = (id: number, tag: string, withBundle = true) => ({ id, tag_name: tag, assets: [{ id: id * 10, name: 'agentistics-backup.tar.zst', size: 1, state: 'uploaded' }, ...(withBundle ? [{ id: id * 10 + 1, name: VAULT_BUNDLE_ASSET, size: 1, state: 'uploaded' }] : [])] })
const releases = [
  rel(1, 'backup-laptop-2026-10-01T10-00-00-000Z'),
  rel(2, 'backup-laptop-2026-10-02T10-00-00-000Z'),
  rel(3, 'backup-laptop-2026-10-03T10-00-00-000Z'),
  rel(4, 'backup-desktop-2026-10-02T10-00-00-000Z'),
  rel(5, 'my-own-release'),
]

describe('erasing the vault history in the GitHub backup', () => {
  test('only THIS machine\'s older bundles; never the newest, never another machine, never a foreign release', () => {
    expect(bundleAssetsToWipe(releases, 'backup-laptop-2026-10-03T10-00-00-000Z', 'laptop')).toEqual([
      { releaseTag: 'backup-laptop-2026-10-01T10-00-00-000Z', assetId: 11 },
      { releaseTag: 'backup-laptop-2026-10-02T10-00-00-000Z', assetId: 21 },
    ])
  })
  test('deletes those assets — the archives stay', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`)
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(releases), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(null, { status: 204 })
    }) as never
    const r = await wipeBundleHistory({ owner: 'o', repo: 'r', token: 't', keepTag: 'backup-laptop-2026-10-03T10-00-00-000Z', label: 'laptop', fetchImpl, log: () => {} })
    expect(r).toEqual({ ok: true, deleted: 2, failed: 0 })
    expect(calls.filter(c => c.startsWith('DELETE'))).toEqual(['DELETE /repos/o/r/releases/assets/11', 'DELETE /repos/o/r/releases/assets/21'])
  })
})

describe('on demand', () => {
  test('with no "this upload", the newest bundle of this machine is kept', () => {
    expect(bundleAssetsToWipe(releases, null, 'laptop').map(x => x.assetId)).toEqual([11, 21])
  })
})
