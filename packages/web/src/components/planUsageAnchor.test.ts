import { describe, expect, test } from 'bun:test'
import { anchorAbove } from './PlanUsageFootButton'

describe('anchorAbove — the plan-usage popover sits over its own button', () => {
  test('a button at the right end of a wide footer gets the popover over it, not at the left edge', () => {
    const btn = { left: 760, width: 60 }
    const { left, width, caretLeft } = anchorAbove(btn, 1440)
    expect(left).toBeGreaterThan(400)
    // The caret points at the button's centre.
    expect(left + caretLeft + 5).toBeCloseTo(btn.left + btn.width / 2, 0)
    expect(left + width).toBeLessThanOrEqual(1440 - 8)
  })

  test('near the right viewport edge it stays inside, and the caret still reaches the button', () => {
    const btn = { left: 1350, width: 40 }
    const { left, width, caretLeft } = anchorAbove(btn, 1400)
    expect(left + width).toBe(1400 - 8)
    expect(left + caretLeft + 5).toBeCloseTo(1370, 0)
  })

  test('near the left edge it starts at the margin', () => {
    const { left } = anchorAbove({ left: 10, width: 40 }, 1440)
    expect(left).toBe(8)
  })

  test('a 390px phone: the popover never exceeds the viewport', () => {
    const { left, width } = anchorAbove({ left: 320, width: 50 }, 390)
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + width).toBeLessThanOrEqual(390 - 8)
  })
})
