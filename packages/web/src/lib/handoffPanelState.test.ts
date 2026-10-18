import { expect, it } from 'bun:test'
import { handoffReminderDue } from './handoffPanelState'

it('reopens a collapsed warning at ten minutes, or at the requested +50k', () => {
  expect(handoffReminderDue(599_999, 0, null, 900_000)).toBe(false)
  expect(handoffReminderDue(600_000, 0, null, 250_000)).toBe(true)
  expect(handoffReminderDue(1_000, 0, 306_000, 305_999)).toBe(false)
  expect(handoffReminderDue(1_000, 0, 306_000, 306_000)).toBe(true)
  expect(handoffReminderDue(1_000, 0, 306_000, null)).toBe(false)
})
