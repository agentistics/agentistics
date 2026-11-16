import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { buildCalendar } from '@agentistics/core'
import { dayAxis, fillSplit, weekAxis, type Span } from '../../lib/cronogramaTree'

const NOW = Date.parse('2026-11-14T18:39:00.000Z') // Sat 14/11 15h39 BRT
const H = 3600_000
const live = (sub: string, stage: 'qa' | 'queue' | 'running' | 'published', o: Record<string, unknown> = {}) => ({
  key: `t/${sub}`, taskId: 't', taskTitle: 'Engine', subtaskId: sub, title: `Peça ${sub}`, stage, startedAtMs: NOW - 5 * H, stageSinceMs: NOW - H,
  harnesses: [], models: [], trail: [], eta: { kind: 'none' as const }, stageEta: { kind: 'none' as const }, publishEta: { kind: 'none' as const },
  deliveredAtMs: stage === 'published' ? NOW - 2 * H : null, ...o,
})
const { pieces } = buildCalendar({
  nowMs: NOW,
  lives: [live('act', 'running'), live('cont', 'running', { startedAtMs: NOW - 20 * H, stageSinceMs: NOW - 20 * H, publishEta: { kind: 'estimate' as const, atMs: NOW + 4 * H, confidence: 'low' as const } }), live('old1', 'running', { startedAtMs: NOW - 30 * 24 * H, stageSinceMs: NOW - 30 * 24 * H })],
  records: [], tasks: [{ id: 't', title: 'Engine', status: 'in_progress' }], subtasks: [], resets: [],
})

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Week: typeof import('./ScheduleView').ScheduleView
let Day: typeof import('./DayView').DayView
let store: typeof import('../../lib/cronogramaCollapsed').cronogramaCollapsedStore
beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Week = (await import('./ScheduleView')).ScheduleView
  Day = (await import('./DayView')).DayView
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

// ── 1. the solid / hatched boundary is computed on the CLIPPED bar ──
const DAY = '2026-11-14'
const ax = dayAxis(DAY, [], NOW) // 07h..24h
const longSpan: Span = { startMs: NOW - 10 * 24 * H, endMs: NOW + 10 * 24 * H, delivered: false } // started 10 days ago, ends in 10 days

test('fillSplit: a span clipped at the left puts the boundary exactly at "now" on the drawn bar', () => {
  const { solidPct, expectedPct } = fillSplit(ax, longSpan, NOW, true)
  // drawn bar = whole axis (07h → 24h, 17 units); now = 15h39 → 8.65 units from the axis start
  expect(solidPct).toBeCloseTo((8.65 / 17) * 100, 1)
  expect(solidPct + expectedPct).toBeCloseTo(100, 5)
})

test('fillSplit: a PAST day never has a hatched tail; a span that has not begun is all expected', () => {
  const past = dayAxis('2026-11-13', [], NOW)
  const s = fillSplit(past, longSpan, NOW, true)
  expect(s.solidPct).toBe(100)
  expect(s.expectedPct).toBe(0)
  const future: Span = { startMs: NOW + 2 * H, endMs: NOW + 4 * H, delivered: false }
  expect(fillSplit(ax, future, NOW, true)).toEqual({ solidPct: 0, expectedPct: 100 })
})

test('fillSplit: delivered is all solid; week axis clips at the left edge too', () => {
  expect(fillSplit(ax, { ...longSpan, delivered: true }, NOW, false)).toEqual({ solidPct: 100, expectedPct: 0 })
  const wk = weekAxis('2026-11-09')
  const w = fillSplit(wk, longSpan, NOW, true) // now = day 5.65 of 7 shown
  expect(w.solidPct).toBeCloseTo((wk.units && (5.65 / wk.units) * 100) || 0, 0)
})

