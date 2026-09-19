import { describe, expect, test } from 'bun:test'
import { containedInRoot, resolveTreePath } from './editor-path'

describe('containedInRoot', () => {
  test('the root itself counts as contained', () => {
    expect(containedInRoot('/w', '/w')).toBe(true)
  })
  test('a child path is contained', () => {
    expect(containedInRoot('/w/a/b.ts', '/w')).toBe(true)
  })
  test('a sibling directory that merely shares a prefix is NOT contained', () => {
    // /w2 starts with the string "/w" but is not inside it.
    expect(containedInRoot('/w2/a.ts', '/w')).toBe(false)
  })
  test('a parent of root is not contained', () => {
    expect(containedInRoot('/', '/w')).toBe(false)
  })
})

describe('resolveTreePath', () => {
  test('an empty path names the root', () => {
    const r = resolveTreePath('/w', '')
    expect(r).toEqual({ ok: true, abs: '/w' })
  })
  test('a plain relative path resolves inside the root', () => {
    const r = resolveTreePath('/w', 'src/a.ts')
    expect(r).toEqual({ ok: true, abs: '/w/src/a.ts' })
  })
  test('.. is refused once it would leave the root', () => {
    const r = resolveTreePath('/w', '../etc/passwd')
    expect(r).toEqual({ ok: false, reason: 'escaped' })
  })
  test('.. that stays inside the root is fine', () => {
    const r = resolveTreePath('/w', 'a/../b.ts')
    expect(r).toEqual({ ok: true, abs: '/w/b.ts' })
  })
  test('an absolute path from the client is always refused — there is no route that accepts one', () => {
    const r = resolveTreePath('/w', '/etc/passwd')
    expect(r).toEqual({ ok: false, reason: 'escaped' })
  })
  test('whitespace around the path is trimmed before resolving', () => {
    const r = resolveTreePath('/w', '  src/a.ts  ')
    expect(r).toEqual({ ok: true, abs: '/w/src/a.ts' })
  })
})
