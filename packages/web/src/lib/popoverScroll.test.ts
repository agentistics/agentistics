import { describe, expect, test } from 'bun:test'
import { USER_SCROLL_WINDOW_MS, scrollClosesPopover, scrollIsOutside } from './popoverScroll'

describe('scrollIsOutside', () => {
  test('a target inside the panel is not outside', () => {
    const target = {} as unknown as EventTarget
    const panel = { contains: (n: unknown) => n === target } as unknown as Node
    expect(scrollIsOutside(panel, target)).toBe(false)
  })

  test('a target outside the panel is outside', () => {
    const inside = {} as unknown as EventTarget
    const outside = {} as unknown as EventTarget
    const panel = { contains: (n: unknown) => n === inside } as unknown as Node
    expect(scrollIsOutside(panel, outside)).toBe(true)
  })

  test('a null panel is always outside — nothing to be inside of', () => {
    expect(scrollIsOutside(null, {} as unknown as EventTarget)).toBe(true)
  })

  test('a null target is outside — nothing scrolled inside the panel', () => {
    const panel = { contains: () => true } as unknown as Node
    expect(scrollIsOutside(panel, null)).toBe(true)
  })

  test('the document itself is outside the panel', () => {
    // The document is never a descendant of a portaled panel, so `contains` reports it as outside —
    // no real DOM needed, the fake simply never recognises the target as its own.
    const panel = { contains: () => false } as unknown as Node
    expect(scrollIsOutside(panel, {} as unknown as EventTarget)).toBe(true)
  })
})

describe('scrollClosesPopover (usage popup: only the person closes it)', () => {
  const inside = {} as unknown as EventTarget
  const outside = {} as unknown as EventTarget
  const panel = { contains: (n: unknown) => n === inside } as unknown as Node
  test('a conversation scrolling itself (a message arrived, no gesture) never closes it', () => {
    expect(scrollClosesPopover(panel, outside, null, 1_000)).toBe(false)
    expect(scrollClosesPopover(panel, outside, 1_000 - USER_SCROLL_WINDOW_MS - 1, 1_000)).toBe(false)
  })
  test('a scroll right after the person\'s own wheel/touch/key gesture closes it', () => {
    expect(scrollClosesPopover(panel, outside, 900, 1_000)).toBe(true)
  })
  test('the popup\'s own scrolling never closes it', () => {
    expect(scrollClosesPopover(panel, inside, 900, 1_000)).toBe(false)
  })
})
