import { beforeEach, describe, expect, test } from 'bun:test'
import { nextSeen, planWhatsNew } from './select'
import type { ReleaseNotes } from './releases'

const L = (s: string) => ({ pt: s, en: s })
const n = (f: string[]): ReleaseNotes => ({ features: f.map(L), fixes: [] })
const T = { '2.1.0': n(['a']), '2.2.0': n(['b']) }

describe('nextSeen — only moves forward', () => {
  test('first install records the running version', () => expect(nextSeen('2.2.0', '')).toBe('2.2.0'))
  test('an older seen version advances', () => expect(nextSeen('2.2.0', '2.1.0')).toBe('2.2.0'))
  test('same version writes nothing', () => expect(nextSeen('2.2.0', '2.2.0')).toBeNull())
  test('a downgrade never rewinds what other devices saw', () => expect(nextSeen('2.1.0', '2.2.0')).toBeNull())
  test('no bundle version writes nothing', () => expect(nextSeen('', '2.2.0')).toBeNull())
})

describe('announce decision', () => {
  test('server value wins: seen 2.1.0 on the server announces 2.2.0', () => {
    expect(planWhatsNew({ current: '2.2.0', seen: '2.1.0', table: T })?.entries.map(e => e.version)).toEqual(['2.2.0'])
  })
  test('already seen on another device: nothing', () => {
    expect(planWhatsNew({ current: '2.2.0', seen: '2.2.0', table: T })).toBeNull()
  })
  test('first install announces nothing', () => {
    expect(planWhatsNew({ current: '2.2.0', seen: '', table: T })).toBeNull()
  })
  test('downgrade announces nothing', () => {
    expect(planWhatsNew({ current: '2.1.0', seen: '2.2.0', table: T })).toBeNull()
  })
})

// The store itself: server value wins, localStorage migrates up once, nothing anywhere stays empty.
describe('seenStore', () => {
  const mem = new Map<string, string>()
  const puts: unknown[] = []
  const fetchMock = (doc: Record<string, unknown>) => (async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PUT') { puts.push(JSON.parse(init.body!)); return new Response('{}') }
    return new Response(JSON.stringify(doc), { headers: { 'X-Prefs-Writable': 'true' } })
  }) as unknown as typeof fetch

  beforeEach(async () => {
    mem.clear(); puts.length = 0
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) },
    } as Storage
    const { resetSharedPrefs } = await import('../lib/sharedPref')
    resetSharedPrefs()
  })

  async function fresh(doc: Record<string, unknown>) {
    globalThis.fetch = fetchMock(doc)
    const m = await import('./seen?' + Math.random())
    return m.settleWhatsNew
  }

  test('server value wins over the browser copy', async () => {
    mem.set('ag-whats-new-seen', '2.0.0')
    const settle = await fresh({ whatsNewSeen: '2.1.0' })
    expect((await settle('2.2.0', T))?.from).toBe('2.1.0')
  })

  test('migrates the browser value up when the server has none', async () => {
    mem.set('ag-whats-new-seen', '2.1.0')
    const settle = await fresh({})
    expect((await settle('2.2.0', T))?.from).toBe('2.1.0')
    expect(puts.some(p => (p as Record<string, unknown>).whatsNewSeen === '2.1.0' || (p as Record<string, unknown>).whatsNewSeen === '2.2.0')).toBe(true)
  })

  test('first install (nothing anywhere) announces nothing and records the version', async () => {
    const settle = await fresh({})
    expect(await settle('2.2.0')).toBeNull()
    expect(puts.at(-1)).toEqual({ whatsNewSeen: '2.2.0' })
  })
})

describe('autoOpenStore', () => {
  test('absent reads as ON; an explicit false (Don\'t show again) silences it and is saved server-side', async () => {
    const mem = new Map<string, string>()
    const puts: unknown[] = []
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) },
    } as Storage
    const { resetSharedPrefs, loadPersonalPrefs } = await import('../lib/sharedPref')
    resetSharedPrefs()
    globalThis.fetch = (async (_u: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PUT') { puts.push(JSON.parse(init.body!)); return new Response('{}') }
      return new Response('{}', { headers: { 'X-Prefs-Writable': 'true' } })
    }) as unknown as typeof fetch
    const { autoOpenStore } = await import('./seen?auto' + Math.random())
    expect(autoOpenStore.get()).toBe(true)
    await loadPersonalPrefs()
    autoOpenStore.set(false)
    expect(autoOpenStore.get()).toBe(false)
    expect(puts.at(-1)).toEqual({ whatsNewAutoOpen: false })
    autoOpenStore.set(true)
    expect(puts.at(-1)).toEqual({ whatsNewAutoOpen: true })
  })
})
