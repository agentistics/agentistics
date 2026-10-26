import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
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
  act(() => root!.render(createElement(Panel, { budgets: [], readings, sessions: [], lang: 'en', now: NOW })))
  return el
}
const tab = (el: HTMLElement, name: string) => Array.from(el.querySelectorAll('[role=tab]')).find(b => b.textContent?.includes(name)) as HTMLElement

describe('UsageChartsPanel filter', () => {
  test('three modes; the account mode shows its picker and the 5 h note names the omitted harness', () => {
    const el = mount()
    expect(Array.from(el.querySelectorAll('[role=tab]')).map(b => b.textContent)).toEqual(['All overlaid', 'One harness', 'One account'])
    expect(tab(el, 'All overlaid').getAttribute('aria-selected')).toBe('true')
    expect(el.textContent).toContain('No 5 h window (omitted): Codex')
    act(() => tab(el, 'One account').click())
    expect(tab(el, 'One account').getAttribute('aria-selected')).toBe('true')
    expect(el.textContent).toContain('Claude Code · a')
    expect(el.querySelector('[data-usage-chart="limits"]')).not.toBeNull()
    expect(el.querySelector('[data-usage-chart="hours"]')).not.toBeNull()
    expect(el.querySelector('[data-usage-chart="peaks"]')).not.toBeNull()
  })
})
