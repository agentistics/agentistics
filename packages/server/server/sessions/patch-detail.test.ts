import { describe, expect, it } from 'bun:test'
import { isPatchTool, patchDetail, PATCH_DETAIL_MAX, PATCH_DETAIL_TOTAL_MAX } from './patch-detail'

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
  it('caps the whole output and says how many files were left out', () => {
    const many = '*** Begin Patch\n' + 'x'.repeat(PATCH_DETAIL_MAX + 10) + '\n'
      + Array.from({ length: 400 }, (_, n) => `*** Update File: packages/some/long/path/file-${n}.ts\n+a`).join('\n') + '\n*** End Patch'
    const out = patchDetail(many)!
    expect(out.length).toBeLessThanOrEqual(PATCH_DETAIL_TOTAL_MAX + 40)
    expect(out).toMatch(/… \+\d+ more files$/)
  })
  it('isPatchTool matches apply_patch and aliases only', () => {
    expect(isPatchTool('apply_patch')).toBe(true)
    expect(isPatchTool('ApplyPatch')).toBe(true)
    expect(isPatchTool('apply-patch')).toBe(true)
    expect(isPatchTool('write_file')).toBe(false)
  })
})
