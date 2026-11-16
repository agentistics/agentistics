import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { buildCalendar } from '@agentistics/core'

const NOW = Date.parse('2026-11-14T18:39:00.000Z') // Sat 14/11 15h39 BRT
const H = 3600_000
const live = (sub: string, stage: 'qa' | 'queue' | 'running' | 'published', o: Record<string, unknown> = {}) => ({
  key: `t/${sub}`, taskId: 't', taskTitle: 'Engine', subtaskId: sub, title: `Peça ${sub}`, stage, startedAtMs: NOW - 5 * H, stageSinceMs: NOW - H,
  harnesses: [], models: [], trail: [], eta: { kind: 'none' as const }, stageEta: { kind: 'none' as const }, publishEta: { kind: 'none' as const },
  deliveredAtMs: stage === 'published' ? NOW - 2 * H : null, ...o,
})
const { pieces } = buildCalendar({
  nowMs: NOW,
  lives: [live('a1', 'published'), live('a2', 'qa', { publishEta: { kind: 'estimate', atMs: NOW + 3 * H } }), live('r3', 'queue', { startedAtMs: null, stageSinceMs: null })],
  records: [], tasks: [{ id: 't', title: 'Engine', status: 'in_progress' }],
  subtasks: [
    { id: 'ga', taskId: 't', title: 'Adaptadores' }, { id: 'a1', taskId: 't', title: 'A1', parentGroupId: 'ga' }, { id: 'a2', taskId: 't', title: 'A2', parentGroupId: 'ga' },
    { id: 'r3', taskId: 't', title: 'R3' },
  ], resets: [],
})

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Week: typeof import('./ScheduleView').ScheduleView
let Day: typeof import('./DayView').DayView
let store: typeof import('../../lib/cronogramaCollapsed').cronogramaCollapsedStore

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
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
const weekProps = { anchor: '2026-11-14', nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }

for (const pt of [true, false]) {
  test(`day: approved header legend, ${pt ? 'pt' : 'en'}`, async () => {
    await mount(createElement(Day, { ...weekProps, day: weekProps.anchor, pt }))
    const legend = document.querySelector('[data-cal-tree-head] [data-cal-legend]')!
    expect(legend).not.toBeNull()
    expect(Array.from(legend.children).map(e => e.textContent)).toEqual(pt ? ['feito', 'previsto', 'sem horário'] : ['done', 'expected', 'no time'])
    expect(legend.querySelectorAll('.crono-key')).toHaveLength(3)
    expect(legend.querySelector('.crono-prev')).not.toBeNull()
    expect(legend.querySelector('.crono-sem')).not.toBeNull()
    expect(document.querySelector('[data-cal-tree-head]')!.nextElementSibling).toBe(document.querySelector('[data-cal-tree]'))
  })

  test(`week: approved header legend, ${pt ? 'pt' : 'en'}`, async () => {
    await mount(createElement(Week, { ...weekProps, pt }))
    const legend = document.querySelector('[data-cal-tree-head] [data-cal-legend]')!
    expect(legend).not.toBeNull()
    expect(Array.from(legend.children).map(e => e.textContent)).toEqual(pt ? ['em andamento', 'publicado', 'previsto', 'tarefa / grupo'] : ['in progress', 'published', 'expected', 'task / group'])
    expect(legend.querySelectorAll('.crono-key')).toHaveLength(4)
    expect(legend.querySelector('.crono-sem')).not.toBeNull()
    expect(legend.querySelector('.crono-prev')).toBeNull()
  })
}

test('week: the tree has task → group → subtask rows and the now line', async () => {
  await mount(createElement(Week, weekProps))
  expect(document.querySelectorAll('.crono-row[data-kind="task"]').length).toBe(1)
  expect(document.querySelectorAll('.crono-row[data-kind="group"]').length).toBe(1)
  expect(document.querySelectorAll('.crono-row[data-kind="sub"]').length).toBe(3)
  expect(document.querySelectorAll('[data-cal-col]').length).toBe(14)
  expect(document.querySelector('[data-cal-col="2026-11-14"]')!.hasAttribute('data-today')).toBe(true)
  expect(document.querySelector('[data-cal-now]')).not.toBeNull()
})

