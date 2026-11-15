import { describe, expect, test } from 'bun:test'
import { waitsForTaskList } from './taskListGate'

describe('the loader gate of the Agentask page', () => {
  test('every list view waits for the first answer', () => {
    for (const v of ['board', 'table', 'overview', 'calendar']) expect(waitsForTaskList(null, v)).toBe(true)
  })
  test('Live does not wait: it has its own read', () => {
    expect(waitsForTaskList(null, 'live')).toBe(false)
  })
  test('once the list is here nothing waits, an empty list included', () => {
    for (const v of ['board', 'live']) { expect(waitsForTaskList([], v)).toBe(false); expect(waitsForTaskList([{}], v)).toBe(false) }
  })
})
