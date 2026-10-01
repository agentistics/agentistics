import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createSharedPref, loadSharedPrefs, PERSONAL_PREFS, resetSharedPrefs, sameValue } from './sharedPref'

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

describe('a PERSONAL store (per account on a central, the machine file on a machine)', () => {
  const originalFetch = globalThis.fetch
  const g = globalThis as unknown as { localStorage?: unknown }
  let savedLS: unknown
  const ls = new Map<string, string>()
  type Call = { url: string; method: string; body?: string }
  let calls: Call[] = []

  const serve = (docs: Record<string, Record<string, unknown> | number>) => {
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
      if (init?.method === 'PUT') return Promise.resolve(new Response('{}', { status: 200 }))
      const doc = docs[url]
      if (typeof doc === 'number') return Promise.resolve(new Response('{}', { status: doc }))
      return Promise.resolve(new Response(JSON.stringify(doc ?? {}), { status: 200 }))
    }) as never
  }

  beforeEach(() => {
    calls = []
    ls.clear()
    savedLS = g.localStorage
    g.localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v) } }
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    g.localStorage = savedLS
    resetSharedPrefs()
  })

  const make = (key: string, migrate = false) => createSharedPref<{ cols: string[] }>({
    key, prefKey: 'taskBoard', endpoint: PERSONAL_PREFS, fallback: { cols: [] },
    parse: raw => (raw && typeof raw === 'object' && Array.isArray((raw as { cols?: unknown }).cols)
      ? raw as { cols: string[] } : null),
    adoptLocalWhenAbsent: migrate,
  })

  test('reads and writes ITS endpoint, never /api/preferences', async () => {
    serve({ '/api/preferences': { taskBoard: { cols: ['wrong'] } }, [PERSONAL_PREFS]: { taskBoard: { cols: ['a'] } } })
    const store = make('sp-personal-1')
    await loadSharedPrefs()
    expect(store.get()).toEqual({ cols: ['a'] })
    store.set({ cols: ['b'] })
    const put = calls.find(c => c.method === 'PUT')!
    expect(put.url).toBe(PERSONAL_PREFS)
    expect(JSON.parse(put.body!)).toEqual({ taskBoard: { cols: ['b'] } })
  })

  test('the old browser value is written up ONCE when the server has nothing yet', async () => {
    ls.set('sp-personal-2', JSON.stringify({ cols: ['model', 'status'] }))
    serve({ [PERSONAL_PREFS]: {} })
    const store = make('sp-personal-2', true)
    await loadSharedPrefs()
    expect(store.get()).toEqual({ cols: ['model', 'status'] })
    const puts = calls.filter(c => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(JSON.parse(puts[0]!.body!)).toEqual({ taskBoard: { cols: ['model', 'status'] } })
    await loadSharedPrefs()
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1)
  })

  test('without the opt-in an absent server value resets to the fallback (the older stores)', async () => {
    ls.set('sp-personal-3', JSON.stringify({ cols: ['x'] }))
    serve({ [PERSONAL_PREFS]: {} })
    const store = make('sp-personal-3', false)
    await loadSharedPrefs()
    expect(store.get()).toEqual({ cols: [] })
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0)
  })

  test('the server value wins over the browser copy when both exist', async () => {
    ls.set('sp-personal-4', JSON.stringify({ cols: ['local'] }))
    serve({ [PERSONAL_PREFS]: { taskBoard: { cols: ['server'] } } })
    const store = make('sp-personal-4', true)
    await loadSharedPrefs()
    expect(store.get()).toEqual({ cols: ['server'] })
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0)
  })

  test('a refused personal endpoint stays UNARMED even when /api/preferences answered', async () => {
    serve({ '/api/preferences': {}, [PERSONAL_PREFS]: 401 })
    const store = make('sp-personal-5', true)
    await loadSharedPrefs()
    store.set({ cols: ['c'] })
    expect(store.get()).toEqual({ cols: ['c'] })
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0)
  })

  test('a store born after the first load reads its endpoint by itself', async () => {
    serve({ '/api/preferences': {}, [PERSONAL_PREFS]: { taskBoard: { cols: ['late'] } } })
    await loadSharedPrefs()
    const store = make('sp-personal-6')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    expect(store.get()).toEqual({ cols: ['late'] })
  })
})
