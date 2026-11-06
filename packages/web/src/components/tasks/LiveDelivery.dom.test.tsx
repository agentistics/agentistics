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

test('draws the eight stages, the cards in them, the summary and an honest "no estimate"', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('en')))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  expect(document.querySelectorAll('[data-live-column]').length).toBe(8)
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

test('leaders are their own band, closed on one summary line, never a delivery card', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const withLeaders = { ...reply, leaders: [{ id: 'L', title: '[ LÍDER ] - Leader one', harness: 'claude', model: 'opus', effort: 'high', state: 'working', currentAction: '↳ {"message":{"to":"x","kind":"handback","from":"w"}}', workers: [{ id: 'w', title: 'worker a', state: 'working', stage: 'running', word: 'working' }, { id: 'w2', title: 'worker b', state: 'waiting', stage: 'leader' }], awaiting: [{ id: 'w', title: 'worker a' }] }] }
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: withLeaders as never }))) })
  const band = document.querySelector('[data-live-leaders]')!
  expect(band.getAttribute('data-open')).toBe('0')
  expect(band.querySelector('[data-live-leaders-summary]')!.textContent).toBe('1 leader · 2 workers · 1 working · 1 awaiting review')
  expect(band.textContent).toContain('1 awaiting a decision')
  expect(band.querySelector('[data-live-leader]')).toBeNull()
  await act(async () => (document.getElementById('live-leaders-head') as HTMLElement).click())
  expect(band.textContent).toContain('Leader one')
  expect(band.textContent).toContain('claude · opus · high')
  expect(band.querySelector('[data-live-leader-body]')).toBeNull()
  await act(async () => (band.querySelector('[data-live-leader] > button') as HTMLElement).click())
  expect(band.querySelector('[data-live-leader-body]')!.textContent).toContain('handback from worker a')
  expect(band.textContent).not.toContain('{"message"')
  expect(band.querySelector('[data-live-worker="w2"]')!.textContent).toContain('awaiting review')
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

const withPublished = {
  ...reply,
  deliveries: [
    ...reply.deliveries,
    { key: 't/p', taskId: 't', taskTitle: 'Task', subtaskId: 'p', title: 'Published piece', status: 'done', stage: 'published', stageSinceMs: Date.now() - 3600_000, startedAtMs: null, sessionIds: [], harnesses: ['claude'], models: [], eta: { kind: 'none', reason: 'not-started' }, lastAction: null, blockedReason: null, deliveredAtMs: Date.now() - 3600_000 },
  ],
}

test('columns: today\'s layout, Publicado collapsed even with items; the header toggles and the choice is remembered', async () => {
  localStorage.clear()
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: withPublished as never }))) })
  const col = (s: string) => document.querySelector(`[data-live-column="${s}"]`) as HTMLElement
  expect(col('running').getAttribute('data-collapsed')).toBe('0')
  expect(col('merge').getAttribute('data-collapsed')).toBe('1') // empty: the thin strip it always was
  expect(col('published').getAttribute('data-collapsed')).toBe('1') // items, but collapsed by default
  expect(col('published').textContent).toContain('1')
  await act(async () => (col('published').querySelector('[data-live-colhead]') as HTMLElement).click())
  expect(col('published').getAttribute('data-collapsed')).toBe('0')
  await act(async () => (col('running').querySelector('[data-live-colhead]') as HTMLElement).click())
  expect(col('running').getAttribute('data-collapsed')).toBe('1')
  expect(JSON.parse(localStorage.getItem('agentistics.live.collapsed.v1')!)).toEqual({ published: false, running: true })
})

test('Publicado: every card is an accordion row; clicking opens the full card in place', async () => {
  localStorage.setItem('agentistics.live.collapsed.v1', JSON.stringify({ published: false }))
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: withPublished as never }))) })
  const row = document.querySelector('[data-live-pubrow="t/p"]') as HTMLElement
  expect(row.getAttribute('data-open')).toBe('0')
  expect(row.querySelector('[data-live-card]')).toBeNull()
  expect(row.textContent).toContain('Published piece')
  expect(row.textContent).toContain('published')
  await act(async () => (row.querySelector('button') as HTMLElement).click())
  expect(row.getAttribute('data-open')).toBe('1')
  expect(row.querySelector('[data-live-card="t/p"]')).not.toBeNull()
  localStorage.clear()
})

test('"only with active agents" does not empty Publicado, with or without a task filter', async () => {
  localStorage.setItem('agentistics.live.collapsed.v1', JSON.stringify({ published: false }))
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: withPublished as never, initialTaskIds: ['t'] }))) })
  expect(document.querySelector('[data-live-pubrow="t/p"]')).not.toBeNull()
  expect(document.querySelector('[data-live-chip="t"]')).not.toBeNull()
  localStorage.clear()
})

