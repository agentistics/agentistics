import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { brtDayStartMs, buildCalendar, filterCalendar, type CalendarReply } from '@agentistics/core'
import { stripVersions, versionWhen } from './VersionCards'
import { icsQuery } from './DeliveryCalendar'
import { DEFAULT_FILTERS, filtersActive, readCalendarFilters, toCalFilters } from './CalendarFilters'
import { MobileDayGrid, phoneEvents } from './MobileDayGrid'
import { MobileCalendar } from './MobileCalendar'
import { CalendarDetail } from './CalendarDetail'

const NOW = Date.parse('2026-11-07T18:40:00.000Z') // Sat 07/11 15h40 BRT
const H = 3600_000
const live = (key: string, stage: 'qa' | 'queue' | 'published', publish: number | null, o: Record<string, unknown> = {}) => ({
  key: `t/${key}`, taskId: 't', taskTitle: 'Esteira', subtaskId: key, title: `Peça ${key}`, stage, startedAtMs: NOW - 4 * H, stageSinceMs: NOW - H,
  harnesses: ['claude'], models: ['opus'], trail: [{ stage: 'running' as const, enteredMs: NOW - 4 * H, ms: 3 * H }],
  eta: publish ? { kind: 'estimate' as const, confidence: 'high' as const } : { kind: 'none' as const, reason: 'no-history' },
  stageEta: { kind: 'none' as const }, publishEta: publish ? { kind: 'estimate' as const, atMs: publish } : { kind: 'none' as const, reason: 'no-history' },
  deliveredAtMs: stage === 'published' ? NOW - 2 * H : null, ...o,
})
const reply: CalendarReply = buildCalendar({
  nowMs: NOW,
  lives: [live('a', 'qa', NOW + 6 * H), live('b', 'queue', null), live('c', 'published', null)],
  records: [
    { subtaskId: 'a', taskId: 't', phase: 'qa', versionTarget: '2.202.0' },
    { subtaskId: 'b', taskId: 't', phase: 'fila', versionTarget: '2.203.0' },
    { subtaskId: 'c', taskId: 't', phase: 'publicado', versionTarget: '2.201.1', publishedAt: new Date(NOW - 2 * H).toISOString() },
  ],
  tasks: [{ id: 't', title: 'Esteira', status: 'in_progress', priority: 'high', dueDate: '2026-11-12' }],
  subtasks: [], resets: [{ harness: 'codex', account: 'a', label: 'ChatGPT', window: '5h', resetsAt: NOW + 30 * 60_000 }],
})
const view = filterCalendar(reply, {})

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Month: typeof import('./MonthView').MonthView
let Schedule: typeof import('./ScheduleView').ScheduleView
let Day: typeof import('./DayView').DayView
let Agenda: typeof import('./AgendaView').AgendaView
let Cards: typeof import('./VersionCards').VersionCards

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Month = (await import('./MonthView')).MonthView
  Schedule = (await import('./ScheduleView')).ScheduleView
  Day = (await import('./DayView')).DayView
  Agenda = (await import('./AgendaView')).AgendaView
  Cards = (await import('./VersionCards')).VersionCards
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())

const mount = async (el: React.ReactElement) => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(el) })
}
const common = { nowMs: NOW, versions: view.versions, pieces: view.pieces, marks: view.marks, pt: true, selected: null }
const noop = () => {}

test('month: a published version and a planned one are ribbons; the version with no estimate says so; a due chip and a renewal icon exist', async () => {
  await mount(createElement(Month, { ...common, anchor: '2026-11-07', onPickDay: noop, onOpenVersion: noop, onOpenMark: noop }))
  expect(document.querySelectorAll('[data-cal-day]').length).toBe(42)
  expect(document.querySelector('[data-cal-ribbon="2.201.1"][data-cal-state="published"]')!.textContent).toContain('publicada')
  expect(document.querySelector('[data-cal-ribbon="2.202.0"][data-cal-state="planned"]')!.textContent).toContain('prevista')
  expect(document.querySelector('[data-cal-ribbon="2.203.0"]')!.textContent).toContain('sem estimativa')
  expect(document.querySelector('[data-cal-due="t"]')).not.toBeNull()
})

