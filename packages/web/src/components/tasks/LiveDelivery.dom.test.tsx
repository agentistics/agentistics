import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
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
// Several fixtures here are agent-less pieces; "Tudo" draws every piece in its column. The tab tests clear it and use the default.
beforeEach(() => { localStorage.clear(); localStorage.setItem('agentistics.live.view.v2', JSON.stringify({ tab: 'all' })) })
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())

test('draws the nine stages, the cards in them, the summary and an honest "no estimate"', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('en')))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  expect(document.querySelectorAll('[data-live-column]').length).toBe(9)
  expect(document.querySelector('[data-live-column="running"] [data-live-card="t/a"]')).not.toBeNull()
  expect(document.querySelector('[data-live-column="qa"] [data-live-card="t/b"]')).not.toBeNull()
  expect(document.querySelector('[data-live-summary]')!.textContent).toContain('2 active deliveries')
  expect(document.querySelector('[data-live-summary]')!.textContent).toContain('1 agent working')
  expect(document.body.textContent).toContain('no estimate')
  // the piece whose agent waits on a person wears the alert border
  expect(document.querySelector('[data-live-card="t/b"]')!.getAttribute('data-alert')).toBe('1')
  expect(document.querySelector('[data-live-card="t/a"]')!.getAttribute('data-alert')).toBeNull()
})

test('opens on "Em andamento" (agents working or waiting, 2 here); "Na fila" is empty and the choice is remembered', async () => {
  localStorage.clear()
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('pt')))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  const tabs = () => Array.from(document.querySelectorAll('[data-live-tabs] [role="tab"]'))
  expect(tabs().map(t => [t.textContent, t.getAttribute('aria-selected')])).toEqual([['Em andamento2', 'true'], ['Na fila0', 'false'], ['Publicado0', 'false'], ['Tudo2', 'false']])
  expect(document.querySelectorAll('[data-live-card]').length).toBe(2)
  await act(async () => (tabs()[1] as HTMLElement).click())
  expect(document.querySelectorAll('[data-live-card]').length).toBe(0)
  expect(JSON.parse(localStorage.getItem('agentistics.live.view.v2')!)).toMatchObject({ tab: 'queue', period: '24h' })
  localStorage.clear()
})

test('Líderes is a compact pill with real counters; the dropdown opens over the board, leaders collapsed, workers as rows', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const withLeaders = { ...reply, leaders: [
    { id: 'L', title: '[ LÍDER ] - Leader one', harness: 'claude', model: 'opus', effort: 'high', state: 'working', currentAction: '↳ {"message":{"to":"x","kind":"handback","from":"w"}}', workers: [{ id: 'w', title: 'worker a', state: 'working', stage: 'running', word: 'working', cardKey: 't/a', subtask: 'Piece A' }, { id: 'w2', title: 'worker b', state: 'waiting', stage: 'leader', cardKey: 't/b' }, { id: 'w3', title: 'worker c', state: 'waiting', stage: 'blocked', cardKey: 'gone/card' }], awaiting: [{ id: 'w', title: 'worker a' }] },
    { id: 'L2', title: 'Second leader', harness: 'codex', model: null, state: 'waiting', currentAction: null, workers: [{ id: 'w', title: 'worker a', state: 'working', stage: 'running', word: 'working' }], awaiting: [] },
  ] }
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: withLeaders as never }))) })
  const band = document.querySelector('[data-live-leaders]')!
  expect(band.getAttribute('data-open')).toBe('0')
  expect(band.querySelector('[data-live-leaders-label]')!.textContent).toBe('Leaders 2')
  // one distinct worker is counted once, even when two leaders list it: 1 working, 2 waiting... w3 is blocked
  expect(band.querySelector('[data-live-leaders-counts]')!.textContent).toBe('111')
  expect(document.querySelector('[data-live-column] [data-live-leader]')).toBeNull()
  await act(async () => (document.getElementById('live-leaders-head') as HTMLElement).click())
  expect(band.getAttribute('data-open')).toBe('1')
  expect(band.textContent).toContain('3 workers: 1 working · 1 waiting · 1 blocked')
  const card = band.querySelector('[data-live-leader="L"]')!
  expect(card.getAttribute('data-open')).toBe('0')
  expect(card.textContent).toContain('Leader one')
  expect(card.querySelector('[data-live-leader-body]')).toBeNull()
  await act(async () => (card.querySelector('button') as HTMLElement).click())
  const body = card.querySelector('[data-live-leader-body]')!
  expect(body.textContent).toContain('claude · Opus 5 · high')
  expect(body.textContent).toContain('handback from worker a')
  expect(body.textContent).not.toContain('{"message"')
  // a worker whose card the filters hide says so in the row
  await act(async () => (band.querySelector('[data-live-worker="w3"]') as HTMLElement).click())
  expect(band.querySelector('[data-live-worker="w3"] [data-live-worker-info]')!.textContent).toBe('no card on the board')
  // a worker with a card closes the dropdown
  await act(async () => (band.querySelector('[data-live-worker="w"]') as HTMLElement).click())
  expect(band.getAttribute('data-open')).toBe('0')
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

