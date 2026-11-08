import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

/**
 * QA LIVE.FILTROS-V2 (e3dce1394). `test.failing` = a bug found by this QA: once fixed, bun reports it, and the fix turns
 * it into a plain `test`. On the desktop, a tab with nothing to show draws nine sideways column names and no sentence
 * (the phone says "Nada nesta etapa"); "Em andamento" is the tab the screen OPENS on, so this is the first thing a person
 * sees on a quiet machine, and it reads as a board that failed to load.
 */
let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom').MemoryRouter
let Live: typeof import('./LiveDelivery').LiveDeliveryView

const NOW = Date.now()
const queued = {
  key: 'q', taskId: 't', taskTitle: 'Task', subtaskId: 'q', title: 'Piece q', status: 'todo', stage: 'queue', stageSinceMs: NOW - 60_000, startedAtMs: null,
  sessionIds: [] as string[], harnesses: [] as string[], models: [] as string[], eta: { kind: 'none', reason: 'no-history' }, lastAction: null, blockedReason: null, deliveredAtMs: null, priority: 'low',
}

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Router = (await import('react-router-dom')).MemoryRouter
  Live = (await import('./LiveDelivery')).LiveDeliveryView
})
beforeEach(() => localStorage.clear())
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; localStorage.clear() })
afterAll(async () => GlobalRegistrator.unregister())

test.failing('MED: on the desktop, "Em andamento" with nothing in it SAYS so', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const reply = { generatedAt: new Date().toISOString(), samples: 0, deliveries: [queued] }
  await act(async () => {
    root!.render(createElement(Router, null, createElement(Live, { lang: 'pt', reply: reply as never, error: null, nowMs: NOW, fleet: [], accountLabels: {} })))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  const board = document.querySelector('[data-live-board]')!
  // The nine column names are all it holds today; any sentence about the empty tab satisfies this.
  expect(board.textContent).toMatch(/nada|nenhum|ningu[eé]m/i)
})