test('calendar detail localizes the leader reason', async () => {
  const piece = { ...view.pieces[0]!, leaderAvailabilityReasonCode: 'no-live-leader' as const }
  await mount(createElement(MemoryRouter, null, createElement(CalendarDetail, { selection: { kind: 'piece', key: piece.key }, anchor: null, pieces: [piece], versions: [], marks: [], nowMs: NOW, pt: true, isMobile: false, onClose: noop, onSelect: noop })))
  expect(document.querySelector('[data-cal-leader-reason]')!.textContent).toContain('nenhum líder vivo')
  await act(async () => { root!.unmount(); root = undefined; document.body.innerHTML = '' })
  await mount(createElement(MemoryRouter, null, createElement(CalendarDetail, { selection: { kind: 'piece', key: piece.key }, anchor: null, pieces: [piece], versions: [], marks: [], nowMs: NOW, pt: false, isMobile: false, onClose: noop, onSelect: noop })))
  expect(document.querySelector('[data-cal-leader-reason]')!.textContent).toContain('no live leader is filed')
})

test('schedule: pieces by priority, a bar per piece, the "now" line, and "sem estimativa" where the model has none', async () => {
  await mount(createElement(Schedule, { ...common, anchor: '2026-11-07', onOpenPiece: noop, onOpenVersion: noop, onOpenMark: noop }))
  expect(document.querySelector('[data-cal-now]')).not.toBeNull()
  expect(document.querySelectorAll('[data-cal-piece-row]').length).toBe(view.pieces.length)
  expect(document.querySelector('[data-cal-piece-row="t/b"]')!.textContent).toContain('sem estimativa')
  expect(document.querySelector('[data-cal-piece-row="t/a"] [data-cal-seg="expected"]')).not.toBeNull()
  expect(document.querySelector('[data-cal-resets]')!.textContent).toContain('ChatGPT')
})

test('day: an all-day strip with the published version and the renewal; a column for the piece in flight', async () => {
  await mount(createElement(Day, { ...common, day: '2026-11-07', onOpenPiece: noop, onOpenVersion: noop, onOpenMark: noop }))
  expect(document.querySelector('[data-cal-allday="version"]')!.textContent).toContain('2.201.1')
  expect(document.querySelector('[data-cal-allday="resets"]')).not.toBeNull()
  expect(document.querySelectorAll('[data-cal-block]').length).toBeGreaterThan(0)
})

test('agenda: the phone list has today, ordered by time, with the renewal as ONE entry', async () => {
  await mount(createElement(Agenda, { ...common, mode: 'agenda', anchor: '2026-11-07', span: 7, onOpenPiece: noop, onOpenVersion: noop, onOpenMark: noop }))
  const today = document.querySelector('[data-cal-agenda-day="2026-11-07"]')!
  expect(today.textContent).toContain('hoje')
  expect(today.querySelectorAll('[data-cal-entry="resets"]').length).toBe(1)
  expect(document.querySelector('[data-cal-agenda-day="2026-11-12"] [data-cal-entry="due"]')).not.toBeNull()
})

test('version cards: the last published one plus every planned one, each with its words', async () => {
  expect(stripVersions(view.versions).map(v => v.version)).toEqual(['2.201.1', '2.202.0', '2.203.0'])
  expect(versionWhen(view.versions.find(v => v.version === '2.203.0')!, '2026-11-07', true)).toBe('sem estimativa')
  expect(versionWhen(view.versions.find(v => v.version === '2.201.1')!, '2026-11-07', true)).toBe('publicada · hoje 13h40')
  await mount(createElement(Cards, { versions: view.versions, nowMs: NOW, pt: true, onOpen: noop, selected: null }))
  expect(document.querySelectorAll('[data-cal-version]').length).toBe(3)
})

test('version cards hide an untagged older plan once a tagged release is known', () => {
  const latest = view.versions.find(v => v.version === '2.201.1')!
  const older = { ...view.versions.find(v => v.version === '2.202.0')!, version: '2.200.9' }
  expect(stripVersions([{ ...latest, taggedRelease: true }, older]).map(v => v.version)).toEqual(['2.201.1'])
})