test('columns: with cards = open, empty = collapsed (no zero shown); the header toggles and the choice is remembered', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: withPublished as never }))) })
  const col = (s: string) => document.querySelector(`[data-live-column="${s}"]`) as HTMLElement
  expect(col('running').getAttribute('data-collapsed')).toBe('0')
  expect(col('merge').getAttribute('data-collapsed')).toBe('1') // empty: the thin strip it always was
  expect(col('merge').querySelector('[data-live-colcount]')).toBeNull()
  expect(col('published').getAttribute('data-collapsed')).toBe('0') // it has a card in its period: open
  await act(async () => (col('published').querySelector('[data-live-colhead]') as HTMLElement).click())
  expect(col('published').getAttribute('data-collapsed')).toBe('1')
  await act(async () => (col('running').querySelector('[data-live-colhead]') as HTMLElement).click())
  expect(col('running').getAttribute('data-collapsed')).toBe('1')
  expect(JSON.parse(localStorage.getItem('agentistics.live.collapsed.v1')!)).toEqual({ published: true, running: true })
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
  expect(card.querySelectorAll('[data-live-bar] i').length).toBe(7)
  expect(card.querySelector('[data-live-time]')!.textContent).toContain('time in this stage 38 min')
  expect(card.querySelector('[data-live-time]')!.textContent).toContain('total 52 min')
  expect(card.querySelector('[data-live-eta="next"]')!.textContent).toContain('no estimate')
  expect(card.querySelector('[data-live-eta="publish"]')!.textContent).toContain('no estimate')
  expect(card.querySelector('[data-live-last]')!.textContent).toBe('handback from s1')
  expect(card.querySelector('[data-live-pill="runtime"]')!.textContent!.startsWith('claude · Opus')).toBe(true)
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
  expect(blk.textContent).toContain('volta para: qa')
})

test('a card that leaves the board is never silent: the "saíram há pouco" list says why (no ghost line in a column)', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('pt')))) })
  const gone = { ...reply, deliveries: [reply.deliveries[1]!], hidden: [{ key: 't/a', taskId: 't', title: 'Piece A', stage: 'running', reason: 'no-live-session' }] }
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: gone as never }))) })
  expect(document.querySelector('[data-live-gone-line]')).toBeNull()
  const toggle = document.querySelector('[data-live-gone-toggle]') as HTMLElement
  expect(toggle.textContent).toBe('saíram há pouco (1)')
  expect(toggle.getAttribute('data-fresh')).toBe('1')
  await act(async () => toggle.click())
  const list = document.querySelector('[data-live-gone-list]')!
  expect(list.textContent).toContain('Piece A')
  expect(list.textContent).toContain('a sessão encerrou e a peça segue sem agente')
  expect(list.textContent).toMatch(/há \d+ s/)
})

test('a card that moved says where it came from, for a few seconds', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('pt')))) })
  const mv = { ...reply, deliveries: [{ ...reply.deliveries[0]!, stage: 'qa' }, reply.deliveries[1]!] }
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: mv as never }))) })
  const pill = document.querySelector('[data-live-card="t/a"] [data-live-came-from]')!
  expect(pill.textContent).toBe('veio de Em desenvolvimento · agora')
  expect(document.querySelector('[data-live-card="t/b"] [data-live-came-from]')).toBeNull()
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

