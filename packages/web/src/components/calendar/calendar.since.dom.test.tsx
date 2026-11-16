import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { buildCalendar, filterCalendar } from '@agentistics/core'
import { MobileDayGrid } from './MobileDayGrid'

// A piece that began two days ago and is expected to publish tomorrow evening: every day surface must say where it REALLY
// started, never the load-time instant an expected block begins at, never "00h00" on either edge of a day, and "→ continua"
// where the day cuts it. The visible text and the aria-label say the same thing.
const NOW = Date.parse('2026-11-07T18:40:00.000Z') // Sat 07/11 15h40 BRT
const H = 3600_000
const START = NOW - 48 * H // Thu 05/11 15h40 BRT
const reply = buildCalendar({
  nowMs: NOW,
  lives: [{
    key: 't/a', taskId: 't', taskTitle: 'Esteira', subtaskId: 'a', title: 'Peça a', stage: 'qa', startedAtMs: START, stageSinceMs: START,
    harnesses: ['claude'], models: ['opus'], trail: [{ stage: 'running' as const, enteredMs: START, ms: 3 * H }],
    eta: { kind: 'estimate' as const, confidence: 'high' as const }, stageEta: { kind: 'none' as const },
    publishEta: { kind: 'estimate' as const, atMs: NOW + 30 * H }, deliveredAtMs: null,
  }],
  records: [{ subtaskId: 'a', taskId: 't', phase: 'qa', versionTarget: '2.202.0' }],
  tasks: [{ id: 't', title: 'Esteira', status: 'in_progress', priority: 'high' }],
  subtasks: [], resets: [],
})
const view = filterCalendar(reply, {})
const common = { nowMs: NOW, versions: view.versions, pieces: view.pieces, marks: view.marks, selected: null }
const noop = () => {}

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Day: typeof import('./DayView').DayView
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Day = (await import('./DayView')).DayView
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())
const mount = async (el: React.ReactElement) => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(el) })
}
const remount = async (el: React.ReactElement) => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; await mount(el) }
const dayView = (day: string, pt: boolean) => createElement(Day, { ...common, pt, day, onOpenPiece: noop })
/** Visible text and aria-label of every bar of the day tree. */
const bars = () => Array.from(document.querySelectorAll('[data-cal-bar]')).map(b => ({ kind: b.getAttribute('data-cal-bar'), text: b.textContent ?? '', aria: b.getAttribute('aria-label') ?? '' }))

test('day tree, a bar that began on another day says since the REAL start, never 00h00, and "→ continua" where the day cuts it', async () => {
  await mount(dayView('2026-11-07', true))
  const all = bars()
  expect(all.length).toBeGreaterThan(0)
  for (const b of all) {
    expect(b.text).not.toContain('00h00'); expect(b.aria).not.toContain('00h00')
    expect(b.text).toContain('desde Qui 05/11 · 15h40'); expect(b.aria).toContain('desde Qui 05/11 · 15h40')
    expect(b.text).toContain('→ continua'); expect(b.aria).toContain('→ continua')
  }
  await remount(dayView('2026-11-07', false))
  for (const b of bars()) { expect(b.text).toContain('since Thu 05/11 · 15h40'); expect(b.text).toContain('→ continues') }
})

test('day tree, the day the piece started keeps its clock and only the cut says it continues', async () => {
  await mount(dayView('2026-11-05', true))
  const sub = bars().find(b => b.kind === 'sub')!
  expect(sub.text).toContain('15h40 → continua')
  expect(sub.text).not.toContain('desde')
  expect(sub.aria).toContain('15h40 → continua')
})

test('day tree, the sub bar aria-label repeats its visible phase and hint', async () => {
  await mount(dayView('2026-11-07', true))
  const el = document.querySelector('[data-cal-bar="sub"]')!
  const phase = el.querySelector('[data-cal-phase]')!.textContent
  const hint = el.querySelector('[data-cal-hint]')!.textContent
  expect(el.getAttribute('aria-label')).toBe(`Peça a · ${phase} · ${hint}`)
})

test('phone card: visible label, title and aria-label all say since the real start, on a continuation day', async () => {
  for (const [pt, word] of [[true, 'desde Qui 05/11 · 15h40'], [false, 'since Thu 05/11 · 15h40']] as const) {
    await remount(createElement(MobileDayGrid, { ...common, pt, anchor: '2026-11-08', span: 1, onDay: noop, onOpen: noop }))
    const card = document.querySelector('[data-cal-phone-event="t/a"]') as HTMLElement
    expect(card.textContent).toContain(word)
    expect(card.getAttribute('title')).toContain(word)
    expect(card.getAttribute('aria-label')).toContain(word)
    for (const s of [card.textContent, card.getAttribute('title'), card.getAttribute('aria-label')]) { expect(s).not.toContain('00h00'); expect(s).not.toContain('07/11') }
  }
})
