import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { brtDayStartMs, buildCalendar, filterCalendar, type CalendarReply } from '@agentistics/core'
import { MobileCalendar } from './MobileCalendar'
import { TEXT } from './calendarText'

const H = 3600_000
const NOW = Date.parse('2026-11-11T15:00:00.000Z') // Wed 11/11 12h BRT
const dayMs = (d: string) => brtDayStartMs(d) + 12 * H
const live = (key: string) => ({
  key: `t/${key}`, taskId: 't', taskTitle: 'Esteira', subtaskId: key, title: `Peça ${key}`, stage: 'qa' as const, startedAtMs: NOW - 4 * H, stageSinceMs: NOW - H,
  harnesses: ['claude'], models: ['opus'], trail: [{ stage: 'running' as const, enteredMs: NOW - 4 * H, ms: 3 * H }],
  eta: { kind: 'none' as const, reason: 'no-history' }, stageEta: { kind: 'none' as const }, publishEta: { kind: 'none' as const, reason: 'no-history' }, deliveredAtMs: null,
})
const reply: CalendarReply = buildCalendar({
  nowMs: NOW, lives: [live('a')], records: [{ subtaskId: 'a', taskId: 't', phase: 'qa', versionTarget: '2.202.0' }],
  tasks: [{ id: 't', title: 'Esteira', status: 'in_progress', priority: 'high', dueDate: '2026-11-14' }], subtasks: [], resets: [],
})
const view = filterCalendar(reply, {})

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Month: typeof import('./MonthView').MonthView
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Month = (await import('./MonthView')).MonthView
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())
const mount = async (el: React.ReactElement) => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(el) })
}
const noop = () => {}
const withRowHeight = async (h: number, fn: () => Promise<void>) => {
  const original = HTMLElement.prototype.getBoundingClientRect
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ width: 900, height: h, top: 0, left: 0, right: 900, bottom: h }) })
  try { await fn() } finally { Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: original }) }
}
const base = { ...view.pieces[0]!, version: null, publishedAtMs: null, overdueSinceMs: undefined, late: false }
const startedOn = (day: string, n: number) => Array.from({ length: n }, (_, i) => ({ ...base, key: `st/${day}/${i}`, stage: 'running' as const, startedAtMs: dayMs(day), stageSinceMs: dayMs(day), publishEta: { kind: 'none' as const, reason: 'no-history' } }))
const monthProps = { nowMs: NOW, pt: true, selected: null, anchor: '2026-11-11', onPickDay: noop, onOpenVersion: noop, onOpenMark: noop, onOpenPiece: noop }

test('r5 R3: an urgent deadline on an empty day is drawn although another day of the week is full of started pieces', async () => {
  await withRowHeight(100, async () => {
    const marks = [{ kind: 'task-due' as const, day: '2026-11-14', taskId: 'eng', label: 'Engine completa', priority: 'urgent' as const }]
    await mount(createElement(Month, { ...monthProps, versions: [], marks, pieces: startedOn('2026-11-09', 5) }))
    const row = document.querySelector('[data-cal-day="2026-11-14"]')!.closest('[data-cal-week]')!
    expect(row.querySelector('[data-cal-due="eng"]')).not.toBeNull()
    expect(row.querySelector('[data-cal-more="2026-11-14"]')).toBeNull()
  })
})

test('r5 R3: on one day an urgent deadline outranks predicted chips', async () => {
  await withRowHeight(60, async () => { // 1 row
    const marks = [{ kind: 'task-due' as const, day: '2026-11-13', taskId: 'eng', label: 'Engine completa', priority: 'urgent' as const }]
    const predicted = [{ ...base, key: 'pr/0', stage: 'qa' as const, publishEta: { kind: 'estimate' as const, atMs: dayMs('2026-11-13'), confidence: 'low' as const } }]
    await mount(createElement(Month, { ...monthProps, versions: [], marks, pieces: predicted }))
    const row = document.querySelector('[data-cal-day="2026-11-13"]')!.closest('[data-cal-week]')!
    expect(row.querySelector('[data-cal-due="eng"]')).not.toBeNull()
    expect(row.querySelector('[data-cal-expected-piece]')).toBeNull()
    expect(row.querySelector('[data-cal-more="2026-11-13"]')!.textContent).toBe('+1')
  })
})

