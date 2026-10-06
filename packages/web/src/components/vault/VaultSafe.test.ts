import { describe, expect, test } from 'bun:test'
import { angleOf } from './VaultSafe'

describe('angleOf — the dial angle read off a computed transform (the ease-back after a failed unlock)', () => {
  test('reads a rotation matrix in degrees, both directions', () => {
    const m = (deg: number) => { const r = deg * Math.PI / 180; return `matrix(${Math.cos(r)}, ${Math.sin(r)}, ${-Math.sin(r)}, ${Math.cos(r)}, 0, 0)` }
    expect(angleOf(m(40))).toBe(40)
    expect(angleOf(m(-55))).toBe(-55)
  })
  test('no transform, or anything unreadable, is at rest (0) — never NaN', () => {
    expect(angleOf('none')).toBe(0)
    expect(angleOf('')).toBe(0)
    expect(angleOf('matrix(x, y')).toBe(0)
  })
})