test('week: % and ring on task and group rows only; NO checkbox on them; subtasks keep theirs', async () => {
  await mount(createElement(Week, weekProps))
  for (const kind of ['task', 'group']) {
    const bar = document.querySelector(`[data-cal-bar="${kind}"]`)!
    expect(bar.querySelector('[data-cal-pct]')).not.toBeNull()
    expect(bar.querySelector('[data-cal-ring]')).not.toBeNull()
    expect(bar.querySelector('[data-cal-cb]')).toBeNull()
  }
  expect(document.querySelector('[data-cal-bar="task"] [data-cal-pct]')!.textContent).toBe('33%') // 1 of 3, rounded down
  expect(document.querySelector('[data-cal-bar="group"] [data-cal-pct]')!.textContent).toBe('50%')
  const sub = document.querySelector('[data-cal-bar-piece="t/a1"]')!
  expect(sub.querySelector('[data-cal-cb]')!.hasAttribute('data-on')).toBe(true) // published = ticked
  expect(sub.querySelector('[data-cal-pct]')).toBeNull()
  expect(document.querySelector('[data-cal-bar-piece="t/a2"] [data-cal-cb]')!.hasAttribute('data-on')).toBe(false)
})

test('week: a piece with no real start has no bar, only the dashed "sem data" chip — and no 00:00 anywhere', async () => {
  await mount(createElement(Week, weekProps))
  const row = document.querySelector('[data-cal-row="t/r3"]')!
  expect(row.querySelector('[data-cal-bar]')).toBeNull()
  expect(row.querySelector('[data-cal-chip="no-date"]')!.textContent).toContain('sem data')
  expect(document.body.textContent).not.toContain('00h00')
})

test('week: the forecast part is hatched and a delivered bar has no forecast', async () => {
  await mount(createElement(Week, weekProps))
  expect(document.querySelector('[data-cal-bar-piece="t/a2"] [data-cal-seg="expected"]')).not.toBeNull()
  expect(document.querySelector('[data-cal-bar-piece="t/a1"] [data-cal-seg="expected"]')).toBeNull()
})

test('collapse: ▶ hides the children, is remembered, and expanding brings them back', async () => {
  await mount(createElement(Week, weekProps))
  const fold = document.querySelector<HTMLElement>('[data-cal-fold="group:t/ga"]')!
  await act(async () => { fold.click() })
  expect(document.querySelector('[data-cal-row="t/a1"]')).toBeNull()
  expect(store.get()).toEqual(['group:t/ga'])
  await act(async () => { document.querySelector<HTMLElement>('[data-cal-fold="group:t/ga"]')!.click() })
  expect(document.querySelector('[data-cal-row="t/a1"]')).not.toBeNull()
  expect(store.get()).toEqual([])
})

test('collapse memory is applied on mount', async () => {
  store.set(['task:t'])
  await mount(createElement(Week, weekProps))
  expect(document.querySelectorAll('[data-cal-row]').length).toBe(1)
})

test('day: hour scale, "sem horário" chip for the undated one, hint with the real start and "agora"', async () => {
  await mount(createElement(Day, { day: '2026-11-14', nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  expect(document.querySelectorAll('[data-cal-hour]').length).toBeGreaterThan(10)
  expect(document.querySelector('[data-cal-row="t/r3"] [data-cal-chip="no-date"]')!.textContent).toBe('sem horário')
  expect(document.querySelector('[data-cal-bar-piece="t/a2"] [data-cal-hint]')!.textContent).toContain('10h39')
  expect(document.querySelector('[data-cal-bar="task"] [data-cal-cb]')).toBeNull()
  expect(document.querySelector('[data-cal-now]')).not.toBeNull()
})

test('day: the undated chip appears only on today', async () => {
  await mount(createElement(Day, { day: '2026-11-13', nowMs: NOW, pieces, pt: true, selected: null, onOpenPiece: noop }))
  expect(document.querySelector('[data-cal-chip="no-date"]')).toBeNull()
})

test('opening a subtask bar reports its key', async () => {
  let opened = ''
  await mount(createElement(Week, { ...weekProps, onOpenPiece: (k: string) => { opened = k } }))
  await act(async () => { document.querySelector<HTMLElement>('[data-cal-bar-piece="t/a2"]')!.click() })
  expect(opened).toBe('t/a2')
})
