import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { FleetRow } from '../../lib/fleet'

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom').MemoryRouter
let Live: typeof import('./LiveDelivery').LiveDeliveryView
let store: typeof import('./livePipStore')

const rows: FleetRow[] = [
  { id: 's1', title: 's1', harness: 'claude', cwd: '/', project: 'p', state: 'working', stateLabel: 'working', actionable: true } as FleetRow,
]
const reply = {
  generatedAt: new Date().toISOString(), samples: 0,
  deliveries: [{
    key: 't/a', taskId: 't', taskTitle: 'Task', subtaskId: 'a', title: 'Piece A', status: 'in_progress', stage: 'running', stageSinceMs: Date.now() - 60_000,
    startedAtMs: Date.now() - 120_000, sessionIds: ['s1'], harnesses: ['claude'], models: [], eta: { kind: 'none', reason: 'no-history' }, lastAction: null, blockedReason: null, deliveredAtMs: null,
  }, {
    key: 't/pub', taskId: 't', taskTitle: 'Task', subtaskId: 'pub', title: 'Fresh piece', status: 'done', stage: 'published', stageSinceMs: null, startedAtMs: null,
    sessionIds: [], harnesses: ['claude'], models: [], eta: { kind: 'none', reason: 'not-started' }, lastAction: null, blockedReason: null, deliveredAtMs: Date.now() - 3600_000,
  }, {
    key: 't/old', taskId: 't', taskTitle: 'Task', subtaskId: 'old', title: 'Old piece', status: 'done', stage: 'published', stageSinceMs: null, startedAtMs: null,
    sessionIds: [], harnesses: ['claude'], models: [], eta: { kind: 'none', reason: 'not-started' }, lastAction: null, blockedReason: null, deliveredAtMs: new Date().setHours(0, 0, 0, 0) - 3600_000 /* 23:00 yesterday on the local clock, whatever time the suite runs */,
  }],
}
const props = { lang: 'pt' as const, reply: reply as never, error: null, nowMs: Date.now(), fleet: rows, accountLabels: {} }

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Router = (await import('react-router-dom')).MemoryRouter
  Live = (await import('./LiveDelivery')).LiveDeliveryView
  store = await import('./livePipStore')
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; store.resetPipForTest() })
afterAll(async () => GlobalRegistrator.unregister())

test('the external window outlives the component that opened it (the popover/route unmount closed it before)', async () => {
  let closed = 0
  const fakeWin = {
    document: document.implementation.createHTMLDocument('pip'), close: () => { closed++ }, addEventListener: () => {}, removeEventListener: () => {},
  }
  ;(window as unknown as { documentPictureInPicture: unknown }).documentPictureInPicture = { requestWindow: async () => fakeWin }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props))) })
  await act(async () => { (document.querySelector('[data-live-external]') as HTMLElement).click() })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  expect(store.getPip()?.win).toBe(fakeWin as never)
  // The shortcut popover closes / the route changes: the Live view unmounts.
  await act(async () => root!.unmount()); root = undefined
  expect(closed).toBe(0)
  expect(store.getPip()).not.toBeNull()
  // Only the person's own close takes it down.
  store.closePip()
  expect(closed).toBe(1)
  expect(store.getPip()).toBeNull()
  delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture
})

test('there is no Histórico column: Publicado keeps the last 24 h and a longer period brings the older piece into the same column', async () => {
  localStorage.clear(); localStorage.setItem('agentistics.live.view.v2', JSON.stringify({ tab: 'all', period: '7d' }))
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  expect(document.querySelector('[data-live-column="history"]')).toBeNull()
  const col = document.querySelector('[data-live-column="published"]') as HTMLElement
  expect(col.getAttribute('data-collapsed')).toBe('0')
  expect(col.textContent).toContain('Fresh piece')
  expect(col.textContent).toContain('Old piece')
  localStorage.clear()
})

test('a card offers "abrir sessão" for its live session, and clicking it does not open the card', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  const link = document.querySelector('[data-live-card="t/a"] [data-live-session-link="author"]') as HTMLElement
  expect(link.textContent).toContain('abrir sessão')
})
