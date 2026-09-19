import { expect, test } from 'bun:test'
import { shellAllowed, shellAllowedNow } from './shell-gate'

/**
 * A raw shell is strictly more powerful than the chat, which `chat-gate.ts` already calls the most
 * powerful thing this server does — the chat at least spawns a NAMED assistant CLI, while this
 * spawns whatever the person types. So it takes the same two gates.
 *
 * OWNER DECISION, 2026-09-14: Shell now ships ON BY DEFAULT — an absent preference reads as ON
 * (subject to `capable`), reversing the strict reading this file pinned before. The SECURITY gate
 * (`capable`) is exactly as strict as it always was; only the reading of an unset PREFERENCE
 * changed. See `shell-gate.ts`'s own header for the full reasoning.
 */

test('ABSENT READS AS ON when capable — Shell ships on by default', () => {
  expect(shellAllowed(true, undefined)).toBe(true)
})

test('an explicit no is a no — the opt-out is respected exactly as before', () => {
  expect(shellAllowed(true, false)).toBe(false)
})

test('capable and explicitly on is ON', () => {
  expect(shellAllowed(true, true)).toBe(true)
})

test('the preference may only ever NARROW the profile, never re-open it', () => {
  // A preference that could re-enable what `public` denied would be the opt-in restoring host power
  // on an exposed instance, which `exposure.ts` exists to make impossible — an absent preference
  // reading as ON must not become an absent PROFILE reading as capable.
  expect(shellAllowed(false, true)).toBe(false)
  expect(shellAllowed(false, undefined)).toBe(false)
  expect(shellAllowed(false, false)).toBe(false)
})

// Plant: the OLD strict rule (`preference === true`) — this must now FAIL, proving the reversal
// actually shipped rather than merely being asserted above.
test('plant: the old strict reading no longer matches this module\'s behaviour', () => {
  const oldStrictReading = (capable: boolean, preference: boolean | undefined) => capable && preference === true
  expect(shellAllowed(true, undefined)).not.toBe(oldStrictReading(true, undefined))
})

/**
 * shellAllowedNow — the "Enable now" override, checked in `shell-gate.test.ts` beside its own gate
 * because the whole point of the override is that it can NEVER let a disabled profile through.
 */

test('override lights the shell back up when only the PREFERENCE turned it off', () => {
  expect(shellAllowedNow(true, false, true)).toBe(true)
})

test('override true + capable false stays off — the profile is the one thing it may never bypass', () => {
  expect(shellAllowedNow(false, true, true)).toBe(false)
  expect(shellAllowedNow(false, undefined, true)).toBe(false)
  expect(shellAllowedNow(false, false, true)).toBe(false)
})

test('override absent (false) changes nothing — same answer as the plain gate', () => {
  expect(shellAllowedNow(true, undefined, false)).toBe(shellAllowed(true, undefined))
  expect(shellAllowedNow(true, false, false)).toBe(shellAllowed(true, false))
  expect(shellAllowedNow(true, true, false)).toBe(shellAllowed(true, true))
  expect(shellAllowedNow(false, true, false)).toBe(shellAllowed(false, true))
})

test('override never matters once the preference already says yes', () => {
  expect(shellAllowedNow(true, true, false)).toBe(true)
  expect(shellAllowedNow(true, undefined, false)).toBe(true)
})
