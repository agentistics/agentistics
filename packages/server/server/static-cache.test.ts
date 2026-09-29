import { describe, expect, test } from 'bun:test'
import { cacheKind, etagMatches, etagOf, staticCacheControl } from './static-cache'

describe('cacheKind', () => {
  test('the shell is never cached', () => {
    for (const p of ['/index.html', '/sw.js', '/manifest.webmanifest', '/registerSW.js']) {
      expect(cacheKind(p)).toBe('shell')
      expect(staticCacheControl(p)).toContain('no-store')
    }
  })

  test('content-addressed files keep for a year', () => {
    for (const p of ['/assets/index-BkBQxu01.js', '/fonts/inter-400.woff2']) {
      expect(cacheKind(p)).toBe('immutable')
      expect(staticCacheControl(p)).toBe('public, max-age=31536000, immutable')
    }
  })

  test('icons, favicons and logos are revalidated, never pinned for a year', () => {
    for (const p of ['/icons/icon-192.png', '/icons/icon-512-maskable.png', '/favicon.ico', '/logo.png',
      '/logo-light.png', '/minimalistLogo.png', '/apple-touch-icon.png', '/harness/claude.svg']) {
      expect(cacheKind(p)).toBe('revalidate')
      expect(staticCacheControl(p)).toBe('no-cache')
      expect(staticCacheControl(p)).not.toContain('max-age')
    }
  })
})

describe('ETag', () => {
  test('the same bytes give the same tag and different bytes a different one', () => {
    expect(etagOf('abc')).toBe(etagOf('abc'))
    expect(etagOf('abc')).not.toBe(etagOf('abd'))
    expect(etagOf(new Uint8Array([1, 2, 3]))).toBe(etagOf(new Uint8Array([1, 2, 3])))
  })

  test('If-None-Match matches exactly, in a list, weakly, or as *', () => {
    const t = etagOf('x')
    expect(etagMatches(t, t)).toBe(true)
    expect(etagMatches(`"other", ${t}`, t)).toBe(true)
    expect(etagMatches(`W/${t}`, t)).toBe(true)
    expect(etagMatches('*', t)).toBe(true)
    expect(etagMatches('"other"', t)).toBe(false)
    expect(etagMatches(null, t)).toBe(false)
    expect(etagMatches('', t)).toBe(false)
  })
})
