/**
 * NAVEGADOR.FECHAR-MINIMIZAR — the pure rules and the route for the person's browser: a minimized browser idles
 * out on its own (30 min) clock, admission gives it up first when memory is short, `open` / `minimize` / `close`
 * answer as the panel needs, a new tab opens the default page.
 */
import { describe, expect, test } from 'bun:test'
import { decideAdmission, type LiveBrowserView } from './browser-admission'
import { IDLE_MINIMIZED_MS, IDLE_PERSONAL_MS, MIN_AVAILABLE_BYTES, idleExpired } from './browser-spec'
import { DEFAULT_HOME_URL, browserRoute, homeUrlOf, type RouteDeps, type RouteHost } from './browser-web'
import type { ActionHost } from './browser-actions'

const P = { kind: 'personal' } as const
const S = (id: string) => ({ kind: 'session', managedId: id } as const)

describe('idle clock of a minimized personal browser', () => {
  test('30 min after it was minimized (or last used), never while watched; not minimized keeps the 20 min rule', () => {
    expect(idleExpired({ owner: P, viewers: 0, lastActivityMs: 0, minimizedAt: 0, now: IDLE_MINIMIZED_MS - 1 })).toBe(false)
    expect(idleExpired({ owner: P, viewers: 0, lastActivityMs: 0, minimizedAt: 0, now: IDLE_MINIMIZED_MS })).toBe(true)
    expect(idleExpired({ owner: P, viewers: 1, lastActivityMs: 0, minimizedAt: 0, now: 10 * IDLE_MINIMIZED_MS })).toBe(false)
    // minimized later than the last activity: the clock starts at the minimize
    expect(idleExpired({ owner: P, viewers: 0, lastActivityMs: 0, minimizedAt: 25 * 60_000, now: IDLE_MINIMIZED_MS })).toBe(false)
    expect(idleExpired({ owner: P, viewers: 0, lastActivityMs: 0, minimizedAt: null, now: IDLE_PERSONAL_MS })).toBe(true)
  })
})

describe('admission: a minimized personal browser goes first when memory is short', () => {
  const live = (minimized: boolean, viewers = 0): LiveBrowserView[] => [{ key: 'personal', owner: P, phase: 'live', viewers, lastActivityMs: 0, minimized }]
  const low = MIN_AVAILABLE_BYTES - 1
  test('session start, low memory, minimized personal → evict it', () => {
    expect(decideAdmission({ owner: S('a'), live: live(true), memAvailable: low, now: 1 })).toMatchObject({ ok: true, evict: 'personal' })
  })
  test('on screen (not minimized) or watched → refused as before', () => {
    expect(decideAdmission({ owner: S('a'), live: live(false), memAvailable: low, now: 1 })).toMatchObject({ ok: false, reason: 'low-memory' })
    expect(decideAdmission({ owner: S('a'), live: live(true, 1), memAvailable: low, now: 1 })).toMatchObject({ ok: false, reason: 'low-memory' })
  })
  test('plenty of memory → nothing is evicted', () => {
    expect(decideAdmission({ owner: S('a'), live: live(true), memAvailable: MIN_AVAILABLE_BYTES * 4, now: 1 })).toEqual({ ok: true, memory: 'ok' })
  })
})

describe('home page preference', () => {
  test('http(s) only, else the default', () => {
    expect(homeUrlOf('https://example.org/start')).toBe('https://example.org/start')
    expect(homeUrlOf(undefined)).toBe(DEFAULT_HOME_URL)
    expect(homeUrlOf(null)).toBe(DEFAULT_HOME_URL)
    expect(homeUrlOf('file:///etc/passwd')).toBe(DEFAULT_HOME_URL)
    expect(homeUrlOf('javascript:alert(1)')).toBe(DEFAULT_HOME_URL)
    expect(DEFAULT_HOME_URL).toBe('https://www.google.com')
  })
})

function fake(over: Partial<RouteHost> = {}) {
  const calls: string[] = []
  const ran: any[] = []
  const live = new Set<string>()
  const host: RouteHost = {
    start: async (o) => { live.add(o.kind === 'personal' ? 'personal' : `s-${o.managedId}`); return { ok: true, key: 'personal', pid: 1, reused: false } },
    stop: async (k, why) => { calls.push(`stop:${k}:${why}`); live.delete(k) },
    actionHost: (k) => (live.has(k) ? ({ key: k } as unknown as ActionHost) : null),
    status: async () => ({ live: [] }),
    minimize: (k) => { calls.push(`minimize:${k}`); return live.has(k) },
    openPersonal: async (home) => { calls.push(`open:${home}`); return { ok: true, restored: 2, home: false, wasStopped: true } },
    forgetSavedTabs: (k) => { calls.push(`forget:${k}`) },
    ...over,
  }
  const deps: RouteDeps = {
    host, verify: async () => null, personalGrant: () => true, caller: () => ({ kind: 'person', via: 'process', pid: 1 }),
    run: async (_h, args) => { ran.push(args); return { ok: true } },
    homeUrl: () => 'https://home.example/',
  }
  return { deps, calls, ran, live }
}

describe('personal routes', () => {
  test('open asks the host with the person\'s home page and reports what came back', async () => {
    const f = fake()
    const r = await browserRoute('POST', '/api/browser/personal/open', {}, f.deps)
    expect(r).toEqual({ status: 200, body: { ok: true, restored: 2, home: false, wasStopped: true } })
    expect(f.calls).toEqual(['open:https://home.example/'])
  })
  test('open that the host refuses says why (503 low memory)', async () => {
    const f = fake({ openPersonal: async () => ({ ok: false, reason: 'low-memory', sentence: 'Not enough memory.' }) })
    expect(await browserRoute('POST', '/api/browser/personal/open', {}, f.deps)).toMatchObject({ status: 503, body: { ok: false, error: 'low-memory' } })
  })
  test('minimize marks it hidden and never stops it', async () => {
    const f = fake()
    f.live.add('personal')
    expect(await browserRoute('POST', '/api/browser/personal/minimize', {}, f.deps)).toEqual({ status: 200, body: { ok: true, minimized: true } })
    expect(f.calls).toEqual(['minimize:personal'])
  })
  test('close stops the Chromium and forgets the saved tab list (also when nothing was live)', async () => {
    const f = fake()
    f.live.add('personal')
    await browserRoute('POST', '/api/browser/personal/close', {}, f.deps)
    expect(f.calls).toEqual(['stop:personal:requested', 'forget:personal'])
    const g = fake()
    expect(await browserRoute('POST', '/api/browser/personal/close', {}, g.deps)).toMatchObject({ status: 200, body: { ok: true, closed: false } })
    expect(g.calls).toEqual(['forget:personal'])
  })
  test('a new tab with no address opens the default page; with one, that one', async () => {
    const f = fake()
    f.live.add('personal')
    await browserRoute('POST', '/api/browser/personal/tab_new', {}, f.deps)
    await browserRoute('POST', '/api/browser/personal/tab_new', { url: 'https://x.example/' }, f.deps)
    expect(f.ran).toEqual([{ action: 'tab_new', url: 'https://home.example/' }, { action: 'tab_new', url: 'https://x.example/' }])
  })
  test('a session cannot minimize or open the person\'s browser', async () => {
    const f = fake({})
    f.deps.personalGrant = () => false
    expect(await browserRoute('POST', '/api/browser/personal/open', {}, f.deps)).toMatchObject({ status: 403 })
    expect(await browserRoute('POST', '/api/browser/personal/minimize', {}, f.deps)).toMatchObject({ status: 403 })
    expect(f.calls).toEqual([])
  })
})
