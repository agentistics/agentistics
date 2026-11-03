import { expect, test } from 'bun:test'
import { hasMeasurableSessions } from './tasks'

test('a task with no session at any level is not measurable — metrics are withheld', () => {
  expect(hasMeasurableSessions({ sessionsUsed: 0 })).toBe(false)
  expect(hasMeasurableSessions(null)).toBe(false)
  expect(hasMeasurableSessions(undefined)).toBe(false)
})

test('one filed session makes the task measurable, even if none could be priced', () => {
  expect(hasMeasurableSessions({ sessionsUsed: 1 })).toBe(true)
})
