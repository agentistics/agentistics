import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { loadSharedPrefs, resetSharedPrefs, restoreSharedPrefs } from './sharedPref'

const originalFetch = globalThis.fetch
const originalStorage = (globalThis as { localStorage?: unknown }).localStorage
afterEach(() => {
  globalThis.fetch = originalFetch
  ;(globalThis as { localStorage?: unknown }).localStorage = originalStorage
  resetSharedPrefs()
})
afterAll(restoreSharedPrefs)
// Own preconditions: a file that ran earlier may have registered the app's real stores.
beforeEach(resetSharedPrefs)

test('flag OFF (never chosen) writes nothing to localStorage — not even a migrated marker', async () => {
  const written: string[] = []
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: (k: string) => { written.push(k) },
    removeItem: () => {},
  }
  globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'X-Prefs-Writable': 'true' } }))) as never
  const { sessionTabsStore } = await import(`./appFlags?${Math.random()}` as string)
  await loadSharedPrefs()
  expect(sessionTabsStore.get()).toBe(false)
  expect(written.filter(k => k.includes('session-tabs') || k.includes('sessionTabs'))).toEqual([])
})
