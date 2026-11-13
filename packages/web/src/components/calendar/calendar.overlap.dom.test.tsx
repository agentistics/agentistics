import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { brtDayStartMs, buildCalendar, filterCalendar } from '@agentistics/core'
import { MobileDayGrid, phoneEvents } from './MobileDayGrid'
import { embeddedIsWide } from './DeliveryCalendar'

const H = 3600_000
const NOW = Date.parse('2026-11-11T15:00:00.000Z') // Wed 11/11 12h BRT
const DAY = '2026-11-13'
const live = (i: number, startMs: number, publishMs: number) => ({
  key: `t/${i}`, taskId: 't', taskTitle: 'Esteira', subtaskId: `s${i}`, title: `Peça ${i}`, stage: 'qa' as const, startedAtMs: startMs, stageSinceMs: startMs,
  harnesses: ['claude'], models: ['opus'], trail: [],
  eta: { kind: 'none' as const, reason: 'no-history' }, stageEta: { kind: 'none' as const }, publishEta: { kind: 'estimate' as const, atMs: publishMs }, deliveredAtMs: null,
})
const build = (lives: ReturnType<typeof live>[]) => {
  const reply = buildCalendar({ nowMs: NOW, lives, records: [], tasks: [{ id: 't', title: 'Esteira', status: 'in_progress' }], subtasks: [], resets: [] })
  return filterCalendar(reply, {})
}
const noop = () => {}

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())
const mount = async (el: React.ReactElement) => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(el) })
}
const withWidth = async (w: number, fn: () => Promise<void>) => {
  const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => w })
  try { await fn() } finally { if (d) Object.defineProperty(HTMLElement.prototype, 'clientWidth', d); else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth }
}

test('a piece that covers the whole day has no hour: it is all-day, never a full-height block', async () => {
  // started two days before, expected a day after: on DAY it spans 00h00 -> 24h00
  const d0 = brtDayStartMs(DAY)
  const v = build([live(1, d0 - 2 * 86_400_000, d0 + 2 * 86_400_000)])
  const ev = phoneEvents(DAY, { nowMs: NOW, pieces: v.pieces, versions: v.versions, marks: v.marks })
  expect(ev.find(e => e.id === 't/1')?.allDay).toBe(true)
  await mount(createElement(MobileDayGrid, { nowMs: NOW, pieces: v.pieces, versions: v.versions, marks: v.marks, pt: true, anchor: DAY, span: 1, onDay: noop, onOpen: noop }))
  expect(document.querySelector('[data-cal-phone-event="t/1"]')).toBeNull()
  expect(document.querySelector('[data-cal-allday-band]')?.textContent ?? '').toContain('Peça 1')
})

test('a timed piece is not all-day', () => {
  const d0 = brtDayStartMs(DAY)
  const v = build([live(2, d0 + 10 * H, d0 + 12 * H)])
  expect(phoneEvents(DAY, { nowMs: NOW, pieces: v.pieces, versions: v.versions, marks: v.marks }).find(e => e.id === 't/2')?.allDay).toBe(false)
})

test('22 pieces overlapping in one day stay inside the day column as one card + a +N chip, never 22 side-by-side lanes', async () => {
  const d0 = brtDayStartMs(DAY)
  const v = build(Array.from({ length: 22 }, (_, i) => live(i, d0 + 10 * H, d0 + 11 * H)))
  await withWidth(300, async () => {
    await mount(createElement(MobileDayGrid, { nowMs: NOW, pieces: v.pieces, versions: v.versions, marks: v.marks, pt: true, anchor: DAY, span: 1, onDay: noop, onOpen: noop }))
    expect(document.querySelector('[data-cal-lanes]')).toBeNull()
    const col = document.querySelector('[data-cal-grid-day]')!
    const cards = Array.from(col.querySelectorAll<HTMLElement>('[data-cal-phone-event]'))
    expect(cards.length).toBe(1)
    expect(cards[0]!.style.width).toBe('100%')
    const chip = col.querySelector<HTMLElement>('[data-cal-phone-more]')!
    expect(chip.getAttribute('data-cal-phone-more')).toBe('21')
    // the chip opens the full lane view (sideways scroll) and a collapse brings the stack back
    await act(async () => { (chip as HTMLButtonElement).click() })
    expect(document.querySelector('[data-cal-lanes]')).not.toBeNull()
    await act(async () => { (document.querySelector('[data-cal-spread-collapse]') as HTMLButtonElement).click() })
    expect(document.querySelector('[data-cal-lanes]')).toBeNull()
  })
})

test('the embedded calendar chooses its layout by the panel width: a wide band is the desktop layout, a side column the phone one', () => {
  expect(embeddedIsWide(400)).toBe(false)
  expect(embeddedIsWide(899)).toBe(false)
  expect(embeddedIsWide(900)).toBe(true)
  expect(embeddedIsWide(1100)).toBe(true)
})

test('week: an all-day piece is listed once per day it covers in the all-day band, not once per day of the week for every day', async () => {
  const d0 = brtDayStartMs('2026-11-09')
  // covers Mon 09 .. Wed 11 entirely (the week's other days: nothing)
  const v = build([live(7, d0 - D2, d0 + 4 * D2)])
  const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']
  const expected = days.filter(d => phoneEvents(d, { nowMs: NOW, pieces: v.pieces, versions: v.versions, marks: v.marks }).some(e => e.allDay)).length
  expect(expected).toBeGreaterThan(0)
  await mount(createElement(MobileDayGrid, { nowMs: NOW, pieces: v.pieces, versions: v.versions, marks: v.marks, pt: true, anchor: '2026-11-11', span: 7, onDay: noop, onOpen: noop }))
  const band = document.querySelector('[data-cal-allday-band]')!
  expect(band.querySelector(`[aria-label$="· ${expected}"]`)).not.toBeNull()
})
const D2 = 86_400_000
