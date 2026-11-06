import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { FleetRow } from '../../lib/fleet'

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom').MemoryRouter
let Live: typeof import('./LiveDelivery').LiveDeliveryView

const rows: FleetRow[] = [
  { id: 's1', title: 's1', harness: 'claude', cwd: '/', project: 'p', state: 'working', stateLabel: 'working', actionable: true, model: 'opus' } as FleetRow,
  { id: 's2', title: 's2', harness: 'codex', cwd: '/', project: 'p', state: 'waiting-approval', stateLabel: 'waiting', actionable: true } as FleetRow,
]
const reply = {
  generatedAt: new Date().toISOString(), samples: 0,
  deliveries: [
    { key: 't/a', taskId: 't', taskTitle: 'Task', subtaskId: 'a', title: 'Piece A', status: 'in_progress', stage: 'running', stageSinceMs: Date.now() - 38 * 60_000, startedAtMs: Date.now() - 65 * 60_000, sessionIds: ['s1'], harnesses: ['claude'], models: ['opus'], eta: { kind: 'none', reason: 'no-history' }, lastAction: { text: 'moved to in_progress', atMs: 1 }, blockedReason: null, deliveredAtMs: null },
    { key: 't/b', taskId: 't', taskTitle: 'Task', subtaskId: 'b', title: 'Piece B', status: 'in_progress', stage: 'qa', stageSinceMs: Date.now() - 5 * 60_000, startedAtMs: Date.now() - 10 * 60_000, sessionIds: ['s2'], harnesses: ['codex'], models: [], eta: { kind: 'none', reason: 'no-history' }, lastAction: null, blockedReason: null, deliveredAtMs: null },
  ],
}

const props = (lang: 'pt' | 'en') => ({ lang, reply: reply as never, error: null, nowMs: Date.now(), fleet: rows, accountLabels: {} })

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Router = (await import('react-router-dom')).MemoryRouter
  Live = (await import('./LiveDelivery')).LiveDeliveryView
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())

test('draws the seven stages, the cards in them, the summary and an honest "no estimate"', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('en')))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  expect(document.querySelectorAll('[data-live-column]').length).toBe(7)
  expect(document.querySelector('[data-live-column="running"] [data-live-card="t/a"]')).not.toBeNull()
  expect(document.querySelector('[data-live-column="qa"] [data-live-card="t/b"]')).not.toBeNull()
  expect(document.querySelector('[data-live-summary]')!.textContent).toContain('2 active deliveries')
  expect(document.querySelector('[data-live-summary]')!.textContent).toContain('1 agent working')
  expect(document.body.textContent).toContain('no estimate')
  // the piece whose agent waits on a person wears the alert border
  expect(document.querySelector('[data-live-card="t/b"]')!.getAttribute('data-alert')).toBe('1')
  expect(document.querySelector('[data-live-card="t/a"]')!.getAttribute('data-alert')).toBeNull()
})

test('"only with active agents" keeps the cards whose agent is alive', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('pt')))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  const toggle = Array.from(document.querySelectorAll('button[aria-pressed]')).find(b => b.textContent?.includes('só com agentes ativos')) as HTMLElement
  await act(async () => toggle.click())
  expect(document.querySelectorAll('[data-live-card]').length).toBe(2) // both have live (waiting-approval counts as alive)
})

test('leaders are their own band and never a delivery card', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const withLeaders = { ...reply, leaders: [{ id: 'L', title: 'Leader one', harness: 'claude', model: 'opus', state: 'working', currentAction: 'reviewing PR #12', workers: [{ id: 'w', title: 'worker a', state: 'working' }], awaiting: [{ id: 'w', title: 'worker a' }] }] }
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: withLeaders as never }))) })
  const band = document.querySelector('[data-live-leaders]')!
  expect(band.textContent).toContain('Leader one')
  expect(band.textContent).toContain('reviewing PR #12')
  expect(band.textContent).toContain('1 awaiting a decision')
  expect(document.querySelector('[data-live-column] [data-live-leader]')).toBeNull()
  expect(document.querySelectorAll('[data-live-card]').length).toBe(2)
})

test('a card that changes stage re-renders in its new column and is left visible afterwards', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('en')))) })
  const moved = { ...reply, deliveries: [{ ...reply.deliveries[0]!, stage: 'qa' }, reply.deliveries[1]!] }
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: moved as never }))) })
  await act(async () => { await new Promise(r => setTimeout(r, 30)) })
  const el = document.querySelector('[data-live-column="qa"] [data-live-card="t/a"]') as HTMLElement
  expect(el).not.toBeNull()
  expect(el.style.opacity).toBe('')
})
