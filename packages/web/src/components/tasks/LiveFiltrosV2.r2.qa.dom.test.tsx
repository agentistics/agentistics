import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

/**
 * QA LIVE.FILTROS-V2 round 2 (48d03652a).
 *
 * The plain `test`s pin the CAUSE of HIGH-1. Measured: with `liveUrl` back to `/api/tasks/live`, the refetch gone, the stale
 * guard gone and `onPeriod` not called, all at once, 2880 tests over tasks/nav/task-live/core stayed green, because the
 * parity file builds its own request (`filters: {tab:'all', period}`) and nothing watched the one the screen makes.
 *
 * The `test.failing`s are bugs found by this QA: once fixed, bun reports them and the fix turns them into plain `test`.
 */
let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom').MemoryRouter
let Live: typeof import('./LiveDelivery').LiveDeliveryView
let LiveDelivery: typeof import('./LiveDelivery').LiveDelivery
let copy: typeof import('./LiveDelivery').copy
let useLive: typeof import('./useLiveDeliveries').useLiveDeliveries
let resetLiveCache: typeof import('./useLiveDeliveries').resetLiveCache

const realFetch = globalThis.fetch
const NOW = Date.now()
const piece = (key: string, taskId: string, over: object = {}) => ({
  key, taskId, taskTitle: `Task ${taskId}`, subtaskId: key, title: `Piece ${key}`, status: 'done', stage: 'published', stageSinceMs: NOW - 3_600_000, startedAtMs: null,
  sessionIds: [] as string[], harnesses: [] as string[], models: [] as string[], eta: { kind: 'none', reason: 'no-history' }, lastAction: null, blockedReason: null,
  deliveredAtMs: NOW - 3_600_000, priority: 'low', ...over,
})
const replyFor = (generatedAt: string, over: object = {}) => ({ generatedAt, samples: 0, deliveries: [] as unknown[], ...over })
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } })

/** Holds the reply the hook read last. */
let seen: { generatedAt?: string } | null = null
function Probe({ period }: { period: '24h' | '7d' | '30d' | 'all' }) {
  seen = useLive([], period).reply as never
  return null
}
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)) })
const liveAsked = (urls: string[]) => urls.filter(u => u.startsWith('/api/tasks/live'))

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The real screen opens the app's push channels; nothing here is about them.
  ;(globalThis as unknown as { EventSource: unknown }).EventSource = class { readyState = 1; onopen = null; onerror = null; onmessage = null; addEventListener() {} removeEventListener() {} close() {} }
  // happy-dom rejects a cancelled animation with an unhandled AbortError, and the loader cancels its own on the way out (no `animate`: it skips them).
  ;(Element.prototype as unknown as { animate: unknown }).animate = undefined
  createRoot = (await import('react-dom/client')).createRoot
  Router = (await import('react-router-dom')).MemoryRouter
  const m = await import('./LiveDelivery')
  Live = m.LiveDeliveryView; LiveDelivery = m.LiveDelivery; copy = m.copy
  const h = await import('./useLiveDeliveries')
  useLive = h.useLiveDeliveries; resetLiveCache = h.resetLiveCache
})
beforeEach(() => { localStorage.clear(); resetLiveCache(); seen = null })
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; localStorage.clear(); globalThis.fetch = realFetch })
afterAll(async () => GlobalRegistrator.unregister())

const mount = async (node: ReturnType<typeof createElement>) => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(node) })
}

test('HIGH-1 pin: the first request names the tab and the chosen period', async () => {
  const urls: string[] = []
  globalThis.fetch = (async (u: string) => { urls.push(String(u)); return json(replyFor('x')) }) as unknown as typeof fetch
  await mount(createElement(Probe, { period: '30d' }))
  await settle()
  expect(liveAsked(urls)[0]).toBe('/api/tasks/live?tab=all&period=30d')
})

