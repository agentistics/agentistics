import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { FleetRow } from '../../lib/fleet'

/** Part A of the Esteira: the filter bar, the vertical columns with their own scroll and search, the priority chip and the order. */

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom').MemoryRouter
let Live: typeof import('./LiveDelivery').LiveDeliveryView
let realRect: typeof HTMLElement.prototype.getBoundingClientRect

const NOW = Date.now()
const rows: FleetRow[] = [
  { id: 's1', title: 's1', harness: 'claude', cwd: '/', project: 'p', state: 'working', stateLabel: 'working', actionable: true, model: 'opus' } as FleetRow,
]
const piece = (key: string, stage: string, over: Record<string, unknown> = {}) => ({
  key, taskId: 't', taskTitle: 'Task', subtaskId: key, title: `Piece ${key}`, status: 'in_progress', stage, stageSinceMs: NOW - 5 * 60_000, startedAtMs: NOW - 10 * 60_000,
  sessionIds: [] as string[], harnesses: [] as string[], models: [] as string[], eta: { kind: 'none', reason: 'no-history' }, lastAction: null, blockedReason: null, deliveredAtMs: null, priority: 'low', ...over,
})
const replyOf = (deliveries: unknown[]) => ({ generatedAt: new Date().toISOString(), samples: 0, deliveries })
const props = (lang: 'pt' | 'en', reply: unknown) => ({ lang, reply: reply as never, error: null, nowMs: NOW, fleet: rows, accountLabels: {} })

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Router = (await import('react-router-dom')).MemoryRouter
  Live = (await import('./LiveDelivery')).LiveDeliveryView
  realRect = HTMLElement.prototype.getBoundingClientRect
})
beforeEach(() => { localStorage.clear() })
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; HTMLElement.prototype.getBoundingClientRect = realRect; localStorage.clear() })
afterAll(async () => GlobalRegistrator.unregister())

const mount = async (p: ReturnType<typeof props>) => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Live, p))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
}
const keysIn = (stage: string) => Array.from(document.querySelectorAll(`[data-live-column="${stage}"] [data-live-card]`)).map(e => e.getAttribute('data-live-card'))

test('the title is translated: pt says "Esteira de entregas ao vivo", en keeps "Live Delivery"', async () => {
  await mount(props('pt', replyOf([piece('a', 'running')])))
  expect(document.querySelector('[data-live-toolbar]')!.textContent).toContain('Esteira de entregas ao vivo')
  expect(document.body.textContent).not.toContain('Live Delivery')
  await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
  await mount(props('en', replyOf([piece('a', 'running')])))
  expect(document.querySelector('[data-live-toolbar]')!.textContent).toContain('Live Delivery')
})

test('the stage columns carry the new names: "Em desenvolvimento" and "QA"', async () => {
  await mount(props('pt', replyOf([piece('a', 'running'), piece('b', 'qa')])))
  const head = (s: string) => document.querySelector(`[data-live-column="${s}"] [data-live-colhead]`)!.textContent
  expect(head('running')).toContain('Em desenvolvimento')
  expect(head('qa')).toContain('QA')
  expect(head('qa')).not.toContain('Em QA')
  expect(document.body.textContent).not.toContain('Executando')
})

test('ONE bar, two groups: filters (tasks, steps, apenas ativas, fila, order) and view/actions (older reviews, window)', async () => {
  const withArchive = { ...replyOf([piece('a', 'running')]), archivedTotal: 3, archived: [] }
  await mount(props('pt', withArchive))
  const bar = document.querySelector('[data-live-toolbar]')!
  const filters = bar.querySelector('[data-live-filters]')!, actions = bar.querySelector('[data-live-actions]')!
  expect(filters.querySelector('[data-live-taskfilter]')).not.toBeNull()
  expect(filters.querySelector('[data-live-allsteps]')).not.toBeNull()
  expect(filters.querySelector('[data-live-only-active]')).not.toBeNull()
  expect(filters.querySelector('[data-live-show-queue]')).not.toBeNull()
  expect(filters.textContent).toContain('Ordenar')
  expect(actions.querySelector('[data-live-archived-toggle]')).not.toBeNull()
  expect(actions.querySelector('[data-live-external]')).not.toBeNull()
  // nothing from the right-hand group leaks into the filters, and the other way round
  expect(filters.querySelector('[data-live-external]')).toBeNull()
  expect(actions.querySelector('[data-live-only-active]')).toBeNull()
  // the summary line is short: no ETA sentence in the line itself (it is the tooltip)
  const sum = document.querySelector('[data-live-summary]') as HTMLElement
  expect(sum.textContent).toBe('1 entrega ativa · 0 agentes trabalhando')
  expect(sum.getAttribute('title')).toContain('atualizado ao vivo')
})

