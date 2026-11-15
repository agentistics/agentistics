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
import { dayAxis, dayFocusMs } from '../../lib/cronogramaTree'
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
const css = () => readFileSync(new URL('./cronograma.css', import.meta.url), 'utf8')
const EARLY = Date.parse('2026-11-14T03:30:00.000Z') // Sat 14/11 00h30 BRT

test('week: every subtask bar marks its phase chip sticky', async () => {
  await mount(createElement(Week, { anchor: '2026-11-14', nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  const old = document.querySelector('[data-cal-row="t/old1"] [data-cal-phase]')!
  expect(old.hasAttribute('data-sticky')).toBe(true)
  // A bar INSIDE the axis can still start off screen (the axis opens scrolled to now), so the chip is sticky on every subtask bar.
  expect(document.querySelector('[data-cal-row="t/act"] [data-cal-phase]')!.hasAttribute('data-sticky')).toBe(true)
})

test('css: the sticky chip stays whole beside the title column, and the clipped bar no longer cuts it', () => {
  expect(css()).toMatch(/\.crono-bar>\.crono-phw>\.crono-stk\{position:sticky;left:calc\(var\(--LW\)[^}]*margin-right:calc\(var\(--cw\)/)
  expect(css()).toMatch(/\.crono-bar\[data-kind="sub"\]\{overflow:visible\}/)
})

test('day axis: on today it reaches back to the hour of now (00h30 opens at 00h, never 07h)', () => {
  const day = '2026-11-14'
  expect(dayAxis(day, [], EARLY).units).toBe(24)
  expect(dayAxis(day, [], NOW).units).toBe(24 - 7) // 15h39: the usual 07h start
  expect(dayAxis('2026-11-13', [], EARLY).units).toBe(24 - 7) // not today: now is irrelevant
})

test('day focus: now on today; the first activity of that day on any other day', () => {
  const d0 = Date.parse('2026-11-13T03:00:00.000Z') // 00h BRT on the 13th
  const ax = dayAxis('2026-11-13', [{ startMs: d0 + 10.5 * H, endMs: d0 + 12 * H, delivered: true }], NOW)
  expect(dayFocusMs('2026-11-13', [{ startMs: d0 + 10.5 * H, endMs: d0 + 12 * H, delivered: true }], NOW, ax.startMs)).toBe(d0 + 10.5 * H)
  expect(dayFocusMs('2026-11-14', [], NOW, 0)).toBe(NOW)
  expect(dayFocusMs('2026-11-13', [], NOW, 123)).toBe(123)
})

test('day (DOM): at 00h30 the hour header starts at 00h', async () => {
  await mount(createElement(Day, { day: '2026-11-14', nowMs: EARLY, pieces, pt: true, selected: null, onOpenPiece: noop }))
  expect(document.querySelector('[data-cal-hour]')!.textContent).toBe('00h')
  expect(document.querySelector('[data-cal-now]')).not.toBeNull()
})

test('phone: the Day footer is not hidden behind the bottom navigation', () => {
  expect(css()).toMatch(/@media \(max-width:700px\)\{[^]*\.crono-tl\{max-height:calc\(100dvh/)
})
