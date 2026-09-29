import { describe, expect, test } from 'bun:test'
import { displayName, maskedText, toggleHidden } from './groupNameMask'

describe('maskedText', () => {
  test('one dot per letter within the clamp', () => {
    expect(maskedText('Pelvie')).toBe('••••••')
    expect(maskedText('Saved later')).toBe('•••••••••••')
  })
  test('a very short name is padded and a very long one capped, so the length is not printed', () => {
    expect(maskedText('A')).toBe('••••')
    expect(maskedText('  ')).toBe('••••')
    expect(maskedText('a name that goes on and on and on')).toBe('•'.repeat(12))
  })
  test('counts characters, not UTF-16 units', () => {
    expect(maskedText('日本語日本語')).toBe('••••••')
  })
})

describe('displayName', () => {
  test('the real name unless hidden', () => {
    expect(displayName('Pelvie', false)).toBe('Pelvie')
    expect(displayName('Pelvie', true)).toBe('••••••')
  })
})

describe('toggleHidden', () => {
  test('adds, removes, and never mutates its input', () => {
    const a = new Set<string>()
    const b = toggleHidden(a, 'g1')
    expect([...b]).toEqual(['g1'])
    expect(a.size).toBe(0)
    expect(toggleHidden(b, 'g1').size).toBe(0)
  })
})
