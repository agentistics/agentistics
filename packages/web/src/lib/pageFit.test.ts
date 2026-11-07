import { describe, expect, test } from 'bun:test'
import { fitHeight, holdPageFit, pageFitActive, reserveBelow } from './pageFit'

describe('pageFit', () => {
  test('HIGH 1: a board fills what is left of the page scroller, not the window — and never one pixel more', () => {
    // QA: window 800, board top 128, scroller bottom 785, content padding 24 -> room 633, minus 1 for rounding
    expect(fitHeight({ scrollerBottom: 785, boardTop: 128, reserve: 24, min: 360 })).toBe(632)
    // the old window arithmetic (innerHeight - top - 16 = 656) is 24 px taller than the room and scrolled the page
    expect(fitHeight({ scrollerBottom: 785, boardTop: 128, reserve: 24, min: 360 })).toBeLessThan(800 - 128 - 16)
    expect(fitHeight({ scrollerBottom: 785.9, boardTop: 128.2, reserve: 24, min: 360 })).toBe(632)
  })
  test('the reserve counts EVERY ancestor between the board and the scroller (frame 18 + page 24 + a border), not only the outer one', () => {
    expect(reserveBelow([{ paddingBottom: '18px', borderBottomWidth: '0px' }, { paddingBottom: '24px', borderBottomWidth: '1px' }])).toBe(43)
    expect(reserveBelow([])).toBe(0)
    expect(reserveBelow([{ paddingBottom: '', borderBottomWidth: 'medium' }])).toBe(0)
  })
  test('a tiny window keeps the minimum rather than collapsing the board', () => {
    expect(fitHeight({ scrollerBottom: 300, boardTop: 200, reserve: 24, min: 360 })).toBe(360)
  })
  test('holders are counted: the footer returns only when the LAST screen that fills the page lets go', () => {
    expect(pageFitActive()).toBe(false)
    const a = holdPageFit(), b = holdPageFit()
    expect(pageFitActive()).toBe(true)
    a(); a() // idempotent per holder
    expect(pageFitActive()).toBe(true)
    b()
    expect(pageFitActive()).toBe(false)
  })
})
