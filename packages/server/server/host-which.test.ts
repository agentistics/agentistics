import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { hostWhich, hostWhichSearches, resetHostWhich, restoreHostWhich, setHostWhichForTests, WHICH_NEGATIVE_TTL_MS } from './host-which'
import { fido2ToolsPresent, resetFido2ToolsMemo } from './vault/service'

describe('hostWhich', () => {
  let files: Set<string>
  beforeEach(() => {
    files = new Set()
    resetHostWhich()
    setHostWhichForTests({
      search: (name, path) => { const p = path.split(':').map(d => `${d}/${name}`).find(c => files.has(c)); return p ?? null },
      exists: p => files.has(p),
    })
  })
  afterEach(() => restoreHostWhich())

  test('a miss is searched once within the TTL, then again after it', () => {
    for (let i = 0; i < 50; i++) expect(hostWhich('nope', { PATH: '/a:/b' }, 1000 + i)).toBeNull()
    expect(hostWhichSearches()).toBe(1)
    expect(hostWhich('nope', { PATH: '/a:/b' }, 1000 + WHICH_NEGATIVE_TTL_MS + 1)).toBeNull()
    expect(hostWhichSearches()).toBe(2)
  })

  test('a miss installed later is seen once the TTL passes', () => {
    expect(hostWhich('tool', { PATH: '/a' }, 0)).toBeNull()
    files.add('/a/tool')
    expect(hostWhich('tool', { PATH: '/a' }, 5)).toBeNull()
    expect(hostWhich('tool', { PATH: '/a' }, 5, )).toBeNull()
    expect(hostWhich('tool', { PATH: '/a', negativeTtlMs: 10 }, 100)).toBe('/a/tool')
  })

  test('a hit is remembered and re-searched when the file disappears', () => {
    files.add('/a/tool')
    expect(hostWhich('tool', { PATH: '/a:/b' })).toBe('/a/tool')
    expect(hostWhich('tool', { PATH: '/a:/b' })).toBe('/a/tool')
    expect(hostWhichSearches()).toBe(1)
    files.delete('/a/tool'); files.add('/b/tool')
    expect(hostWhich('tool', { PATH: '/a:/b' })).toBe('/b/tool')
    expect(hostWhichSearches()).toBe(2)
  })

  test('the PATH is part of the key', () => {
    files.add('/b/tool')
    expect(hostWhich('tool', { PATH: '/a' })).toBeNull()
    expect(hostWhich('tool', { PATH: '/b' })).toBe('/b/tool')
  })
})

describe('GET /api/vault offers', () => {
  test('100 fido2 probes search each tool at most once within the TTL', () => {
    resetHostWhich(); resetFido2ToolsMemo()
    const names: string[] = []
    setHostWhichForTests({ search: name => { names.push(name); return null }, exists: () => false })
    const prev = process.env.PATH
    process.env.PATH = '/nonexistent-slow-1:/nonexistent-slow-2'
    try {
      for (let i = 0; i < 100; i++) expect(fido2ToolsPresent()).toBe(false)
    } finally { process.env.PATH = prev; restoreHostWhich(); resetFido2ToolsMemo() }
    expect(names.length).toBeLessThanOrEqual(3)
    for (const n of new Set(names)) expect(names.filter(x => x === n).length).toBe(1)
  })
})