test('CI · publicando: its own column, a signal checklist, a percent line; Publicado only on the flow\'s signal', async () => {
  const ciCard = { ...reply.deliveries[0]!, key: 't/ci', stage: 'ci', ci: { mergedMain: true, releaseGreen: false, tagPublished: false, tag: 'v2.200.8', pr: 1351 } }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: { ...reply, deliveries: [ciCard] } as never }))) })
  const cols = Array.from(document.querySelectorAll('[data-live-column]')).map(c => c.getAttribute('data-live-column'))
  expect(cols.slice(-3)).toEqual(['merge', 'ci', 'published'])
  const card = document.querySelector('[data-live-column="ci"] [data-live-card="t/ci"]')!
  const lines = Array.from(card.querySelectorAll('[data-ci-line]')).map(l => [l.getAttribute('data-ci-line'), l.getAttribute('data-done')])
  expect(lines).toEqual([['merge', '1'], ['release', '0'], ['tag', '0']])
  expect(card.querySelector('[data-live-cisig]')!.textContent).toContain('tag v2.200.8 publicada')
  expect(card.querySelector('[data-live-pct]')!.textContent).toContain('33%')
  expect(card.querySelector('[data-live-pct]')!.textContent).toContain('passo 2 de 3: publicação rodando')
  const seg = Array.from(card.querySelectorAll('[data-live-bar] i')).find(i => i.getAttribute('data-seg') === 'cur') as HTMLElement
  expect(seg.style.background).toContain('linear-gradient')
})

test('the percent line is hidden when the piece reported no step', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, props('pt')))) })
  expect(document.querySelector('[data-live-card="t/a"] [data-live-pct]')).toBeNull()
  const withStep = { ...reply, deliveries: [{ ...reply.deliveries[0]!, step: 3 }] }
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: withStep as never }))) })
  expect(document.querySelector('[data-live-card="t/a"] [data-live-pct]')!.textContent).toContain('40%')
})

test('no emoji anywhere in the Live (icons are drawn by the app\'s icon set)', async () => {
  const rich = {
    ...reply,
    leaders: [{ id: 'L', title: 'Lead', harness: 'claude', model: 'opus', state: 'working', currentAction: 'x', workers: [{ id: 's1', title: 'w', state: 'waiting', stage: 'leader', cardKey: 't/b' }], awaiting: [] }],
    deliveries: [
      { ...reply.deliveries[0]!, step: 2, lastAction: { text: 'did a thing', atMs: 1 } },
      { ...reply.deliveries[1]!, stage: 'leader', sessionIds: ['s1'] },
      { ...reply.deliveries[0]!, key: 't/ci', stage: 'ci', ci: { mergedMain: true, releaseGreen: true, tagPublished: false, tag: null, pr: null } },
    ],
  }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: rich as never, fleet: [rows[0]!, { ...rows[1]!, id: 's1', state: 'waiting' } as FleetRow] }))) })
  await act(async () => (document.getElementById('live-leaders-head') as HTMLElement).click())
  await act(async () => (document.querySelector('[data-live-leader] > button') as HTMLElement).click())
  expect(document.body.textContent).not.toMatch(/[♛⏳⛔▶⧉✓◌↳←]/u)
  expect(document.querySelectorAll('svg').length).toBeGreaterThan(3)
})

test('MED 8: the card matches the approved preview — one plain grey runtime line, an orange publication box, "‹" on open headers, Líderes after the summary', async () => {
  const d = { ...reply.deliveries[0]!, workMs: 1, stageEta: { kind: 'estimate', atMs: Date.now() + 3600_000, medianMs: 1, n: 3, nextStage: 'qa' }, publishEta: { kind: 'estimate', atMs: Date.now() + 7200_000, source: 'stages', n: 3, parts: [] } }
  const withLeader = { ...reply, deliveries: [d], leaders: [{ id: 'L', title: 'Motor', harness: 'claude', model: 'claude-opus-5-5', state: 'working', currentAction: null, workers: [], awaiting: [] }] }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: withLeader as never, accountLabels: {} }))) })
  const card = document.querySelector('[data-live-card="t/a"]')!
  const pills = card.querySelectorAll('[data-live-pill]')
  expect(pills.length).toBe(1)
  const line = pills[0] as HTMLElement
  expect(line.textContent).toBe('claude · Opus 5')
  expect(line.textContent).not.toContain('claude-opus')
  expect(line.style.border).toBe('')
  expect(line.style.borderRadius).toBe('')
  expect((card.querySelector('[data-live-eta="publish"]') as HTMLElement).style.background).toContain('anthropic-orange-dim')
  expect((card.querySelector('[data-live-eta="next"]') as HTMLElement).style.background).not.toContain('anthropic-orange')
  expect(document.querySelector('[data-live-column="running"] [data-live-colhead] [data-live-colchev]')!.textContent).toBe('‹')
  const summary = document.querySelector('[data-live-summary]')!, leaders = document.querySelector('[data-live-leaders]')!
  expect(summary.compareDocumentPosition(leaders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('MED 7: the last action is said in the UI language, not as `on subtask "<title>"`', async () => {
  const d = { ...reply.deliveries[0]!, lastAction: { text: 'on subtask "Piece A"', atMs: 1, kind: 'comment' } }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: { ...reply, deliveries: [d] } as never }))) })
  expect(document.querySelector('[data-live-last]')!.textContent).toBe('comentou na subtarefa')
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: { ...reply, deliveries: [d] } as never }))) })
  expect(document.querySelector('[data-live-last]')!.textContent).toBe('commented on the subtask')
})

