import { describe, expect, test } from 'bun:test'
import { clampSplitRatio, mainPaneWidth, parseSplitRatio, ratioFromWidth, SPLIT_MIN_PX } from './splitLayout'

describe('split widths', () => {
  test('each side keeps its minimum', () => {
    expect(mainPaneWidth(0.05, 1600)).toBe(SPLIT_MIN_PX)
    expect(mainPaneWidth(0.99, 1600)).toBe(1600 - SPLIT_MIN_PX)
    expect(mainPaneWidth(0.5, 1600)).toBe(800)
  })
  test('a row too narrow for two minimums splits evenly', () => {
    expect(clampSplitRatio(0.2, 700)).toBe(0.5)
  })
  test('a drag width becomes a ratio, clamped', () => {
    expect(ratioFromWidth(1000, 2000)).toBe(0.5)
    expect(ratioFromWidth(10, 2000)).toBe(SPLIT_MIN_PX / 2000)
  })
  test('a stored ratio is read defensively', () => {
    expect(parseSplitRatio('0.6')).toBe(0.6)
    expect(parseSplitRatio('nope')).toBe(0.5)
    expect(parseSplitRatio(null)).toBe(0.5)
    expect(parseSplitRatio('1.5')).toBe(0.5)
  })
})