test('HIGH-1 pin: another period is another question, asked at once', async () => {
  const urls: string[] = []
  globalThis.fetch = (async (u: string) => { urls.push(String(u)); return json(replyFor(String(u))) }) as unknown as typeof fetch
  await mount(createElement(Probe, { period: '24h' }))
  await settle()
  await act(async () => { root!.render(createElement(Probe, { period: '7d' })) })
  await settle()
  expect(liveAsked(urls)).toContain('/api/tasks/live?tab=all&period=7d')
  expect(seen?.generatedAt).toBe('/api/tasks/live?tab=all&period=7d')
})

test('race pin: the late answer of a period already left does not overwrite the current one', async () => {
  const release: Record<string, () => void> = {}
  globalThis.fetch = ((u: string) => new Promise<Response>(res => {
    const url = String(u)
    if (url.includes('period=7d')) release['7d'] = () => res(json(replyFor('seven')))
    else res(json(replyFor(url.includes('period=30d') ? 'thirty' : 'first')))
  })) as unknown as typeof fetch
  await mount(createElement(Probe, { period: '24h' }))
  await settle()
  await act(async () => { root!.render(createElement(Probe, { period: '7d' })) })
  await settle()
  await act(async () => { root!.render(createElement(Probe, { period: '30d' })) })
  await settle()
  expect(seen?.generatedAt).toBe('thirty')
  await act(async () => { release['7d']!() })
  await settle()
  expect(seen?.generatedAt).toBe('thirty')
})

test('HIGH-1 pin: choosing a period on the REAL screen reaches the request', async () => {
  const urls: string[] = []
  const reply = replyFor('x', { deliveries: [piece('p', 't')], view: { period: '24h', capped: null } })
  globalThis.fetch = (async (u: string) => { urls.push(String(u)); return String(u).startsWith('/api/tasks/live') ? json(reply) : json({}) }) as unknown as typeof fetch
  localStorage.setItem('agentistics.live.view.v2', JSON.stringify({ tab: 'published', period: '24h', sort: 'priority' }))
  await mount(createElement(Router, null, createElement(LiveDelivery, { lang: 'pt' })))
  await settle()
  await act(async () => { (document.querySelector('[data-live-period-current]') as HTMLElement).click() })
  await act(async () => { (document.querySelector('[data-live-period="30d"]') as HTMLElement).click() })
  await settle()
  expect(liveAsked(urls)).toContain('/api/tasks/live?tab=all&period=30d')
})

test.failing('MED: under a task filter the screen does not claim the whole board\'s cut as this task\'s', async () => {
  // Real board: the chosen task shows 62 of its 62 (recount from tasks.json: 0 of it cut), and the note says 109 are missing and "the numbers above are not the total".
  const reply = replyFor('x', { deliveries: [piece('p', 't1'), piece('o', 't2')], view: { period: 'all', capped: { cap: 400, omitted: 109 } } })
  localStorage.setItem('agentistics.live.view.v2', JSON.stringify({ tab: 'published', period: 'all', sort: 'priority' }))
  await mount(createElement(Router, null, createElement(Live, { lang: 'pt', reply: reply as never, error: null, nowMs: NOW, fleet: [], accountLabels: {}, initialTaskIds: ['t1'] } as never)))
  await settle()
  expect(document.querySelector('[data-live-capped]')?.textContent ?? '').not.toContain('109')
})

test.failing('LOW: when the new period could not be read, the screen says so instead of showing the old period\'s numbers under the new label', async () => {
  // Measured with the answer aborted: label "30 dias", tab and rows 50 (the 7 d figures), no sentence, until the next heartbeat.
  const reply = replyFor('x', { deliveries: [piece('p', 't1')], view: { period: '7d', capped: null } })
  localStorage.setItem('agentistics.live.view.v2', JSON.stringify({ tab: 'published', period: '30d', sort: 'priority' }))
  await mount(createElement(Router, null, createElement(Live, { lang: 'pt', reply: reply as never, error: 'down', nowMs: NOW, fleet: [], accountLabels: {} } as never)))
  await settle()
  expect(document.body.textContent).toContain(copy(true).down)
})
