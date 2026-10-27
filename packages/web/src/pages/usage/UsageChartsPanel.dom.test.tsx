import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { SessionMeta } from '@agentistics/core'
import type { PlanReadings } from '../../lib/planLimits'

let createRoot: typeof import('react-dom/client').createRoot
let Panel: typeof import('./UsageChartsPanel').UsageChartsPanel
let root: Root | undefined
const NOW = Date.parse('2026-10-26T12:00:00Z')
const readings: PlanReadings[] = [
  { harness: 'claude', account: 'a', points: [{ at: NOW - 2 * 3_600_000, weekPct: 10, fiveHourPct: 5 }, { at: NOW - 3_600_000, weekPct: 12, fiveHourPct: 20 }] },
  { harness: 'codex', account: 'default', points: [{ at: NOW - 2 * 3_600_000, weekPct: 40, fiveHourPct: null }, { at: NOW - 3_600_000, weekPct: 44, fiveHourPct: null }] },
]

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ UsageChartsPanel: Panel } = await import('./UsageChartsPanel'))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => { act(() => root?.unmount()); root = undefined })
afterAll(() => { void GlobalRegistrator.unregister() })

function mount() {
  const el = document.createElement('div'); document.body.append(el)
  root = createRoot(el)
  act(() => root!.render(createElement(Panel, { budgets: [], readings, sessions: [{ harness: 'gemini', user_message_timestamps: [new Date(NOW - 60_000).toISOString()] }] as SessionMeta[], lang: 'en', now: NOW })))
  return el
}
const tab = (el: HTMLElement, name: string) => Array.from(el.querySelectorAll('[role=tab]')).find(b => b.textContent?.includes(name)) as HTMLElement

describe('UsageChartsPanel filter', () => {
  test('default account rows and five modes; the account mode shows its picker and the 5 h note names the omitted harness', () => {
    const el = mount()
    expect(Array.from(el.querySelectorAll('[role=tab]')).map(b => b.textContent)).toEqual(['By account', 'Overlaid by harness', 'All overlaid', 'One harness', 'One account'])
    expect(tab(el, 'By account').getAttribute('aria-selected')).toBe('true')
    expect(el.textContent).toContain('No 5 h window (omitted): Codex')
    expect(el.querySelectorAll('[data-usage-account]')).toHaveLength(2)
    act(() => tab(el, 'One account').click())
    expect(tab(el, 'One account').getAttribute('aria-selected')).toBe('true')
    expect(el.textContent).toContain('Claude Code · a')
    expect(el.querySelector('[data-usage-chart="limits"]')).not.toBeNull()
    expect(el.querySelector('[data-usage-chart="hours"]')).not.toBeNull()
    expect(el.querySelector('[data-usage-chart="peaks"]')).not.toBeNull()
    expect(el.querySelector('[data-usage-chart="peaks"]')?.textContent).toContain('Limit usage by hour')
  })
  test('harnesses from sessions without readings remain selectable and show activity', () => {
    const el = mount()
    act(() => tab(el, 'One harness').click())
    act(() => (el.querySelector('[data-usage-harness] button') as HTMLElement).click())
    const gemini = Array.from(document.querySelectorAll('[role=option]')).find(b => b.textContent?.includes('Gemini')) as HTMLElement
    expect(gemini).toBeDefined()
    act(() => gemini.click())
    expect(el.textContent).toContain('no limit readings')
    expect(el.textContent).toContain('Hours with the most messages')
    expect(el.querySelector('svg[aria-label="Messages by weekday and hour, last 14 days"]')).not.toBeNull()
    expect(el.textContent).not.toContain('pp/h')
  })
})

describe('legacy History bookmark', () => {
  test('redirects to the single Usage screen', async () => {
    const { MemoryRouter, Routes, Route, useLocation } = await import('react-router-dom')
    const { default: History } = await import('./UsageHistoryPage')
    const Destination = () => createElement('p', { 'data-destination': true }, useLocation().pathname)
    const el = document.createElement('div'); document.body.append(el)
    root = createRoot(el)
    await act(async () => root!.render(createElement(MemoryRouter, { initialEntries: ['/usage/history'] },
      createElement(Routes, null,
        createElement(Route, { path: '/usage/history', element: createElement(History) }),
        createElement(Route, { path: '/usage', element: createElement(Destination) }),
      ),
    )))
    expect(el.querySelector('[data-destination]')?.textContent).toBe('/usage')
  })
})

describe('area rail interactions', () => {
  async function rail() {
    const { MemoryRouter } = await import('react-router-dom')
    const { AreaRail } = await import('../../components/nav/AreaRail')
    const el = document.createElement('div'); document.body.append(el)
    root = createRoot(el)
    act(() => root!.render(createElement(MemoryRouter, null, createElement(AreaRail, { lang: 'en', pathname: '/sessions' }))))
    return el.querySelector('[data-area-rail]') as HTMLElement
  }
  const pointer = (el: HTMLElement, type: string, pointerType = 'mouse') => act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType }))
  })
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })

  test('hover expands as an overlay and closes after leaving', async () => {
    const nav = await rail()
    expect(nav.dataset.open).toBe('false')
    pointer(nav, 'pointerover')
    expect(nav.dataset.open).toBe('true')
    expect(nav.parentElement?.style.width).toBe('60px')
    expect(nav.style.position).toBe('absolute')
    pointer(nav, 'pointerout')
    expect(nav.dataset.open).toBe('true')
    await settle()
    expect(nav.dataset.open).toBe('false')
  })
  test('focusing a collapsed icon opens the menu; leaving focus closes it', async () => {
    const nav = await rail()
    expect(nav.dataset.open).toBe('false')
    act(() => (nav.querySelector('a') as HTMLElement).focus())
    expect(nav.dataset.open).toBe('true')
    // Expanding replaces the icons with the tree: focus stays in the rail.
    expect(nav.contains(document.activeElement)).toBe(true)
    act(() => (document.activeElement as HTMLElement).blur())
    await settle()
    expect(nav.dataset.open).toBe('false')
  })
  test('focus holds the open menu, blur releases it; touch still uses the toggle', async () => {
    const nav = await rail()
    pointer(nav, 'pointerover', 'touch')
    expect(nav.dataset.open).toBe('false')
    const toggle = nav.querySelector('button[aria-controls]') as HTMLButtonElement
    act(() => toggle.click())
    expect(nav.dataset.open).toBe('true')
    act(() => toggle.focus())
    pointer(nav, 'pointerout')
    await settle()
    expect(nav.dataset.open).toBe('true')
    act(() => toggle.blur())
    await settle()
    expect(nav.dataset.open).toBe('false')
  })
})