test('a QUEUED piece (never has an agent) is shown with the chips on; "exibir itens na fila" switches the column and is remembered', async () => {
  await mount(props('pt', replyOf([piece('q', 'queue'), piece('r', 'running')])))
  const show = () => document.querySelector('[data-live-show-queue]') as HTMLElement
  expect(show().textContent).toContain('Exibir itens na fila')
  expect(show().getAttribute('aria-pressed')).toBe('true')
  expect(keysIn('queue')).toEqual(['q'])
  await act(async () => show().click())
  expect(keysIn('queue')).toEqual([])
  expect(keysIn('running')).toEqual(['r'])
  expect(JSON.parse(localStorage.getItem('agentistics.live.view.v1')!)).toMatchObject({ onlyActive: true, showQueue: false })
  await act(async () => show().click())
  expect(keysIn('queue')).toEqual(['q'])
})

test('the four combinations of the two chips on screen', async () => {
  const all = replyOf([piece('q', 'queue'), piece('b', 'blocked'), piece('r', 'running'), piece('p', 'published', { deliveredAtMs: NOW })])
  localStorage.setItem('agentistics.live.collapsed.v1', JSON.stringify({ published: false }))
  await mount(props('pt', all))
  const press = async (sel: string) => { await act(async () => (document.querySelector(sel) as HTMLElement).click()) }
  const shown = () => Array.from(document.querySelectorAll('[data-live-card], [data-live-pubrow]')).map(e => e.getAttribute('data-live-card') ?? e.getAttribute('data-live-pubrow')).sort()
  expect(shown()).toEqual(['b', 'p', 'q', 'r'])
  await press('[data-live-show-queue]')
  expect(shown()).toEqual(['b', 'p', 'r'])
  await press('[data-live-only-active]')
  expect(shown()).toEqual([])
  await press('[data-live-show-queue]')
  expect(shown()).toEqual(['q'])
})

test('columns are ONE vertical stack with their own scroll: no grid, no compact rows, no "+N"', async () => {
  const many = Array.from({ length: 30 }, (_, i) => piece(`c${i}`, 'running'))
  await mount(props('en', replyOf(many)))
  const col = document.querySelector('[data-live-column="running"]')!
  expect(col.querySelector('[data-live-more]')).toBeNull()
  expect(col.querySelector('[data-live-less]')).toBeNull()
  expect(col.querySelector('[data-live-subcol]')).toBeNull()
  expect(col.querySelector('[data-live-compact]')).toBeNull()
  expect(col.querySelectorAll('[data-live-card]').length).toBe(30)
  const body = col.querySelector('[data-live-colbody]') as HTMLElement
  expect(body.style.overflowY).toBe('auto')
  // the board (the page) stays horizontal-only
  expect((document.querySelector('[data-live-board]') as HTMLElement).style.overflowY).toBe('hidden')
})

/** A column body 300px tall whose cards are 100px each, stacked: three are in view, the rest scrolled out. */
const layOut = () => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const mk = (top: number, h: number, w = 280) => ({ top, bottom: top + h, left: 0, right: w, width: w, height: h, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    if (this.hasAttribute('data-live-colbody')) return mk(0, 300)
    if (this.hasAttribute('data-live-slot')) return mk(Array.from(this.parentElement!.children).indexOf(this) * 100, 100)
    return realRect.call(this)
  }
}

test('the column search appears only with MORE than three cards out of view, and filters just that column while you type', async () => {
  layOut()
  // 6 cards: 3 in view, 3 out -> no search
  await mount(props('en', replyOf(Array.from({ length: 6 }, (_, i) => piece(`c${i}`, 'running', { title: i === 4 ? 'Billing report' : `Other ${i}` })))))
  expect(document.querySelector('[data-live-col-search="running"]')).toBeNull()
  await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
  // 8 cards: 3 in view, 5 out -> search
  await mount(props('en', replyOf(Array.from({ length: 8 }, (_, i) => piece(`c${i}`, 'running', { title: i === 6 ? 'Billing report' : `Other ${i}` })))))
  const input = document.querySelector('[data-live-col-search="running"]') as HTMLInputElement
  expect(input).not.toBeNull()
  expect(document.querySelector('[data-live-col-search="qa"]')).toBeNull()
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, 'billing'); input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(keysIn('running')).toEqual(['c6'])
  expect((document.querySelector('[data-live-column="running"] [data-live-colhead]') as HTMLElement).textContent).toContain('1/8')
  // the field stays while something is typed, even though only one card is left
  expect(document.querySelector('[data-live-col-search="running"]')).not.toBeNull()
})

