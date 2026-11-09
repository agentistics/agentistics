import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { describeLive } from '../../../../server/server/sessions/task-live-view'
import type { LiveDelivery, LiveReply } from '../../../../server/server/sessions/task-live'

/**
 * LIVE.FILTROS-V2 round 3, MED-C. The server's REAL read model (`describeLive`) answers every request the screen makes —
 * the reply is never written by hand — so choosing a period on the screen must change what the tab prints. Remove the
 * refetch on period change (`useLiveDeliveries`) and the "Tudo" tab keeps the 24 h count: this test fails.
 */
let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom').MemoryRouter
let LiveDeliveryScreen: typeof import('./LiveDelivery').LiveDelivery
let resetLiveCache: typeof import('./useLiveDeliveries').resetLiveCache

const realFetch = globalThis.fetch
const H = 3_600_000
const NOW = Date.now()
const piece = (key: string, ageH: number): LiveDelivery => ({
  key, taskId: 't', taskTitle: 'Task', subtaskId: key, title: `Piece ${key}`, status: 'done', stage: 'published', stageSinceMs: NOW - ageH * H, startedAtMs: null,
  sessionIds: [], harnesses: [], models: [], eta: { kind: 'none', reason: 'no-history' }, lastAction: null, blockedReason: null,
  deliveredAtMs: NOW - ageH * H, priority: 'low', workMs: null, efforts: [], trail: [], stageEta: { kind: 'none', reason: 'no-history' }, publishEta: { kind: 'none', reason: 'no-history' }, block: null, ci: null,
} as unknown as LiveDelivery)
const board: LiveReply = {
  generatedAt: new Date(NOW).toISOString(), samples: 0, hidden: [], sessionTasks: {},
  deliveries: [piece('fresh', 1)], history: [piece('week', 24 * 10), piece('old', 24 * 40)], historyTotal: 2,
}
const answer = (url: string) => {
  const q = new URL(url, 'http://x').searchParams
  return describeLive({ reply: board, rows: [], leaderIds: new Set(), nowMs: NOW, filters: { tab: q.get('tab') as never, period: q.get('period') as never } })
}
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } })
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)) })
const tabText = (re: RegExp) => Array.from(document.querySelectorAll('[data-live-tabs] [role=tab]')).map(t => t.textContent ?? '').find(t => re.test(t)) ?? ''

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as unknown as { EventSource: unknown }).EventSource = class { readyState = 1; onopen = null; onerror = null; onmessage = null; addEventListener() {} removeEventListener() {} close() {} }
  ;(Element.prototype as unknown as { animate: unknown }).animate = undefined
  createRoot = (await import('react-dom/client')).createRoot
  Router = (await import('react-router-dom')).MemoryRouter
  LiveDeliveryScreen = (await import('./LiveDelivery')).LiveDelivery
  resetLiveCache = (await import('./useLiveDeliveries')).resetLiveCache
})
beforeEach(() => { localStorage.clear(); resetLiveCache() })
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; localStorage.clear(); globalThis.fetch = realFetch })
afterAll(async () => GlobalRegistrator.unregister())

test('choosing 30 dias on the real screen changes the Tudo count the real read model answers', async () => {
  const asked: string[] = []
  globalThis.fetch = (async (u: string) => {
    asked.push(String(u))
    return String(u).startsWith('/api/tasks/live') ? json(answer(String(u))) : json({})
  }) as unknown as typeof fetch
  localStorage.setItem('agentistics.live.view.v2', JSON.stringify({ tab: 'all', period: '24h', sort: 'priority' }))
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(LiveDeliveryScreen, { lang: 'pt' }))) })
  await settle()
  expect(tabText(/Tudo/)).toContain('1')
  await act(async () => { (document.querySelector('[data-live-period-current]') as HTMLElement).click() })
  await act(async () => { (document.querySelector('[data-live-period="30d"]') as HTMLElement).click() })
  await settle()
  expect(asked).toContain('/api/tasks/live?tab=all&period=30d')
  expect(tabText(/Tudo/)).toContain(String(answer('/api/tasks/live?tab=all&period=30d').view.counts.all))
  expect(tabText(/Tudo/)).toContain('2')
})
