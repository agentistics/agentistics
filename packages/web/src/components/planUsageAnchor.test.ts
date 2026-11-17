import { describe, expect, test } from 'bun:test'
import { anchorBeside } from './PlanUsageFootButton'

describe('anchorBeside — the plan-usage popover opens BESIDE its footer button, centred on the screen', () => {
  test('desktop: to the right of the button, inside the viewport, never wider than the popup', () => {
    const { left, width, sheet } = anchorBeside({ right: 200 }, 1280, 900)
    expect(sheet).toBe(false)
    expect(left).toBe(214) // button's right edge + caret gap
    expect(left).toBeGreaterThan(200)
    expect(width).toBe(364)
    expect(left + width).toBeLessThanOrEqual(1280 - 8)
  })

  test('a narrow desktop still keeps the popover on screen', () => {
    const { left, width } = anchorBeside({ right: 200 }, 640, 900)
    expect(left + width).toBeLessThanOrEqual(640 - 8)
    expect(width).toBeGreaterThan(0)
  })

  test('its height never outgrows the screen (the list inside scrolls), and is capped at 560', () => {
    expect(anchorBeside({ right: 200 }, 1280, 900).maxHeight).toBe(560)
    expect(anchorBeside({ right: 200 }, 1280, 400).maxHeight).toBe(392)
  })

  test('a 390px phone: a centred sheet 12px from each edge', () => {
    const { left, width, sheet } = anchorBeside({ right: 50 }, 390, 800)
    expect(sheet).toBe(true)
    expect(left).toBe(12)
    expect(left + width).toBe(390 - 12)
  })
})
