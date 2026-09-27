/**
 * string-cache.test.ts — the pure LRU behaviour of `StringCache` (A1.8), in isolation from
 * `journal.ts` and SQLite entirely.
 */
import { describe, expect, test } from 'bun:test'
import { StringCache } from './string-cache'

describe('StringCache — basic get/put', () => {
  test('a fresh cache misses everything', () => {
    const c = new StringCache(1024)
    expect(c.getId('a')).toBeUndefined()
    expect(c.getString(1)).toBeUndefined()
    expect(c.stats()).toEqual({ entries: 0, bytes: 0, maxBytes: 1024 })
  })

  test('put makes both directions resolve, and bytes/entries reflect it', () => {
    const c = new StringCache(1024)
    c.put('claude', 7)
    expect(c.getId('claude')).toBe(7)
    expect(c.getString(7)).toBe('claude')
    const s = c.stats()
    expect(s.entries).toBe(1)
    expect(s.bytes).toBeGreaterThan(0)
  })

  test('re-putting the same pair does not grow the cache', () => {
    const c = new StringCache(1024)
    c.put('claude', 7)
    const before = c.stats()
    c.put('claude', 7)
    c.put('claude', 7)
    expect(c.stats()).toEqual(before)
  })
})

describe('StringCache — budget 0 disables it outright', () => {
  test('put is a no-op and every get misses', () => {
    const c = new StringCache(0)
    c.put('claude', 7)
    expect(c.getId('claude')).toBeUndefined()
    expect(c.getString(7)).toBeUndefined()
    expect(c.stats()).toEqual({ entries: 0, bytes: 0, maxBytes: 0 })
  })

  test('a negative budget behaves exactly like 0', () => {
    const c = new StringCache(-100)
    c.put('claude', 7)
    expect(c.stats().entries).toBe(0)
  })
})

describe('StringCache — eviction keeps both directions consistent', () => {
  test('an evicted entry is gone from BOTH maps, never just one', () => {
    // Each entry costs byteLength('sNNN')*2 + 96 = 4*2+96 = 104 bytes (ids < 1000 keep the string
    // length constant here). A budget of 300 bytes holds at most 2 such entries.
    const c = new StringCache(300)
    c.put('s000', 0)
    c.put('s001', 1)
    c.put('s002', 2) // evicts s000 (least-recently-used)

    expect(c.getId('s000')).toBeUndefined()
    expect(c.getString(0)).toBeUndefined()
    expect(c.getId('s001')).toBe(1)
    expect(c.getString(1)).toBe('s001')
    expect(c.getId('s002')).toBe(2)
    expect(c.getString(2)).toBe('s002')
  })

  test('accessing an entry (either direction) protects it from the next eviction', () => {
    const c = new StringCache(300)
    c.put('s000', 0)
    c.put('s001', 1)
    // Touch s000 via getId, making s001 the least-recently-used one.
    expect(c.getId('s000')).toBe(0)
    c.put('s002', 2) // should evict s001, not s000
    expect(c.getId('s000')).toBe(0)
    expect(c.getString(0)).toBe('s000')
    expect(c.getId('s001')).toBeUndefined()
    expect(c.getString(1)).toBeUndefined()
  })

  test('touching by getString also protects the pair, from the OTHER direction', () => {
    const c = new StringCache(300)
    c.put('s000', 0)
    c.put('s001', 1)
    expect(c.getString(0)).toBe('s000') // touch s000 from the id->string side
    c.put('s002', 2) // should evict s001
    expect(c.getString(1)).toBeUndefined()
    expect(c.getId('s001')).toBeUndefined()
    expect(c.getString(0)).toBe('s000')
  })

  test('never exceeds its byte budget, even under many distinct entries', () => {
    const c = new StringCache(1000)
    for (let i = 0; i < 500; i++) c.put(`session-id-${i}`, i)
    const s = c.stats()
    expect(s.bytes).toBeLessThanOrEqual(1000)
    expect(s.entries).toBeLessThan(500)
  })

  test('a single entry larger than the whole budget is simply never retained', () => {
    const c = new StringCache(50)
    c.put('a-string-much-longer-than-the-budget-allows', 1)
    expect(c.stats()).toEqual({ entries: 0, bytes: 0, maxBytes: 50 })
    // Still resolvable — just not cached, which is a performance fact, not a correctness one.
    expect(c.getId('a-string-much-longer-than-the-budget-allows')).toBeUndefined()
  })

  test('a re-put of an evicted pair re-admits it (LRU, not a one-shot ban)', () => {
    const c = new StringCache(300)
    c.put('s000', 0)
    c.put('s001', 1)
    c.put('s002', 2) // evicts s000
    expect(c.getId('s000')).toBeUndefined()
    c.put('s000', 0) // re-admitted, evicting s001 this time
    expect(c.getId('s000')).toBe(0)
    expect(c.getId('s001')).toBeUndefined()
  })
})

describe('StringCache — an unbounded cache never evicts', () => {
  test('Infinity as the budget behaves like the old unbounded Maps', () => {
    const c = new StringCache(Number.POSITIVE_INFINITY)
    for (let i = 0; i < 5000; i++) c.put(`s${i}`, i)
    expect(c.stats().entries).toBe(5000)
    for (let i = 0; i < 5000; i++) {
      expect(c.getId(`s${i}`)).toBe(i)
      expect(c.getString(i)).toBe(`s${i}`)
    }
  })
})
