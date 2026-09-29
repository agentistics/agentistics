import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { brandAsset, isCentralShell, versionedAsset, type BrandAsset } from './brand'

const PUBLIC = join(import.meta.dir, '..', '..', 'public')
const ASSETS: BrandAsset[] = ['/minimalistLogo.png', '/logo.png', '/logo-light.png']

describe('brand', () => {
  test('a machine shows the amber marks unchanged', () => {
    for (const a of ASSETS) expect(brandAsset(a, false)).toBe(a)
  })
  test('a central shows a DIFFERENT file for every mark, and each one exists', () => {
    for (const a of ASSETS) {
      const c = brandAsset(a, true)
      expect(c).not.toBe(a)
      expect(existsSync(join(PUBLIC, c))).toBe(true)
    }
  })
  test('only data-central="1" reads as a central', () => {
    expect(isCentralShell({ dataset: { central: '1' } })).toBe(true)
    expect(isCentralShell({ dataset: {} })).toBe(false)
    expect(isCentralShell(null)).toBe(false)
  })
})

describe('versionedAsset', () => {
  const g = globalThis as { __BRAND_TAGS__?: Record<string, string> }
  test('appends the content tag when one is known, and only then', () => {
    g.__BRAND_TAGS__ = { '/logo.png': '3f9a1c02' }
    try {
      expect(versionedAsset('/logo.png')).toBe('/logo.png?v=3f9a1c02')
      expect(versionedAsset('/unlisted.png')).toBe('/unlisted.png')
    } finally { delete g.__BRAND_TAGS__ }
  })

  test('without tags (a test, a dev tool) the path is untouched', () => {
    expect(versionedAsset('/logo.png')).toBe('/logo.png')
  })

  test('brandAsset carries the tag of the file it actually picks', () => {
    g.__BRAND_TAGS__ = { '/logo.png': 'aaaa1111', '/logo-central.png': 'bbbb2222' }
    try {
      expect(brandAsset('/logo.png', false)).toBe('/logo.png?v=aaaa1111')
      expect(brandAsset('/logo.png', true)).toBe('/logo-central.png?v=bbbb2222')
    } finally { delete g.__BRAND_TAGS__ }
  })
})