test('day (DOM): a past day paints no hatched segment, and the solid fill of a clipped bar ends at now', async () => {
  await mount(createElement(Day, { day: '2026-11-13', nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  expect(document.querySelector('[data-cal-seg="expected"]')).toBeNull()
  await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''
  await mount(createElement(Day, { day: DAY, nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  const fill = document.querySelector<HTMLElement>('[data-cal-bar-piece="t/cont"] .crono-fill')!
  const prev = document.querySelector<HTMLElement>('[data-cal-bar-piece="t/cont"] [data-cal-seg="expected"]')
  expect(parseFloat(fill.style.width)).toBeCloseTo((8.65 / 12.65) * 100, 0) // axis 07h, now 15h39 (8.65), expected end 19h39 (12.65)
  expect(parseFloat(fill.style.width) + (prev ? parseFloat(prev.style.width) : 0)).toBeCloseTo(100, 3)
})

// ── 2/3/5. the overlays: % pin, chip + checkbox, hint ──
test('week: the sub chip, checkbox and the task % live in their sticky overlay wrappers', async () => {
  await mount(createElement(Week, { anchor: DAY, nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  const bar = document.querySelector('[data-cal-bar-piece="t/old1"]')!
  const phw = bar.querySelector('.crono-phw')!
  expect(phw.querySelector('.crono-stk [data-cal-phase]')).not.toBeNull()
  expect(phw.querySelector('.crono-stk [data-cal-cb]')).not.toBeNull() // checkbox travels WITH the chip
  const pw = document.querySelector('[data-cal-bar="task"] .crono-pw')!
  expect(pw.querySelector('[data-cal-pin] [data-cal-pct]')).not.toBeNull()
})

test('day (DOM): the sub hint sits in the sticky stack beside chip and checkbox, not at the bar end', async () => {
  await mount(createElement(Day, { day: DAY, nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  const hint = document.querySelector('[data-cal-bar-piece="t/cont"] [data-cal-hint]')!
  expect(hint.closest('.crono-stk')).not.toBeNull()
})

test('css: overlays are absolute and stick beside the title column (static/in-flow would hide them again)', () => {
  expect(css()).toMatch(/\.crono-bar>\.crono-phw\{position:absolute;/)
  expect(css()).toMatch(/\.crono-bar>\.crono-pw\{position:absolute;/)
  expect(css()).toMatch(/\.crono-bar>\.crono-pw>\.crono-pin\{position:sticky;left:calc\(var\(--LW\)[^}]*margin-right:calc\(var\(--cw\)/)
  expect(css()).toMatch(/\.crono-bar>\.crono-phw>\.crono-stk\{position:sticky;left:calc\(var\(--LW\)[^}]*margin-right:calc\(var\(--cw\)/)
})

// ── 5. ressalva A ──
test('day axis: on today it opens at least one hour before now, so the now line has room on its left', () => {
  const early = Date.parse('2026-11-14T05:30:00.000Z') // 02h30 BRT
  expect(dayAxis(DAY, [], early).startMs).toBe(Date.parse('2026-11-14T04:00:00.000Z')) // 01h
  expect(dayAxis(DAY, [], Date.parse('2026-11-14T03:30:00.000Z')).units).toBe(24) // 00h30 → 00h
})

test('fillSplit: a blip drawn at its minimum width still puts the boundary at now, on the DRAWN width', () => {
  const blip: Span = { startMs: NOW - 5 * 60_000, endMs: NOW + 10 * 60_000, delivered: false } // 15 min < 0.35 of a 1h column? no: 0.25 unit
  const { solidPct } = fillSplit(ax, blip, NOW, true)
  expect(solidPct).toBeCloseTo((0.0833 / 0.35) * 100, 0)
})

// ── r5: the overlays must LEAVE with their bar (no ghost chip over empty timeline) ──
import { overlayGone, OVERLAY_EDGE } from '../../lib/cronogramaTree'

test('css r5: the overlay margin never lets the stack outlive its bar (no "+ 10px" slack)', () => {
  const c = css()
  expect(c).toMatch(/\.crono-bar>\.crono-pw>\.crono-pin\{[^}]*margin-right:calc\(var\(--cw\) \* -1\)[;}]/)
  expect(c).toMatch(/\.crono-bar>\.crono-phw>\.crono-stk\{[^}]*margin-right:calc\(var\(--cw\) \* -1\)[;}]/)
  expect(c).not.toMatch(/margin-right:calc\(var\(--cw\) \* -1 \+ 10px\)/)
  expect(c).toMatch(/\.crono-bar\[data-gone\] \.crono-stk,\.crono-bar\[data-gone\] \.crono-pin\{visibility:hidden\}/)
})

test('overlayGone: hidden once the bar shows less than the edge past the title column', () => {
  expect(overlayGone(200, 172)).toBe(false) // 28px of bar visible
  expect(OVERLAY_EDGE).toBe(10)
  expect(overlayGone(182, 172)).toBe(false) // 10px left: still shown (a stack starts 8px after the title column)
  expect(overlayGone(181, 172)).toBe(true)
  expect(overlayGone(100, 172)).toBe(true) // bar ended behind the title column
})

test('day (DOM): scrolling a bar out under the title column marks it data-gone; scrolling back restores it', async () => {
  await mount(createElement(Day, { day: DAY, nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  const tl = document.querySelector<HTMLElement>('.crono-tl')!
  const lw = document.querySelector<HTMLElement>('.crono-hrow .crono-lc')!
  const bar = document.querySelector<HTMLElement>('[data-cal-bar-piece="t/cont"]')!
  const rect = (right: number) => ({ left: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, right, toJSON() {} }) as DOMRect
  lw.getBoundingClientRect = () => rect(172)
  bar.getBoundingClientRect = () => rect(100)
  await act(async () => { tl.dispatchEvent(new window.Event('scroll')); await new Promise(r => setTimeout(r, 50)) })
  expect(bar.hasAttribute('data-gone')).toBe(true)
  bar.getBoundingClientRect = () => rect(400)
  await act(async () => { tl.dispatchEvent(new window.Event('scroll')); await new Promise(r => setTimeout(r, 50)) })
  expect(bar.hasAttribute('data-gone')).toBe(false)
})

test('css r5: the overlays paint above the now line (z-index 5 > 4), so the red line never crosses a chip', () => {
  const c = css()
  expect(c).toMatch(/\.crono-bar>\.crono-phw\{[^}]*z-index:5\}/)
  expect(c).toMatch(/\.crono-bar>\.crono-pw\{[^}]*z-index:5\}/)
})

test('day (DOM): on a PAST day the task-bar hint never says "previsto"; today it still does', async () => {
  await mount(createElement(Day, { day: '2026-11-13', nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  const hints = Array.from(document.querySelectorAll('[data-cal-bar="task"] [data-cal-hint]')).map(h => h.textContent ?? '')
  expect(hints.length).toBeGreaterThan(0)
  expect(hints.some(h => h.includes('previsto'))).toBe(false)
  await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''
  await mount(createElement(Day, { day: DAY, nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  expect(Array.from(document.querySelectorAll('[data-cal-bar="task"] [data-cal-hint]')).some(h => (h.textContent ?? '').includes('previsto'))).toBe(true)
})
