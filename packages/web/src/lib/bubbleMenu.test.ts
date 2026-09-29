import { expect, test } from 'bun:test'
import { bubbleMenuHeight, bubbleMenuTop } from './bubbleMenu'

test('opens downwards when there is room above the floor', () => {
  expect(bubbleMenuTop({ localY: 30, anchorViewportY: 200, menuHeight: 184, floor: 700 })).toBe(30)
})
test('opens upwards over the composer', () => {
  expect(bubbleMenuTop({ localY: 30, anchorViewportY: 600, menuHeight: 184, floor: 700 })).toBe(30 - 184 - 4)
})
test('never above the viewport top', () => {
  // anchor 100px from the top, menu 184 tall, no room below either: clamp at the viewport's top + gap
  expect(bubbleMenuTop({ localY: 50, anchorViewportY: 100, menuHeight: 184, floor: 200 })).toBe(50 - 100 + 4)
})
test('row heights follow the mobile rule', () => {
  expect(bubbleMenuHeight(4, true)).toBe(184)
  expect(bubbleMenuHeight(4, false)).toBe(144)
})