test('old legacy reviews are no separate button: they sit in "Tudo" (counted), marked old, and are not "In progress"', async () => {
  localStorage.clear()
  const old = Array.from({ length: 3 }, (_, i) => ({ ...reply.deliveries[0]!, key: `t/o${i}`, subtaskId: `o${i}`, title: `Old review ${i}`, stage: 'leader', sessionIds: [], old: true }))
  const r = { ...reply, deliveries: old }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: r as never }))) })
  expect(document.querySelector('[data-live-archived-toggle]')).toBeNull()
  const tabs = Array.from(document.querySelectorAll('[data-live-tabs] [role="tab"]')).map(t => t.textContent)
  expect(tabs).toEqual(['In progress0', 'Queued0', 'Published0', 'All3'])
  await act(async () => (document.querySelectorAll('[data-live-tabs] [role="tab"]')[3] as HTMLElement).click())
  expect(document.querySelectorAll('[data-live-column="leader"] [data-live-old]').length).toBe(3)
  localStorage.clear()
})

test('LOW 11: on a phone the Líderes pill, its rows and the filter chip\'s remove control are 44 px targets', async () => {
  const { LiveLeaders } = await import('./LiveLeaders')
  const { LiveTaskFilter } = await import('./LiveTaskFilter')
  const leader = { id: 'L', title: 'Motor', harness: 'claude', model: null, state: 'working', currentAction: null, workers: [{ id: 'w', title: 'w', state: 'working', stage: 'running', word: 'working', cardKey: 't/a' }], awaiting: [] }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const mk = (mobile: boolean) => createElement(Router, null,
    createElement(LiveLeaders, { leaders: [leader] as never, nowMs: Date.now(), lang: 'pt', locate: () => ({ kind: 'none' as const }), onLocate: () => {}, onOpen: () => {}, mobile }),
    createElement(LiveTaskFilter, { options: [{ value: 't', label: 'Task', recent: true, live: 1 }], chosen: ['t'], onChange: () => {}, pt: true, mobile }))
  await act(async () => { root!.render(mk(true)) })
  expect((document.querySelector('#live-leaders-head') as HTMLElement).style.minHeight).toBe('44px')
  await act(async () => (document.querySelector('#live-leaders-head') as HTMLElement).click())
  // the open/closed memory is per leader and persists across tests: open it only when it is not already
  if (document.querySelector('[data-live-leader]')!.getAttribute('data-open') !== '1') await act(async () => ((document.querySelector('[data-live-leader] button')) as HTMLElement).click())
  expect((document.querySelector('[data-live-worker="w"]') as HTMLElement).style.minHeight).toBe('44px')
  expect(document.querySelector('[data-live-chip-hit]')).not.toBeNull()
  await act(async () => { root!.render(mk(false)) })
  expect((document.querySelector('#live-leaders-head') as HTMLElement).style.minHeight).toBe('28px')
  expect(document.querySelector('[data-live-chip-hit]')).toBeNull()
})

test('HIGH 2 (real screen): a queue card\'s own slot line is not a column slot — the fit measures cards, not the "vaga:" lines inside them', async () => {
  const q = (k: string) => ({ ...reply.deliveries[0]!, key: `t/${k}`, subtaskId: k, stage: 'queue', staged: { harness: 'codex', model: 'gpt-5.5', effort: 'high' }, slot: { ok: false, reason: 'sem vaga', at: new Date().toISOString() } })
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('pt'), reply: { ...reply, deliveries: [q('q1'), q('q2'), q('q3')] } as never }))) })
  const col = document.querySelector('[data-live-column="queue"]')!
  expect(col.querySelectorAll('[data-live-card]').length).toBe(3)
  expect(col.querySelectorAll('[data-live-queue-slot]').length).toBe(3)
  expect(col.querySelectorAll('[data-live-slot]').length).toBe(3)
})

