import { describe, expect, it } from 'bun:test'
import { tabStripEdgeFade, tabStripFadeMask } from './tabStripEdge'

describe('tabStripEdgeFade', () => {
  it('draws neither fade when everything fits (no overflow at all)', () => {
    expect(tabStripEdgeFade({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 })).toEqual({
      left: false, right: false,
    })
    // Reported narrower than the client width (rounding on some browsers) — still no overflow.
    expect(tabStripEdgeFade({ scrollLeft: 0, clientWidth: 400, scrollWidth: 390 })).toEqual({
      left: false, right: false,
    })
  })

  it('at the very start of an overflowing strip: only the right fades', () => {
    expect(tabStripEdgeFade({ scrollLeft: 0, clientWidth: 300, scrollWidth: 900 })).toEqual({
      left: false, right: true,
    })
  })

  it('scrolled into the middle: both edges fade', () => {
    expect(tabStripEdgeFade({ scrollLeft: 300, clientWidth: 300, scrollWidth: 900 })).toEqual({
      left: true, right: true,
    })
  })

  it('scrolled all the way to the end: only the left fades', () => {
    expect(tabStripEdgeFade({ scrollLeft: 600, clientWidth: 300, scrollWidth: 900 })).toEqual({
      left: true, right: false,
    })
  })

  it('absorbs sub-pixel positions at either end (EPSILON)', () => {
    // 0.5px short of the true end — still reads as "at the end", not "one more pixel to go".
    expect(tabStripEdgeFade({ scrollLeft: 599.5, clientWidth: 300, scrollWidth: 900 })).toEqual({
      left: true, right: false,
    })
    // 0.5px past zero — still reads as "at the start".
    expect(tabStripEdgeFade({ scrollLeft: 0.5, clientWidth: 300, scrollWidth: 900 })).toEqual({
      left: false, right: true,
    })
  })
})

describe('tabStripFadeMask', () => {
  it('is null when neither edge fades', () => {
    expect(tabStripFadeMask({ left: false, right: false })).toBeNull()
  })

  it('fades only the right edge at the start of an overflowing strip', () => {
    expect(tabStripFadeMask({ left: false, right: true })).toBe(
      'linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)',
    )
  })

  it('fades only the left edge at the end of an overflowing strip', () => {
    expect(tabStripFadeMask({ left: true, right: false })).toBe(
      'linear-gradient(to right, transparent 0, black 20px, black 100%)',
    )
  })

  it('fades both edges in the middle, and honors a custom fade width', () => {
    expect(tabStripFadeMask({ left: true, right: true }, 12)).toBe(
      'linear-gradient(to right, transparent 0, black 12px, black calc(100% - 12px), transparent 100%)',
    )
  })
})
