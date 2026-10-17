import { afterEach, expect, test } from 'bun:test'
import { loadSharedPrefs, resetSharedPrefs } from './sharedPref'

const originalFetch = globalThis.fetch
const originalStorage = (globalThis as { localStorage?: unknown }).localStorage
afterEach(() => {
  globalThis.fetch = originalFetch
  ;(globalThis as { localStorage?: unknown }).localStorage = originalStorage
  resetSharedPrefs()
})

test('a choice made while the server was unreachable survives a server that answers without the key', async () => {
  const store: Record<string, string> = { 'agentistics-session-tabs-on': '1' }
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }
  const puts: string[] = []
  globalThis.fetch = ((_u: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') puts.push(String(init.body))
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'X-Prefs-Writable': 'true' } }))
  }) as never
  const { sessionTabsStore } = await import(`./appFlags?${Math.random()}` as string)
  await loadSharedPrefs()
  expect(puts.some(b => b.includes('"sessionTabs":true'))).toBe(true)
})
