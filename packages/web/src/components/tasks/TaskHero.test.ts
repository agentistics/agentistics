import { describe, expect, it } from 'bun:test'
import { ringLabelFontSize } from './TaskHero'

describe('task hero ring label', () => {
  it('keeps the percentage label small enough for the mobile ring', () => {
    expect(ringLabelFontSize(56)).toBeLessThanOrEqual(11)
  })

  it('scales the desktop label without exceeding the ring interior', () => {
    expect(ringLabelFontSize(68)).toBe(13.44)
  })
})
