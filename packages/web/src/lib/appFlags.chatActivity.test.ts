import { afterEach, expect, test } from 'bun:test'
import { loadSharedPrefs, resetSharedPrefs } from './sharedPref'

const originalFetch = globalThis.fetch
const originalStorage = (globalThis as { localStorage?: unknown }).localStorage
afterEach(() => {
  globalThis.fetch = originalFetch
  ;(globalThis as { localStorage?: unknown }).localStorage = originalStorage
  resetSharedPrefs()
})

test('chatActivity OFF (never chosen) is false and writes nothing to localStorage', async () => {
  const written: string[] = []
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: (k: string) => { written.push(k) },
    removeItem: () => {},
  }
  globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'X-Prefs-Writable': 'true' } }))) as never
  const { chatActivityStore } = await import(`./appFlags?${Math.random()}` as string)
  await loadSharedPrefs()
  expect(chatActivityStore.get()).toBe(false)
  expect(written.filter(k => k.includes('chat-activity') || k.includes('chatActivity'))).toEqual([])
})