test('opened from a session: filtered by its task as a removable chip; other tasks stay reachable', async () => {
  const two = { ...reply, sessionTasks: { s1: 't' }, deliveries: [...reply.deliveries, { ...reply.deliveries[0]!, key: 'u/a', taskId: 'u', taskTitle: 'Other task', sessionIds: [] }] }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: two as never, focusSessionId: 's1', initialTaskIds: [] }))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  expect(document.querySelector('[data-live-chip="t"]')).not.toBeNull()
  expect(document.querySelector('[data-live-card="u/a"]')).toBeNull()
  await act(async () => (document.querySelector('[data-live-chip-remove]') as HTMLElement).click())
  expect(document.querySelector('[data-live-chip]')).toBeNull()
})

test('state words: an idle worker is not "waiting for you"; the reason says what it waits for', async () => {
  const idle = { ...reply, deliveries: [{ ...reply.deliveries[1]!, stage: 'leader', sessionIds: ['s3'] }] }
  const fleet = [{ ...rows[0]!, id: 's3', state: 'waiting' } as FleetRow]
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: idle as never, fleet }))) })
  const card = document.querySelector('[data-live-card="t/b"]')!
  expect(card.querySelector('[data-live-state]')!.textContent).toBe('aguardando revisão')
  expect(card.querySelector('[data-live-reason]')!.textContent).toContain('esperando revisão do líder')
  expect(card.textContent).not.toContain('esperando você')
  expect(card.querySelector('[data-live-role]')!.textContent).toContain('Worker')
})

test('the card is option A: bar, time row, two estimates, no raw JSON in the last action', async () => {
  const d = { ...reply.deliveries[0]!, workMs: 52 * 60_000, lastAction: { text: '{"message":{"to":"a","kind":"handback","from":"s1"}}', atMs: 1 }, stageEta: { kind: 'none', reason: 'no-history' }, publishEta: { kind: 'none', reason: 'no-history' } }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: { ...reply, deliveries: [d] } as never }))) })
  const card = document.querySelector('[data-live-card="t/a"]')!
  expect(card.querySelectorAll('[data-live-bar] i').length).toBe(6)
  expect(card.querySelector('[data-live-time]')!.textContent).toContain('time in this stage 38 min')
  expect(card.querySelector('[data-live-time]')!.textContent).toContain('total 52 min')
  expect(card.querySelector('[data-live-eta="next"]')!.textContent).toContain('no estimate')
  expect(card.querySelector('[data-live-eta="publish"]')!.textContent).toContain('no estimate')
  expect(card.querySelector('[data-live-last]')!.textContent).toBe('↳ handback from s1')
  expect(card.querySelector('[data-live-pill="runtime"]')!.textContent!.startsWith('claude · opus')).toBe(true)
})

test('Bloqueado is a column of its own: reason, who lifts it, how long', async () => {
  const b = { ...reply.deliveries[0]!, key: 't/z', stage: 'blocked', stageSinceMs: Date.now() - 42 * 60_000, block: { reason: 'limite', text: null, unlocker: 'leader', originStage: 'qa' } }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: { ...reply, deliveries: [b] } as never }))) })
  const cols = Array.from(document.querySelectorAll('[data-live-column]')).map(c => c.getAttribute('data-live-column'))
  expect(cols.slice(0, 3)).toEqual(['queue', 'blocked', 'running'])
  const blk = document.querySelector('[data-live-column="blocked"] [data-live-block]')!
  expect(blk.textContent).toContain('bloqueado por: limite de uso / login')
  expect(blk.textContent).toContain('quem destrava: líder')
  expect(blk.textContent).toContain('há 42 min')
  expect(blk.textContent).toContain('volta para: em qa')
})

test('a card that leaves the board says so — "saiu: <motivo> · há N s" — and the short list remembers it', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('pt')))) })
  const gone = { ...reply, deliveries: [reply.deliveries[1]!], hidden: [{ key: 't/a', taskId: 't', title: 'Piece A', stage: 'running', reason: 'no-live-session' }] }
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: gone as never }))) })
  const line = document.querySelector('[data-live-gone-line="t/a"]')!
  expect(line.textContent).toContain('saiu:')
  expect(line.textContent).toContain('a sessão encerrou e a peça segue sem agente')
  expect(line.textContent).toMatch(/há \d+ s/)
  const toggle = document.querySelector('[data-live-gone-toggle]') as HTMLElement
  expect(toggle.textContent).toBe('saíram há pouco (1)')
  await act(async () => toggle.click())
  expect(document.querySelector('[data-live-gone-list]')!.textContent).toContain('Piece A')
})

test('"abrir janela externa" falls back to a small window where Document PiP does not exist', async () => {
  const opened: string[] = []
  const realOpen = window.open
  ;(window as unknown as { open: unknown }).open = (url: string) => { opened.push(url); return {} }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('pt')))) })
  await act(async () => { (document.querySelector('[data-live-external]') as HTMLElement).click(); await new Promise(r => setTimeout(r, 10)) })
  expect(opened.length).toBe(1)
  expect(opened[0]).toContain('/tasks')
  ;(window as unknown as { open: unknown }).open = realOpen
})