test('r5 R4: a version ribbon is drawn at 900px even when a day of its week has many started pieces', async () => {
  await withRowHeight(100, async () => {
    await mount(createElement(Month, { ...monthProps, nowMs: NOW, versions: [{ version: '2.202.0', state: 'published', atMs: dayMs('2026-11-10') } as never], marks: [], pieces: startedOn('2026-11-09', 5) }))
    const row = document.querySelector('[data-cal-day="2026-11-10"]')!.closest('[data-cal-week]')!
    expect(row.querySelector('[data-cal-ribbon="2.202.0"]')).not.toBeNull()
  })
})

test('r5 R1: the phone month draws the overdue badge on today only, with the count and the aria', async () => {
  const late = Array.from({ length: 3 }, (_, i) => ({ ...base, key: `od/${i}`, overdueSinceMs: NOW - (i + 1) * 24 * H, late: true }))
  const props = { nowMs: NOW, pt: true, anchor: '2026-11-11', view: 'month' as const, ready: true, body: null, filters: null, filterCount: 0, exportIcs: noop, onOpen: noop, onDay: noop, onView: noop, versions: [], marks: [] }
  await mount(createElement(MobileCalendar, { ...props, pieces: late }))
  const badges = document.querySelectorAll('[data-cal-phone-month] [data-cal-overdue]')
  expect(badges.length).toBe(1)
  expect(badges[0]!.getAttribute('data-cal-overdue')).toBe('2026-11-11')
  expect(badges[0]!.textContent).toBe('3')
  expect(document.querySelector('[data-cal-phone-month] [data-cal-day="2026-11-11"]')!.getAttribute('aria-label')).toContain('3 atrasadas')
  await act(async () => root?.unmount())
  document.body.innerHTML = ''
  root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => { root!.render(createElement(MobileCalendar, { ...props, pieces: [] })) })
  expect(document.querySelector('[data-cal-phone-month] [data-cal-overdue]')).toBeNull()
})

test("r5 R5: today's dots on the phone month contrast with the orange cell", async () => {
  const props = { nowMs: NOW, pt: true, anchor: '2026-11-11', view: 'month' as const, ready: true, body: null, filters: null, filterCount: 0, exportIcs: noop, onOpen: noop, onDay: noop, onView: noop, versions: [], marks: [] }
  await mount(createElement(MobileCalendar, { ...props, pieces: startedOn('2026-11-11', 2) }))
  const dots = document.querySelectorAll('[data-cal-day="2026-11-11"] [data-cal-dot]')
  expect(dots.length).toBeGreaterThan(0)
  for (const d of Array.from(dots)) expect(d.getAttribute('style')).toContain('--bg-primary')
  const other = startedOn('2026-11-10', 1)
  await act(async () => { root!.render(createElement(MobileCalendar, { ...props, pieces: other })) })
  for (const d of Array.from(document.querySelectorAll('[data-cal-day="2026-11-10"] [data-cal-dot]'))) expect(d.getAttribute('style')).toContain('--anthropic-orange')
})

test('r5 R2: the "+N" title names each kind, in pt and en, singular and plural', () => {
  const z = { total: 0, expected: 0, started: 0, other: 0, overdue: 0 }
  const en = (c: Partial<typeof z>) => TEXT.moreHidden({ ...z, ...c, total: 1 }).en
  const pt = (c: Partial<typeof z>) => TEXT.moreHidden({ ...z, ...c, total: 1 }).pt
  expect(en({ expected: 1 })).toBe('+1 more: 1 expected — open the day')
  expect(en({ started: 4 })).toContain('4 started')
  expect(en({ other: 1 })).toContain('1 version or deadline')
  expect(en({ other: 3 })).toContain('3 versions or deadlines')
  expect(en({ overdue: 2 })).toContain('2 overdue')
  expect(pt({ expected: 1 })).toContain('1 prevista ')
  expect(pt({ expected: 2 })).toContain('2 previstas')
  expect(pt({ started: 1 })).toContain('1 iniciada')
  expect(pt({ started: 2 })).toContain('2 iniciadas')
  expect(pt({ other: 1 })).toContain('1 versão ou prazo')
  expect(pt({ other: 2 })).toContain('2 versões ou prazos')
  expect(pt({ overdue: 1 })).toContain('1 atrasada')
  expect(TEXT.moreHidden({ ...z, total: 9, expected: 4, started: 5 }).en).toBe('+9 more: 4 expected, 5 started — open the day')
})

test('r5 R2: the "+N" title on the month is English and names started pieces', async () => {
  await withRowHeight(60, async () => {
    await mount(createElement(Month, { ...monthProps, pt: false, versions: [], marks: [], pieces: startedOn('2026-11-09', 4) }))
    expect(document.querySelector('[data-cal-more="2026-11-09"]')!.getAttribute('title')).toBe('+3 more: 3 started — open the day')
  })
})
