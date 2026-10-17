import { describe, expect, it } from 'bun:test'
import { BoundedKeys } from './bounded-keys'

describe('BoundedKeys (CROSSBIND MED-3)', () => {
  it('never holds more than its cap, evicting the oldest', () => {
    const k = new BoundedKeys(3)
    for (let i = 0; i < 10; i++) k.add(`k${i}`)
    expect(k.size).toBe(3)
    expect(k.has('k0')).toBe(false)
    expect(k.has('k9')).toBe(true)
  })
  it('says whether a key is new, and a re-added key survives eviction', () => {
    const k = new BoundedKeys(2)
    expect(k.add('a')).toBe(true)
    expect(k.add('a')).toBe(false)
    k.add('b'); k.add('a'); k.add('c')
    expect(k.has('a')).toBe(true)
    expect(k.has('b')).toBe(false)
  })
  it('drops the keys of a session that left', () => {
    const k = new BoundedKeys(10)
    k.add('s1\0x'); k.add('s2\0x')
    k.dropWhere(key => key.startsWith('s1\0'))
    expect(k.has('s1\0x')).toBe(false)
    expect(k.has('s2\0x')).toBe(true)
  })
})
