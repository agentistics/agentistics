import { describe, expect, test } from 'bun:test'
import { barFollow, barSlotAt, barSlots, followOffset, isDrag, restOffset, slotAt } from './bottomNavDrag'

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

describe('three-piece bar geometry', () => {
  const slots = barSlots(356, 34, 2, 2)
  test('two pills of two slots around a centre gap', () => {
    expect(slots.map(s => s.kind)).toEqual(['left', 'left', 'centre', 'right', 'right'])
    expect(slots[0]!.width).toBe(80.5)
    expect(slots[2]!.left).toBe(161)
    expect(slots[3]!.left).toBe(195)
    const padded = barSlots(356, 48, 2, 2, 4, 10)
    expect(padded[0]!.left).toBe(4)
    expect(padded[1]!.left + padded[1]!.width).toBe(154 - 10)
    expect(padded[3]!.left).toBe(154 + 48 + 10)
    expect(barSlots(0, 34, 2, 2)).toEqual([])
  })
  test('x resolves to its slot; the circle answers a little beyond its gap', () => {
    expect([10, 100, 175, 230, 340].map(x => barSlotAt(x, slots))).toEqual([0, 1, 2, 3, 4])
    expect(barSlotAt(150, slots)).toBe(2)
    expect(barSlotAt(-20, slots)).toBe(0)
    expect(barSlotAt(900, slots)).toBe(4)
  })
  test('the indicator follows the finger inside its own pill and never leaves it', () => {
    expect(barFollow(0, slots, 4)).toBe(4)
    expect(barFollow(120, slots, 4)).toBeCloseTo(120 - 72.5 / 2)
    expect(barFollow(352, slots, 4)).toBe(195 + 161 - 4 - 72.5)
  })
})
