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

function mockStorage(store: Record<string, string>) {
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }
}
const okEmpty = (puts: string[]) => ((_u: unknown, init?: RequestInit) => {
  if (init?.method === 'PUT') puts.push(String(init.body))
  return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'X-Prefs-Writable': 'true' } }))
}) as never

test('empty storage, tabs turned ON while offline, server later answers {} -> the choice is kept and uploaded', async () => {
  const store: Record<string, string> = {}
  mockStorage(store)
  const puts: string[] = []
  globalThis.fetch = (() => Promise.reject(new Error('offline'))) as never
  const { sessionTabsStore } = await import(`./appFlags?${Math.random()}` as string)
  sessionTabsStore.set(true)
  globalThis.fetch = okEmpty(puts)
  await loadSharedPrefs()
  expect(sessionTabsStore.get()).toBe(true)
  expect(store['agentistics-session-tabs-on']).toBe('1')
  expect(puts.some(b => b.includes('"sessionTabs":true'))).toBe(true)
})

test('flag OFF with nothing stored writes nothing to the server', async () => {
  mockStorage({})
  const puts: string[] = []
  globalThis.fetch = okEmpty(puts)
  const { sessionTabsStore } = await import(`./appFlags?${Math.random()}` as string)
  await loadSharedPrefs()
  expect(sessionTabsStore.get()).toBe(false)
  expect(puts).toEqual([])
})