test('every card wears the Agentask priority chip, in the reader\'s language; absent reads as low', async () => {
  await mount(props('pt', replyOf([piece('u', 'running', { priority: 'urgent' }), piece('h', 'running', { priority: 'high' }), piece('n', 'running', { priority: undefined })])))
  const chip = (k: string) => document.querySelector(`[data-live-card="${k}"] [data-live-priority]`)!
  expect(chip('u').getAttribute('data-live-priority')).toBe('urgent')
  expect(chip('u').textContent).toBe('Urgente')
  expect(chip('h').textContent).toBe('Alta')
  expect(chip('n').getAttribute('data-live-priority')).toBe('low')
  expect(chip('n').textContent).toBe('Baixa')
})

test('DEFAULT order is highest priority first; "Ordenar" switches to time in stage / most recent and the choice is remembered', async () => {
  const ds = [
    piece('low-old', 'running', { priority: 'low', stageSinceMs: NOW - 90 * 60_000 }),
    piece('urgent-new', 'running', { priority: 'urgent', stageSinceMs: NOW - 1 * 60_000 }),
    piece('high-old', 'running', { priority: 'high', stageSinceMs: NOW - 60 * 60_000 }),
    piece('high-new', 'running', { priority: 'high', stageSinceMs: NOW - 10 * 60_000 }),
  ]
  await mount(props('en', replyOf(ds)))
  expect(keysIn('running')).toEqual(['urgent-new', 'high-old', 'high-new', 'low-old'])
  const trigger = Array.from(document.querySelectorAll('[data-live-filters] button')).find(b => b.textContent?.includes('Sort:')) as HTMLElement
  expect(trigger.textContent).toContain('Priority')
  await act(async () => trigger.click())
  await act(async () => (document.querySelector('[data-live-sort="time-in-stage"]') as HTMLElement).click())
  expect(keysIn('running')).toEqual(['low-old', 'high-old', 'high-new', 'urgent-new'])
  expect(JSON.parse(localStorage.getItem('agentistics.live.view.v1')!).sort).toBe('time-in-stage')
  const again = Array.from(document.querySelectorAll('[data-live-filters] button')).find(b => b.textContent?.includes('Sort:')) as HTMLElement
  await act(async () => again.click())
  await act(async () => (document.querySelector('[data-live-sort="recent"]') as HTMLElement).click())
  expect(keysIn('running')).toEqual(['urgent-new', 'high-new', 'high-old', 'low-old'])
})

test('a queued card says why it waits in plain words; the raw gate text is only the tooltip', async () => {
  const raw = 'no slot: fresh plan_limits reading for codex:acc_9f3a21; 79 workers running (machine ceiling 4)'
  await mount(props('pt', replyOf([piece('q', 'queue', { staged: { harness: 'codex', model: null, effort: null, account: 'acc_9f3a21' }, slot: { ok: false, reason: raw, at: '' } })])))
  const slot = document.querySelector('[data-live-queue-slot]') as HTMLElement
  expect(slot.textContent).toContain('esperando vaga: 79 de 4 sessões em uso')
  expect(slot.textContent).not.toMatch(/plan_limits|acc_|machine ceiling/)
  expect(slot.getAttribute('title')).toBe(raw)
})

test('the task picker opens at least 360px wide, titles clamp to two lines, the count never sits on the text, no duplicated heading', async () => {
  const ds = [
    piece('a', 'running', { taskId: 'ta', taskTitle: 'A very long task title that used to wrap on top of the section label and of the live counter next to it', sessionIds: ['s1'] }),
    piece('b', 'qa', { taskId: 'tb', taskTitle: 'Another task' }),
  ]
  await mount(props('pt', replyOf(ds)))
  const trigger = document.querySelector('[data-live-taskfilter] button[aria-haspopup="listbox"]') as HTMLElement
  expect(trigger.textContent).toContain('Todas as tarefas')
  await act(async () => trigger.click())
  const panel = document.querySelector('[role="listbox"]') as HTMLElement
  expect(panel.style.width).toBe('360px')
  const headings = Array.from(panel.querySelectorAll('[data-multipicker-heading]')).map(h => h.textContent)
  expect(headings).toContain('Recentes (com atividade)')
  expect(headings.filter(h => h === 'Todas as tarefas')).toEqual([])
  const label = Array.from(panel.querySelectorAll('span')).find(s => s.textContent?.startsWith('A very long task title')) as HTMLElement
  expect(label.style.webkitLineClamp || label.getAttribute('style')).toContain('2')
  expect(Number.parseInt(label.style.minWidth, 10)).toBe(0)
  // the count is its own, non-shrinking cell
  const count = Array.from(panel.querySelectorAll('span')).find(s => s.textContent === '1 ativo') as HTMLElement
  expect(count.style.flexShrink).toBe('0')
})
