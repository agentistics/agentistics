import { afterEach, expect, test } from 'bun:test'
import { loadSharedPrefs, resetSharedPrefs } from './sharedPref'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; resetSharedPrefs() })

test('flag OFF (never chosen) writes nothing to localStorage — not even a migrated marker', async () => {
  const written: string[] = []
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: (k: string) => { written.push(k) },
    removeItem: () => {},
  }
  globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'X-Prefs-Writable': 'true' } }))) as never
  const { sessionTabsStore } = await import('./appFlags')
  await loadSharedPrefs()
  expect(sessionTabsStore.get()).toBe(false)
  expect(written.filter(k => k.includes('session-tabs') || k.includes('sessionTabs'))).toEqual([])
})
