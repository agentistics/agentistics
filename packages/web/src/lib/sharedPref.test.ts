import { afterEach, describe, expect, test } from 'bun:test'
import { createSharedPref, loadSharedPrefs, resetSharedPrefs, sameValue } from './sharedPref'

test('equal values compare equal even as different objects', () => {
  expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true)
  expect(sameValue({ x: 1 }, { x: 1 })).toBe(true)
})

test('a changed value compares unequal', () => {
  expect(sameValue(['a'], ['a', 'b'])).toBe(false)
  expect(sameValue({ x: 1 }, { x: 2 })).toBe(false)
})

test('order is a change — a reordered pin list must notify', () => {
  expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false)
})

test('absent and empty are different, so an unread pref never reads as a cleared one', () => {
  expect(sameValue(undefined, [])).toBe(false)
})

describe('a store registered AFTER loadSharedPrefs() has already landed', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    resetSharedPrefs()
  })

  test('still adopts the value the load already answered — no second GET, no visibilitychange needed', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(
      JSON.stringify({ lateKey: 'from-the-server' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))) as never

    await loadSharedPrefs()

    // The store below is created AFTER the load above has already landed — the exact shape of a
    // lazily-loaded chunk (e.g. idleSessionsPrefs.ts) whose module only runs once its page mounts.
    const store = createSharedPref<string>({
      key: 'sharedPref-test-late-key',
      prefKey: 'lateKey',
      fallback: 'the-fallback',
      parse: raw => (typeof raw === 'string' ? raw : null),
    })

    expect(store.get()).toBe('from-the-server')
  })

  test('resetSharedPrefs() also clears the remembered load, so a fresh store gets the fallback again', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(
      JSON.stringify({ lateKey: 'from-the-server' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))) as never

    await loadSharedPrefs()
    resetSharedPrefs()

    const store = createSharedPref<string>({
      key: 'sharedPref-test-late-key-2',
      prefKey: 'lateKey',
      fallback: 'the-fallback',
      parse: raw => (typeof raw === 'string' ? raw : null),
    })

    expect(store.get()).toBe('the-fallback')
  })
})