test('LIVE.PRIORIDADE: a queued card shows its priority ONCE, read-only — nothing on the Live changes it', async () => {
  const q = (k: string) => ({ ...reply.deliveries[0]!, key: `t/${k}`, subtaskId: k, stage: 'queue', priority: 'high', staged: { harness: 'codex', model: 'gpt-5.5', effort: 'high' } })
  for (const lang of ['pt', 'en'] as const) {
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props(lang), reply: { ...reply, deliveries: [q('q1'), q('q2')] } as never }))) })
    const col = document.querySelector('[data-live-column="queue"]')!
    expect(col.querySelectorAll('[data-live-card]').length).toBe(2)
    for (const card of Array.from(col.querySelectorAll('[data-live-card]'))) expect(card.querySelectorAll('[data-live-priority]').length).toBe(1)
    expect(col.querySelectorAll('[data-live-priority]').length).toBe(2)
    expect(col.querySelector('[data-live-queue-priority]')).toBeNull()
    expect(col.querySelector('select, [role="combobox"], [role="listbox"], [aria-haspopup]')).toBeNull()
    expect(col.textContent).not.toMatch(/Prioridade \(muda|changes the leaving order/)
    await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
  }
})

test('MED 6 (live worker fixture): clicking a worker in the leaders strip scrolls the BOARD sideways to its card and never moves the page', async () => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const had = { rect: proto.getBoundingClientRect, sw: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'), st: proto.scrollTo }
  const boardScrolls: { left?: number }[] = []
  const pageScrolls: unknown[] = []
  const intoView: unknown[] = []
  // happy-dom has no layout: the board is 1000 wide inside a 3000 wide scroller and the target card sits far to the right.
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const card = this.hasAttribute('data-live-card')
    return { left: card ? 1700 : 0, top: 0, width: card ? 300 : 1000, height: 200, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }
  }
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 3000 })
  proto.scrollTo = function (o: { left?: number }) { boardScrolls.push(o) }
  const realWinScroll = window.scrollTo
  window.scrollTo = ((...a: unknown[]) => { pageScrolls.push(a) }) as never
  const realIntoView = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (this: Element) { intoView.push(this) } as never
  try {
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const withLeader = { ...reply, leaders: [
      { id: 'L', title: 'Motor', harness: 'claude', model: 'claude-opus-5-5', state: 'working', currentAction: null, workers: [{ id: 'w2', title: 'worker b', state: 'working', stage: 'qa', word: 'working', cardKey: 't/b', subtask: 'Piece B' }], awaiting: [] },
    ] }
    await act(async () => { root!.render(createElement(Router, null, createElement(Live, { ...props('en'), reply: withLeader as never }))) })
    await act(async () => (document.getElementById('live-leaders-head') as HTMLElement).click())
    const leader = document.querySelector('[data-live-leader="L"]')!
    if (leader.getAttribute('data-open') !== '1') await act(async () => (leader.querySelector('button') as HTMLElement).click())
    const worker = document.querySelector('[data-live-worker="w2"]') as HTMLElement
    expect(worker).not.toBeNull()
    expect(worker.querySelector('[data-live-worker-info]')!.textContent).not.toBe('no card on the board')
    boardScrolls.length = 0
    await act(async () => { worker.click(); await new Promise(r => setTimeout(r, 120)) })
    // the dropdown closed and the board was asked to bring the card into view horizontally: 1700 - (1000 - 300) / 2 = 1350
    expect(document.querySelector('[data-live-leaders]')!.getAttribute('data-open')).toBe('0')
    expect(boardScrolls.length).toBeGreaterThan(0)
    expect(boardScrolls[boardScrolls.length - 1]!.left).toBe(1350)
    // ... and nothing scrolled the page: neither window.scrollTo nor an element scrollIntoView on the card
    expect(pageScrolls).toEqual([])
    expect(intoView.filter(e => (e as HTMLElement).hasAttribute?.('data-live-card'))).toEqual([])
  } finally {
    proto.getBoundingClientRect = had.rect
    if (had.sw) Object.defineProperty(proto, 'scrollWidth', had.sw); else delete proto.scrollWidth
    proto.scrollTo = had.st
    window.scrollTo = realWinScroll
    Element.prototype.scrollIntoView = realIntoView
  }
})
