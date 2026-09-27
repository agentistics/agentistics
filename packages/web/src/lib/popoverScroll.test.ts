import { describe, expect, test } from 'bun:test'
import { scrollIsOutside } from './popoverScroll'

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
