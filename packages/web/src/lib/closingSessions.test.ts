import { afterEach, expect, test } from 'bun:test'
import { beginClosing, clearClosing, CLOSING_MAX_MS, isClosing, reconcileClosing, resetClosing } from './closingSessions'

afterEach(() => resetClosing())
const ENDED = new Set(['exited', 'closed'])

test('a second end request while pending is refused (no double kill)', () => {
  expect(beginClosing('a')).toBe(true)
  expect(beginClosing('a')).toBe(false)
  expect(isClosing('a')).toBe(true)
})

test('a failure restores the session', () => {
  beginClosing('a')
  clearClosing('a')
  expect(isClosing('a')).toBe(false)
  expect(beginClosing('a')).toBe(true)
})

test('the entry leaves when the row ends or disappears, and stays while it is still live', () => {
  beginClosing('a'); beginClosing('b'); beginClosing('c')
  reconcileClosing([{ id: 'a', state: 'waiting' }, { id: 'b', state: 'exited' }], ENDED)
  expect(isClosing('a')).toBe(true)
  expect(isClosing('b')).toBe(false)
  expect(isClosing('c')).toBe(false)
})

test('a lost update cannot dim a row forever', () => {
  beginClosing('a', 0)
  reconcileClosing([{ id: 'a', state: 'waiting' }], ENDED, CLOSING_MAX_MS + 1)
  expect(isClosing('a')).toBe(false)
})
