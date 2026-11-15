import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { buildCalendar, pieceDayPresence, type CalPiece } from '@agentistics/core'

const NOW = Date.parse('2026-11-14T18:39:00.000Z') // Sat 14/11 15h39 BRT
const H = 3600_000
const live = (sub: string, stage: 'qa' | 'queue' | 'running' | 'published', o: Record<string, unknown> = {}) => ({
  key: `t/${sub}`, taskId: 't', taskTitle: 'Engine', subtaskId: sub, title: `Peça ${sub}`, stage, startedAtMs: NOW - 5 * H, stageSinceMs: NOW - H,
  harnesses: [], models: [], trail: [], eta: { kind: 'none' as const }, stageEta: { kind: 'none' as const }, publishEta: { kind: 'none' as const },
  deliveredAtMs: stage === 'published' ? NOW - 2 * H : null, ...o,
})
const { pieces } = buildCalendar({
  nowMs: NOW,
  lives: [
    live('act', 'running'), live('old1', 'running', { startedAtMs: NOW - 30 * 24 * H, stageSinceMs: NOW - 30 * 24 * H }),
    live('old2', 'running', { startedAtMs: NOW - 20 * 24 * H, stageSinceMs: NOW - 20 * 24 * H }), live('r3', 'queue', { startedAtMs: null, stageSinceMs: null }),
  ],
  records: [], tasks: [{ id: 't', title: 'Engine', status: 'in_progress' }], subtasks: [], resets: [],
})

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Week: typeof import('./ScheduleView').ScheduleView
let Day: typeof import('./DayView').DayView
let Grid: typeof import('./MobileDayGrid')
let Phone: typeof import('./MobileCalendar').MobileCalendar
let store: typeof import('../../lib/cronogramaCollapsed').cronogramaCollapsedStore

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Week = (await import('./ScheduleView')).ScheduleView
  Day = (await import('./DayView')).DayView
  Grid = await import('./MobileDayGrid')
  Phone = (await import('./MobileCalendar')).MobileCalendar
  store = (await import('../../lib/cronogramaCollapsed')).cronogramaCollapsedStore
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; store.set([]) })
afterAll(async () => GlobalRegistrator.unregister())
const mount = async (el: React.ReactElement) => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(el) })
}
const noop = () => {}
const dayProps = { day: '2026-11-14', nowMs: NOW, pieces, selected: null, onOpenPiece: noop }

test('day: only pieces with activity today are rows, and the footer says how many were left out', async () => {
  await mount(createElement(Day, { ...dayProps, pt: true }))
  const keys = Array.from(document.querySelectorAll('[data-cal-piece-row]')).map(e => e.getAttribute('data-cal-piece-row')).sort()
  expect(keys).toEqual(['t/act', 't/r3'])
  const foot = document.querySelector('[data-cal-foot]')!.textContent!
  expect(foot).toContain('Cada linha é uma peça com atividade hoje')
  expect(foot).toContain('2 peças sem atividade hoje ficam fora.')
})

test('day (en): the same footer clause in English', async () => {
  await mount(createElement(Day, { ...dayProps, pt: false }))
  expect(document.querySelector('[data-cal-left-out]')!.textContent).toBe('2 pieces with no activity today left out.')
})

test('week: the "sem data" chip sits on TODAY\'s column (Mon 9 → Sat 14 is the 6th, index 5), not at column 0', async () => {
  await mount(createElement(Week, { anchor: '2026-11-14', nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  const chip = document.querySelector<HTMLElement>('[data-cal-row="t/r3"] [data-cal-chip="no-date"]')!
  expect(chip.style.marginLeft).toContain('* 5')
  expect(chip.style.marginLeft).not.toBe('6px')
})

test('week: the % and ring of a task bar are in the pinned wrapper (sticky beside the title column)', async () => {
  await mount(createElement(Week, { anchor: '2026-11-14', nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  const pin = document.querySelector('[data-cal-bar="task"] [data-cal-pin]')!
  expect(pin.querySelector('[data-cal-pct]')).not.toBeNull()
  expect(pin.querySelector('[data-cal-ring]')).not.toBeNull()
  const css = readFileSync(new URL('./cronograma.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.crono-bar>\.crono-pw>\.crono-pin\{position:sticky;left:calc\(var\(--LW\)/)
})

test('hover keeps the title column OPAQUE: the tint is mixed over --bg-card, never over transparent', () => {
  const css = readFileSync(new URL('./cronograma.css', import.meta.url), 'utf8')
  const rule = css.split('\n').find(l => l.includes('.crono-row:hover .crono-lc'))!
  expect(rule).toContain('var(--bg-card))')
  expect(rule).not.toContain('transparent')
})

// A piece with NO start and a publish ETA past midnight: the QA probe (probe-phone.ts).
const SAT_NIGHT = Date.parse('2026-11-14T23:00:00.000Z') // 20h BRT
const noStart = { key: 't/x', taskId: 't', taskTitle: 'T', subtaskId: 'x', title: 'Peça x', stage: 'queue', startedAtMs: null, stageSinceMs: null,
  harnesses: [], models: [], trail: [], stageEta: { kind: 'none' }, publishEta: { kind: 'estimate', atMs: SAT_NIGHT + 10 * H, confidence: 'medium' },
  publishedAtMs: null, version: null, priority: null, confirmed: false, late: false } as unknown as CalPiece

test('phone: a continued piece with no known start carries null, never undefined (which would print 00h00)', () => {
  expect(pieceDayPresence(noStart, '2026-11-15', SAT_NIGHT)[0]!.continued).toBe(true)
  const ev = Grid.phoneEvents('2026-11-15', { nowMs: SAT_NIGHT, pieces: [noStart], versions: [], marks: [] })
  expect(ev).toHaveLength(1)
  expect(ev[0]!.continuedFromMs).toBeNull()
})

test('phone Semana / 3 dias: that card never shows 00h00', async () => {
  for (const span of [7, 3] as const) {
    await mount(createElement(Grid.MobileDayGrid, { anchor: '2026-11-15', nowMs: SAT_NIGHT, versions: [], pieces: [noStart], marks: [], pt: true, span, onDay: noop, onOpen: noop }))
    const cards = document.querySelectorAll('[data-cal-phone-event]')
    expect(cards.length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('00h00')
    await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
  }
})

test('phone Dia renders the tree body, not the old hour grid or the week strip', async () => {
  await mount(createElement(Phone, {
    nowMs: NOW, pt: true, anchor: '2026-11-14', view: 'day' as const, ready: true, body: createElement('div', { 'data-test-tree': '' }), filters: null, filterCount: 0,
    exportIcs: noop, onOpen: noop, onDay: noop, onView: noop, versions: [], pieces, marks: [],
  }))
  expect(document.querySelector('[data-test-tree]')).not.toBeNull()
  expect(document.querySelector('[data-cal-mobile-grid]')).toBeNull()
  expect(document.querySelector('[data-cal-week-strip]')).toBeNull()
})
