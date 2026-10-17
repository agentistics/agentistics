import { describe, expect, it } from 'bun:test'
import { patchDetail, PATCH_DETAIL_MAX } from './patch-detail'

const PATCH = '*** Begin Patch\n*** Update File: packages/a/src/x.ts\n@@\n-old\n+new\n*** Add File: packages/a/src/y.ts\n+hello\n*** Delete File: old.ts\n*** End Patch\n'

describe('patchDetail', () => {
  it('keeps a real-shaped patch whole', () => {
    expect(patchDetail(PATCH)).toBe(PATCH.trim())
  })
  it('is null for non-patches and non-strings', () => {
    expect(patchDetail('ls -la')).toBeNull()
    expect(patchDetail(undefined)).toBeNull()
  })
  it('bounds a big patch yet keeps every file header', () => {
    const big = '*** Begin Patch\n*** Update File: a.ts\n' + '+x\n'.repeat(5000) + '*** Update File: late/b.ts\n+y\n*** End Patch'
    const out = patchDetail(big)!
    expect(out.length).toBeLessThan(PATCH_DETAIL_MAX + 100)
    expect(out).toContain('*** Update File: a.ts')
    expect(out).toContain('*** Update File: late/b.ts')
  })
})
