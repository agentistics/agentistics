import { expect, test } from 'bun:test'
import { EXIT_INSTANCE_HELD, isAddressInUse } from './service-exit'

test('the refusal code is its own number, distinct from a crash (1) and a signal (128+n)', () => {
  expect(EXIT_INSTANCE_HELD).toBe(75)
})

test('isAddressInUse reads the CODE, not only the message — Bun\'s message never says EADDRINUSE', () => {
  // Measured 2026-10-03 in the journal: `Failed to start server. Is port 47291 in use?` with
  // `code: "EADDRINUSE"`. The old check read only the message, missed it, rethrew, and the unit
  // exited 1 and was restarted again.
  const bunErr = Object.assign(new Error('Failed to start server. Is port 47291 in use?'), { code: 'EADDRINUSE' })
  expect(isAddressInUse(bunErr)).toBe(true)
  expect(isAddressInUse(new Error('listen EADDRINUSE: address already in use :::47291'))).toBe(true)
  expect(isAddressInUse(new Error('boom'))).toBe(false)
  expect(isAddressInUse('EADDRINUSE')).toBe(true)
  expect(isAddressInUse(undefined)).toBe(false)
})