test('filters: the UI shape converts to core filters; the default is "tasks being worked on" and is not "active filtering"', () => {
  expect(toCalFilters(DEFAULT_FILTERS)).toEqual({ tasks: 'active' })
  expect(filtersActive(DEFAULT_FILTERS)).toBe(false)
  const f = { ...DEFAULT_FILTERS, tasks: 'task:t', versions: ['2.202.0'], confirmedOnly: true }
  expect(toCalFilters(f)).toEqual({ tasks: 'all', task: 't', versions: ['2.202.0'], confirmedOnly: true })
  expect(filtersActive(f)).toBe(true)
  const q = new URLSearchParams(icsQuery(f, { fromMs: 0, toMs: 1000 }))
  expect(q.get('format')).toBe('ics'); expect(q.get('task')).toBe('t'); expect(q.get('version')).toBe('2.202.0'); expect(q.get('confirmed')).toBe('1'); expect(q.get('all')).toBe('1')
  expect(readCalendarFilters(JSON.stringify(f))).toEqual(f)
  expect(readCalendarFilters('{')).toEqual(DEFAULT_FILTERS)
  expect(readCalendarFilters(JSON.stringify({ ...f, stages: ['not-a-stage'] }))).toEqual(DEFAULT_FILTERS)
  expect(readCalendarFilters(JSON.stringify({ ...f, versions: [null] }))).toEqual(DEFAULT_FILTERS)
})

test('phone grid: one card per piece on this day, including published pieces, and timed versions are not all-day duplicates', async () => {
  const events = phoneEvents('2026-11-07', common)
  expect(events.filter(e => e.selection.kind === 'piece').map(e => e.id).sort()).toEqual(view.pieces.map(p => p.key).sort())
  expect(new Set(events.map(e => e.id)).size).toBe(events.length)
  let selection: unknown = null
  await mount(createElement(MobileDayGrid, { ...common, anchor: '2026-11-07', span: 1, onDay: noop, onOpen: s => { selection = s } }))
  expect(document.querySelectorAll('[data-cal-phone-event]').length).toBe(events.length)
  expect(document.querySelector('[data-cal-allday-band]')?.textContent ?? '').not.toContain('2.201.1')
  await act(async () => { (document.querySelector('[data-cal-phone-event="t/a"]') as HTMLButtonElement).click() })
  expect(selection).toEqual({ kind: 'piece', key: 't/a' })
})

test('a version with no date is not happening today: it stays out of the all-day band and the day count', async () => {
  const undated = view.versions.filter(v => v.atMs === null)
  expect(undated.length).toBeGreaterThan(0)
  for (const day of ['2026-11-07', '2026-11-08']) {
    await mount(createElement(MobileDayGrid, { ...common, anchor: day, span: 1, onDay: noop, onOpen: noop }))
    const band = document.querySelector('[data-cal-allday-band]')?.textContent ?? ''
    for (const v of undated) expect(band).not.toContain(v.version)
    await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
  }
})

test('week view: every card is the full column wide, 44px tall at least, and overlaps become one +N chip that opens the day', async () => {
  const overlapping = view.pieces.map(p => ({ ...p, startedAtMs: NOW - 2 * H, stageSinceMs: NOW - 2 * H }))
  let day = ''
  await mount(createElement(MobileDayGrid, { ...common, pieces: overlapping, anchor: '2026-11-07', span: 7, onDay: d => { day = d }, onOpen: noop }))
  const col = document.querySelector('[data-cal-grid-day="2026-11-07"]')!
  const targets = Array.from(col.querySelectorAll<HTMLElement>('[data-cal-phone-event], [data-cal-phone-more]'))
  expect(targets.length).toBeGreaterThan(0)
  for (const t of targets) { expect(t.style.width).toBe('100%'); expect(parseFloat(t.style.height)).toBeGreaterThanOrEqual(44) }
  const chip = col.querySelector<HTMLButtonElement>('[data-cal-phone-more]')
  expect(chip).not.toBeNull()
  await act(async () => { chip!.click() })
  expect(day).toBe('2026-11-07')
})

test('phone card membership matches the API date window, including past work and pieces without an estimate', () => {
  const sample = { ...reply, pieces: view.pieces.map(p => ({ ...p, startedAtMs: NOW - 30 * H })) }
  for (const day of ['2026-11-06', '2026-11-07', '2026-11-08']) {
    const expected = filterCalendar(sample, { fromMs: brtDayStartMs(day), toMs: brtDayStartMs(day) + 86400_000 - 1 }).pieces.map(p => p.key).sort()
    const actual = phoneEvents(day, { ...sample, nowMs: NOW }).filter(e => e.selection.kind === 'piece').map(e => e.id).sort()
    expect(actual).toEqual(expected)
  }
})

test('phone empty days retain the hour grid and week view has seven real day columns', async () => {
  await mount(createElement(MobileDayGrid, { ...common, pieces: [], versions: [], marks: [], anchor: '2026-11-07', span: 7, onDay: noop, onOpen: noop }))
  expect(document.querySelectorAll('[data-cal-grid-day]').length).toBe(7)
  expect(document.querySelector('[data-cal-hour-scroller]')!.textContent).toContain('23')
  expect(document.querySelector('[data-cal-now]')).not.toBeNull()
  expect(document.querySelectorAll('[data-cal-phone-event]').length).toBe(0)
})

