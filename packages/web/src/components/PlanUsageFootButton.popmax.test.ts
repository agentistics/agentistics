import { describe, expect, test } from 'bun:test'
import { popMaxHeight } from './PlanUsageFootButton'

describe('popMaxHeight', () => {
  test('capped at 560 and fits short rooms', () => {
    expect(popMaxHeight(2000)).toBe(560)
    expect(popMaxHeight(400)).toBe(392)
    expect(popMaxHeight(50)).toBe(160)
  })
})
