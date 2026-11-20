import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { SessionMeta } from '@agentistics/core'
import type { PlanReadings } from '../../lib/planLimits'

/**
 * USO.LENTO r3c: the first commit of the Usage page draws what fits the first screen (the first two accounts'
 * charts); everything below the fold follows on the next frames. Same charts, same text, same order — once settled.
 */
const NOW = Date.parse('2026-10-26T12:00:00Z')
const FIVE = 5 * 60_000
const mk = (account: string): PlanReadings => ({ harness: 'claude', account, points: Array.from({ length: 30 }, (_, i) => ({ at: NOW - (30 - i) * FIVE, weekPct: 10 + i / 10, fiveHourPct: 20 + i })) })
const readings = ['a', 'b', 'c', 'd'].map(mk)
const sessions = [{ harness: 'claude', user_message_timestamps: [new Date(NOW - 3_600_000).toISOString()] }] as unknown as SessionMeta[]

let createRoot: typeof import('react-dom/client').createRoot
let Panel: typeof import('./UsageChartsPanel').UsageChartsPanel
let root: Root | undefined
let lines = 0, bars = 0
let realRecharts: typeof import('recharts')

beforeAll(async () => {
  GlobalRegistrator.register()
  Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, writable: true, value: undefined })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  realRecharts = await import('recharts')
  const RealLine = realRecharts.LineChart, RealBar = realRecharts.BarChart
  mock.module('recharts', () => ({
    ...realRecharts,
    ResponsiveContainer: (props: { children: unknown }) => props.children,
    BarChart: (props: { children?: unknown }) => { bars++; return createElement(RealBar as never, props as never) },
    LineChart: (props: { children?: unknown }) => { lines++; return createElement(RealLine as never, props as never) },
  }))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ UsageChartsPanel: Panel } = await import('./UsageChartsPanel'))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => { act(() => root?.unmount()); root = undefined })
afterAll(() => { mock.module('recharts', () => realRecharts); void GlobalRegistrator.unregister() })

const mount = () => {
  lines = 0; bars = 0
  const el = document.createElement('div'); document.body.append(el)
  root = createRoot(el)
  act(() => root!.render(createElement(Panel, { budgets: [], readings, sessions, lang: 'en', now: NOW })))
  return el
}
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 20)) }) }

describe('Usage charts are staged: first screen first', () => {
  test('first commit: only the first two accounts (4 line charts), no hourly bars; settled: all of them', async () => {
    const el = mount()
    expect(lines).toBe(4)
    expect(bars).toBe(0)
    const early = el.textContent ?? ''
    expect(early).toContain('Limits over time')
    await settle()
    const done = el.textContent ?? ''
    expect(el.querySelectorAll('[data-usage-account]').length).toBe(4)
    expect(el.querySelector('[data-usage-chart="peaks"]')).not.toBeNull()
    expect(done).toContain('Limit usage by hour')
    expect(done.length).toBeGreaterThan(early.length)
  })
  test('staging happens once: later renders do not hide the charts again', async () => {
    const el = mount()
    await settle()
    act(() => root!.render(createElement(Panel, { budgets: [], readings, sessions, lang: 'en', now: NOW + 1000 })))
    expect(el.querySelectorAll('[data-usage-account]').length).toBe(4)
  })
})
