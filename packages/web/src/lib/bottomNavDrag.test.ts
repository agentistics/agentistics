import { describe, expect, test } from 'bun:test'
import { followOffset, isDrag, restOffset, slotAt } from './bottomNavDrag'

describe('slotAt', () => {
  test('maps a position to its equal-width slot', () => {
    expect(slotAt(0, 500, 5)).toBe(0)
    expect(slotAt(99, 500, 5)).toBe(0)
    expect(slotAt(100, 500, 5)).toBe(1)
    expect(slotAt(499, 500, 5)).toBe(4)
  })
  test('an overshoot answers the nearest end slot', () => {
    expect(slotAt(-40, 500, 5)).toBe(0)
    expect(slotAt(620, 500, 5)).toBe(4)
  })
  test('a bar with no size or no slots never answers out of range', () => {
    expect(slotAt(10, 0, 5)).toBe(0)
    expect(slotAt(10, 500, 0)).toBe(0)
  })
})

describe('followOffset', () => {
  test('centres the indicator on the finger', () => {
    // slot 100, inset 4 → indicator 92 wide; centred on 250 → left 204
    expect(followOffset(250, 500, 5, 4)).toBe(204)
  })
  test('never leaves the bar', () => {
    expect(followOffset(0, 500, 5, 4)).toBe(4)
    expect(followOffset(500, 500, 5, 4)).toBe(500 - 4 - 92)
  })
  test('at rest and following agree at a slot centre', () => {
    for (let i = 0; i < 5; i++) expect(followOffset(i * 100 + 50, 500, 5, 4)).toBe(restOffset(i, 500, 5, 4))
  })
})

describe('isDrag', () => {
  test('a small wobble stays a tap', () => {
    expect(isDrag(3)).toBe(false)
    expect(isDrag(-5)).toBe(false)
  })
  test('past the threshold, either direction, is a drag', () => {
    expect(isDrag(6)).toBe(true)
    expect(isDrag(-20)).toBe(true)
  })
})
