import { describe, expect, test } from 'bun:test'
import { clampWidth, dragWidth, fitContentWidth, hasCustomWidths, resolveWidths, tableMinWidth, MAX_COL_WIDTH, MIN_COL_WIDTH } from './columnWidths'

const cols = [{ id: 'cost', width: 88 }, { id: 'tokens', width: 84 }]

describe('columnWidths', () => {
  test('defaults when nothing is saved', () => expect(resolveWidths(cols, {})).toEqual({ cost: 88, tokens: 84 }))
  test('saved overrides default; junk ignored; unknown id ignored', () => {
    expect(resolveWidths(cols, { cost: 140, tokens: NaN, ghost: 9 })).toEqual({ cost: 140, tokens: 84 })
  })
  test('clamps', () => {
    expect(clampWidth(5)).toBe(MIN_COL_WIDTH)
    expect(clampWidth(9999)).toBe(MAX_COL_WIDTH)
    expect(clampWidth(NaN)).toBe(MIN_COL_WIDTH)
  })
  test('drag', () => {
    expect(dragWidth(100, 50, 80)).toBe(130)
    expect(dragWidth(100, 50, 80, true)).toBe(70)
    expect(dragWidth(100, 50, -500)).toBe(MIN_COL_WIDTH)
  })
  test('fit content takes the widest measure', () => {
    expect(fitContentWidth([80, 150, 120])).toBe(152)
    expect(fitContentWidth([])).toBe(MIN_COL_WIDTH)
  })
  test('custom detection and table width', () => {
    expect(hasCustomWidths({})).toBe(false)
    expect(hasCustomWidths({ cost: 100 })).toBe(true)
    expect(tableMinWidth(60, 240, { a: 100, b: 50 }, ['a', 'b'])).toBe(450)
  })
})