test('phone header keeps filters behind a sheet; month day selection opens Day', async () => {
  let picked = '', mode = ''
  await mount(createElement(MobileCalendar, { ...common, anchor: '2026-11-07', view: 'month', ready: true, body: null, filters: createElement('div', { 'data-test-filters': true }, 'Filters'), filterCount: 2, exportIcs: noop, onOpen: noop, onDay: d => { picked = d }, onView: v => { mode = v } }))
  expect(document.querySelector('[data-test-filters]')).toBeNull()
  expect(document.querySelectorAll('[data-cal-week-strip] button').length).toBe(7)
  await act(async () => { (document.querySelector('[data-cal-day="2026-11-10"]') as HTMLButtonElement).click() })
  expect(picked).toBe('2026-11-10'); expect(mode).toBe('day')
  await act(async () => { (document.querySelector('[data-cal-filter-trigger]') as HTMLButtonElement).click() })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.querySelector('[data-test-filters]')).not.toBeNull()
})

test('phone schedule reserves scrollable space after the timeline for its final labels', async () => {
  await mount(createElement(Schedule, { ...common, anchor: '2026-11-07', mobile: true, onOpenPiece: noop, onOpenVersion: noop, onOpenMark: noop }))
  const track = document.querySelector<HTMLElement>('[data-cal-schedule-track]')!
  expect(track.style.paddingRight).toBe('220px')
  expect(track.style.paddingBottom).toBe('64px')
})

test('phone week: the "+N" chip and a card that hides others open THAT day — calDay and calView land in ONE URL change', async () => {
  // Two setQuery navigations in one tap race: the second is built from the pre-first params and wins, so calDay
  // was lost and the Day view fell back to today. Opening a day must be ONE URL change carrying both.
  const overlapping = view.pieces.map(p => ({ ...p, startedAtMs: NOW - 2 * H, stageSinceMs: NOW - 2 * H }))
  let dayCalls = 0, viewCalls = 0
  const Harness = () => {
    const [query, setQuery] = useSearchParams()
    const back = useNavigate()
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(query.get('calDay') ?? '') ? query.get('calDay')! : '2026-11-07'
    const calView = (query.get('calView') ?? 'week') as 'day' | 'three' | 'week' | 'month' | 'schedule' | 'agenda'
    return <>
      <span data-test-url={query.toString()} />
      <button data-test-back type="button" onClick={() => back(-1)} />
      <MobileCalendar {...common} pieces={overlapping} anchor={anchor} view={calView} ready body={null} filters={null} filterCount={0}
        exportIcs={noop} onOpen={noop}
        onDay={d => { dayCalls++; setQuery(q => { q.set('calDay', d); return q }, { replace: true }) }}
        onView={v => { viewCalls++; setQuery(q => { q.set('calView', v); return q }, { replace: true }) }}
        onOpenDay={d => { setQuery(q => { q.set('calDay', d); q.set('calView', 'day'); return q }) }} />
    </>
  }
  await mount(createElement(MemoryRouter, { initialEntries: ['/tasks/calendar?calView=week'] },
    createElement(Routes, null, createElement(Route, { path: '/tasks/calendar', element: createElement(Harness) }))))
  const col = document.querySelector('[data-cal-grid-day="2026-11-07"]')!
  const chip = col.querySelector<HTMLButtonElement>('[data-cal-phone-more]')
  expect(chip).not.toBeNull()
  await act(async () => { chip!.click() })
  const url = document.querySelector('[data-test-url]')!.getAttribute('data-test-url')!
  expect(url).toContain('calDay=2026-11-07')
  expect(url).toContain('calView=day')
  expect(document.querySelectorAll('[data-cal-grid-day]').length).toBe(1)
  expect(document.querySelector('[data-cal-grid-day]')!.getAttribute('data-cal-grid-day')).toBe('2026-11-07')
  expect(dayCalls).toBe(0); expect(viewCalls).toBe(0)
  // A card that hides others opens the day the same way as its chip.
  await act(async () => { (document.querySelector('[data-test-back]') as HTMLButtonElement).click() }) // back to the week, as a phone's Back button does
  await act(async () => { (document.querySelector('[data-cal-grid-day="2026-11-07"] [data-cal-phone-event]') as HTMLButtonElement).click() })
  expect(document.querySelector('[data-test-url]')!.getAttribute('data-test-url')!).toContain('calDay=2026-11-07')
  expect(document.querySelector('[data-cal-grid-day]')!.getAttribute('data-cal-grid-day')).toBe('2026-11-07')
})

