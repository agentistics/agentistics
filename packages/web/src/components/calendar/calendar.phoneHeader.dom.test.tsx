import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

const NOW = Date.parse('2026-11-14T18:39:00.000Z') // Sat 14/11 BRT

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Phone: typeof import('./MobileCalendar').MobileCalendar

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Phone = (await import('./MobileCalendar')).MobileCalendar
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())

const mount = async (view: 'day' | 'schedule' | 'week', pt: boolean, spies: { days?: string[]; views?: string[] } = {}) => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => {
    root!.render(createElement(Phone, {
      anchor: '2026-11-14', onDay: d => { spies.days?.push(d) }, view, onView: v => { spies.views?.push(v) }, nowMs: NOW, pt,
      versions: [], pieces: [], marks: [], onOpen: () => {}, filterCount: 0, filters: createElement('div', null, 'filters'),
      body: createElement('div', { 'data-body': '' }), ready: true, exportIcs: () => {},
    }))
  })
}
const q = (s: string) => document.querySelector<HTMLElement>(s)

test('phone Dia (pt): the prototype header — date title, "Dia" selector, ‹ Hoje ›', async () => {
  await mount('day', true)
  expect(q('[data-cal-phone-title]')!.textContent).toBe('sáb, 14 de novembro')
  expect(q('[data-cal-view-select]')!.textContent).toContain('Dia')
  expect(q('[data-cal-today]')!.textContent).toBe('Hoje')
  expect(q('[data-cal-prev]')).not.toBeNull()
  expect(q('[data-cal-next]')).not.toBeNull()
  expect(q('[data-cal-filter-trigger]')).not.toBeNull()
  expect(document.querySelectorAll('[data-cal-week-strip]').length).toBe(0)
})

test('phone Dia (en): English words', async () => {
  await mount('day', false)
  expect(q('[data-cal-phone-title]')!.textContent).toBe('Sat, November 14')
  expect(q('[data-cal-today]')!.textContent).toBe('Today')
})

test('phone: ‹ › step the day, Hoje goes to today', async () => {
  const days: string[] = []
  await mount('day', true, { days })
  await act(async () => { q('[data-cal-prev]')!.click() })
  await act(async () => { q('[data-cal-next]')!.click() })
  await act(async () => { q('[data-cal-today]')!.click() })
  expect(days).toEqual(['2026-11-13', '2026-11-15', '2026-11-14'])
})

test('phone: the selector reaches Cronograma and the other views', async () => {
  const views: string[] = []
  await mount('day', true, { views })
  await act(async () => { q('[data-cal-view-select]')!.click() })
  const opts = Array.from(document.querySelectorAll<HTMLElement>('[data-cal-view-option]'))
  expect(opts.map(o => o.getAttribute('data-cal-view-option'))).toEqual(['day', 'three', 'week', 'month', 'schedule', 'agenda'])
  await act(async () => { document.querySelector<HTMLElement>('[data-cal-view-option="schedule"]')!.click() })
  expect(views).toEqual(['schedule'])
})

test('phone Cronograma: same header; "Cronograma" on the selector, steps a week', async () => {
  const days: string[] = []
  await mount('schedule', true, { days })
  expect(q('[data-cal-view-select]')!.textContent).toContain('Cronograma')
  expect(q('[data-cal-phone-title]')!.textContent).toBe('novembro de 2026')
  await act(async () => { q('[data-cal-next]')!.click() })
  expect(days).toEqual(['2026-11-21'])
})

test('phone: no checkbox beside the progress ring, and the header does not render one', async () => {
  await mount('day', true)
  expect(document.querySelector('[data-cal-phone] input[type="checkbox"]')).toBeNull()
})
