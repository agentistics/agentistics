import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { brandAsset, versionedAsset, type BrandAsset } from './brand'

const PUBLIC = join(import.meta.dir, '..', '..', 'public')
const ASSETS: BrandAsset[] = ['/minimalistLogo.png', '/logo.png', '/logo-light.png']

describe('brand', () => {
  test('every mark is a file that exists', () => {
    for (const a of ASSETS) {
      expect(brandAsset(a)).toBe(a)
      expect(existsSync(join(PUBLIC, a))).toBe(true)
    }
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

  test('brandAsset carries the tag of the file', () => {
    g.__BRAND_TAGS__ = { '/logo.png': 'aaaa1111' }
    try {
      expect(brandAsset('/logo.png')).toBe('/logo.png?v=aaaa1111')
    } finally { delete g.__BRAND_TAGS__ }
  })
})
