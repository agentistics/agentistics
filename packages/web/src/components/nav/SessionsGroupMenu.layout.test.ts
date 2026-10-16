import { describe, expect, test } from 'bun:test'
import { groupMenuLayout, TWO_COLUMN_MIN_WIDTH } from './SessionsGroupMenu'

describe('groupMenuLayout', () => {
  test('desktop with room is two columns', () => {
    expect(groupMenuLayout(1440, false)).toEqual({ width: 500, columns: 2 })
  })
  test('phone is one column and never wider than the viewport', () => {
    const l = groupMenuLayout(390, true)
    expect(l.columns).toBe(1)
    expect(l.width).toBeLessThanOrEqual(390 - 24)
  })
  test('narrow desktop window collapses to one column', () => {
    const l = groupMenuLayout(TWO_COLUMN_MIN_WIDTH + 23, false)
    expect(l.columns).toBe(1)
    expect(l.width).toBeLessThanOrEqual(TWO_COLUMN_MIN_WIDTH + 23 - 24)
  })
  test('two columns only when the width fits inside the viewport', () => {
    for (const w of [500, 540, 560, 700, 1024]) {
      const l = groupMenuLayout(w, false)
      expect(l.width).toBeLessThanOrEqual(w - 24)
    }
  })
})
