import { test, expect } from 'bun:test'
import { chatAllowed } from './chat-gate'

test('owner decision 2026-09-29: an absent preference reads as ON where the profile allows chat', () => {
  expect(chatAllowed(true, undefined)).toBe(true)
})

test('turning it on works only where the capability already allows it', () => {
  expect(chatAllowed(true, true)).toBe(true)
})

test('a preference can NEVER re-enable what the exposure profile denied', () => {
  expect(chatAllowed(false, true)).toBe(false)
  expect(chatAllowed(false, undefined)).toBe(false)
  expect(chatAllowed(false, false)).toBe(false)
})

test('turning it off works even where the capability allows it', () => {
  expect(chatAllowed(true, false)).toBe(false)
})