test('all-day band with 5 rows: shows 2 and "+3 more", expands to all 5, then collapses', async () => {
  const marks = Array.from({ length: 5 }, (_, i) => ({ kind: 'task-due' as const, day: '2026-11-08', taskId: `d${i}`, label: `Prazo ${i}`, priority: null }))
  await mount(createElement(MobileDayGrid, { ...common, marks, anchor: '2026-11-08', span: 1, onDay: noop, onOpen: noop }))
  const rows = () => document.querySelectorAll('[data-cal-allday-band] .cal-phone-allday').length
  expect(rows()).toBe(2)
  const more = document.querySelector('.cal-phone-allday-more') as HTMLButtonElement
  expect(more.textContent).toContain("+3")
  await act(async () => { more.click() })
  expect(rows()).toBe(5)
  await act(async () => { (document.querySelector('.cal-phone-allday-more') as HTMLButtonElement).click() })
  expect(rows()).toBe(2)
})

test('an empty day says so instead of drawing only the hour grid', async () => {
  await mount(createElement(MobileDayGrid, { ...common, pieces: [], versions: [], marks: [], anchor: '2026-09-29', span: 1, onDay: noop, onOpen: noop }))
  expect(document.querySelector('[data-cal-empty-day]')?.textContent ?? '').not.toBe('')
  await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
  await mount(createElement(MobileDayGrid, { ...common, anchor: '2026-11-07', span: 1, onDay: noop, onOpen: noop }))
  expect(document.querySelector('[data-cal-empty-day]')).toBeNull()
})

test('phone all-day rows and the "+N more" control are 44px touch targets', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('./mobileCalendar.css', import.meta.url), 'utf8')
  const rule = css.split('\n').find(l => l.startsWith('.cal-phone-allday,')) ?? ''
  expect(rule).toContain('min-height: 44px')
  expect(rule).toContain('height: 44px')
  expect(rule).not.toMatch(/\b32px/)
})

test('filters sheet: one left-aligned column, every field the same full width, no floating offset', async () => {
  const { CalendarFilters } = await import('./CalendarFilters')
  await mount(createElement(CalendarFilters, { value: DEFAULT_FILTERS, onChange: noop, pieces: reply.pieces, harnessOf: (h: string) => h, versionList: ['2.202.0'], pt: true, mobile: true, sheet: true, shown: '3 peças' }))
  const root = document.querySelector('[data-cal-filters]') as HTMLElement
  expect(root.style.flexDirection).toBe('column'); expect(root.style.alignItems).toBe('stretch')
  const fields = Array.from(document.querySelectorAll('[data-cal-field]')) as HTMLElement[]
  expect(fields.length).toBe(5)
  for (const f of fields) expect(f.style.width).toBe('100%')
  // no funnel indenting the first control: the sheet header already carries one
  expect(root.querySelector('[data-cal-field] > svg')).toBeNull()
  expect((fields[0] as HTMLElement).firstElementChild?.tagName.toLowerCase()).not.toBe('svg')
})

test('switch with a tap target shows only the pill: no painted box, and a global min-height cannot grow it', async () => {
  const { ToggleSwitch } = await import('../ToggleSwitch')
  await mount(createElement(ToggleSwitch, { on: false, onToggle: noop, label: 'x', tap: 44 }))
  let b = document.querySelector('[role="switch"]') as HTMLElement
  expect(b.style.background).toBe('transparent'); expect(b.style.minHeight).toMatch(/^0(px)?$/)
  await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
  await mount(createElement(ToggleSwitch, { on: false, onToggle: noop, label: 'x' }))
  b = document.querySelector('[role="switch"]') as HTMLElement
  expect(b.style.minHeight).toMatch(/^0(px)?$/)
})

test('the phone filters sheet is built in sheet mode and its CSS no longer styles every sheet button', async () => {
  const { readFileSync } = await import('node:fs')
  const dir = new URL('.', import.meta.url)
  expect(readFileSync(new URL('./DeliveryCalendar.tsx', dir), 'utf8')).toMatch(/mobile sheet shown=/)
  const css = readFileSync(new URL('./mobileCalendar.css', dir), 'utf8')
  expect(css).not.toMatch(/\[data-cal-filters\] button/)
})
