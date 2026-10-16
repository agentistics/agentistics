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

import { readFileSync } from 'node:fs'

describe('popover cards cannot widen their column', () => {
  const src = readFileSync(new URL('./SessionsGroupMenu.tsx', import.meta.url), 'utf8')
  test('every grid in the panel has an explicit minmax(0, 1fr) track', () => {
    // A bare `display: grid` sizes its single track to the widest nowrap label (long folder names
    // pushed the "Mostrar" buttons out of the popover).
    expect(src).toContain("gridTemplateColumns: 'minmax(0, 1fr)', gap: 2")
    expect(src).toContain("repeat(2, minmax(0, 1fr))")
  })
})
