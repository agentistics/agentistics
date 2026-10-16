import { beforeEach, describe, expect, test } from 'bun:test'
import { getOpenTabs, resetOpenTabsCache, setOpenTabs, SESSION_TABS_KEY, subscribeOpenTabs } from './sessionTabsStore'

const mem = new Map<string, string>()
let broken = false
beforeEach(() => {
  mem.clear(); broken = false; resetOpenTabsCache()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => { if (broken) throw new Error('blocked'); return mem.get(k) ?? null },
    setItem: (k: string, v: string) => { if (broken) throw new Error('blocked'); mem.set(k, v) },
  }
})

describe('sessionTabsStore', () => {
  test('a corrupt value reads as no tabs', () => {
    mem.set(SESSION_TABS_KEY, '{not json')
    expect(getOpenTabs('main')).toEqual([])
  })
  test('a non-array value reads as no tabs', () => {
    mem.set(SESSION_TABS_KEY, '{"a":1}')
    expect(getOpenTabs('main')).toEqual([])
  })
  test('blocked storage never throws on read or write', () => {
    broken = true
    expect(getOpenTabs('main')).toEqual([])
    expect(() => setOpenTabs('main', ['a'])).not.toThrow()
  })
  test('the main pane uses the bare key, the split pane its own', () => {
    setOpenTabs('main', ['a'])
    setOpenTabs('split', ['b'])
    expect(mem.get(SESSION_TABS_KEY)).toBe('["a"]')
    expect(mem.get(`${SESSION_TABS_KEY}:split`)).toBe('["b"]')
    resetOpenTabsCache()
    expect(getOpenTabs('main')).toEqual(['a'])
    expect(getOpenTabs('split')).toEqual(['b'])
  })
  test('subscribers hear a change, not a no-op write', () => {
    let n = 0
    const off = subscribeOpenTabs(() => { n++ })
    setOpenTabs('main', ['a'])
    setOpenTabs('main', ['a'])
    off()
    expect(n).toBe(1)
  })
})
