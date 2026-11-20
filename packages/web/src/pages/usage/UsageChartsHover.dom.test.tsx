import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { SessionMeta } from '@agentistics/core'
import type { PlanReadings } from '../../lib/planLimits'
import { limitSeries, toChartRows } from './usageChartsModel'

/**
 * QA r1/r2 blocker: the tooltip time must be EXACTLY what the unthinned chart shows. The chart snaps its hover to
 * the nearest row of the `data` it is handed, so the guarantee is that `data` is the full row set (no thinning).
 * Recharts needs a real layout to hover, which happy-dom lacks, so the test captures the `data` each LineChart
 * receives and applies recharts' own rule (nearest row on x, ties: the earlier one) at 121 positions.
 */
const NOW = Date.parse('2026-10-26T12:00:00Z')
const FIVE = 5 * 60_000
// A long FLAT run (the rows a "collapse flat rows" optimisation would drop), then a change, then flat again.
const points = Array.from({ length: 60 }, (_, i) => ({ at: NOW - (60 - i) * FIVE, weekPct: 10, fiveHourPct: i < 40 ? 20 : 35 }))
const readings: PlanReadings[] = [{ harness: 'claude', account: 'a', points }]

let createRoot: typeof import('react-dom/client').createRoot
let Panel: typeof import('./UsageChartsPanel').UsageChartsPanel
let root: Root | undefined
const captured: { at: number }[][] = []
const grids: { vertical?: boolean; verticalCoordinatesGenerator?: () => number[] }[] = []
let realRecharts: typeof import('recharts')

beforeAll(async () => {
  GlobalRegistrator.register()
  Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, writable: true, value: undefined })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  realRecharts = await import('recharts')
  const Real = realRecharts.LineChart
  const RealBar = realRecharts.BarChart
  const collectGrids = (children: unknown) => { for (const c of Array.isArray(children) ? children.flat(5) : [children]) if (c && typeof c === 'object' && (c as { type?: unknown }).type === realRecharts.CartesianGrid) grids.push((c as { props: never }).props) }
  mock.module('recharts', () => ({
    ...realRecharts,
    // happy-dom has no layout: the container would measure 0 and render no chart at all.
    ResponsiveContainer: (props: { children: unknown }) => props.children,
    BarChart: (props: { children?: unknown }) => { collectGrids(props.children); return createElement(RealBar as never, props as never) },
    LineChart: (props: { data: { at: number }[]; children?: unknown }) => { captured.push(props.data); collectGrids(props.children); return createElement(Real as never, props as never) },
  }))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ UsageChartsPanel: Panel } = await import('./UsageChartsPanel'))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => { act(() => root?.unmount()); root = undefined })
afterAll(() => { mock.module('recharts', () => realRecharts); void GlobalRegistrator.unregister() })

const nearest = <R extends { at: number }>(rows: readonly R[], x: number): R => rows.reduce((best, r) => Math.abs(r.at - x) < Math.abs(best.at - x) ? r : best, rows[0]!)

describe('Usage limit charts hover the FULL rows', () => {
  test('the 5 h chart is fed every row, and 121 hover positions read the same row (time and value) as the base algorithm', () => {
    const el = document.createElement('div'); document.body.append(el)
    root = createRoot(el)
    act(() => root!.render(createElement(Panel, { budgets: [], readings, sessions: [] as SessionMeta[], lang: 'en', now: NOW })))
    const base = toChartRows(limitSeries(readings, '5h', () => 'x', NOW - 48 * 3_600_000).series, 5 * 3_600_000).rows
    expect(base.length).toBe(60)
    const data = captured.find(d => d.length > 1 && d[0]!.at === base[0]!.at)
    expect(data).toBeDefined()
    expect(data!.length).toBe(base.length)
    const lo = base[0]!.at, hi = base.at(-1)!.at
    for (let i = 0; i <= 120; i++) {
      const x = lo + (hi - lo) * i / 120
      const got = nearest(data!, x) as { at: number; s0: number | null }
      const want = nearest(base, x)
      expect(got.at).toBe(want.at)
      expect(got.s0).toBe((want as { s0?: number | null }).s0 ?? null)
    }
  })
  test('every limit/hour chart grid skips the default vertical-line generator (it forced a layout per x tick: ~2600 per page open)', () => {
    const el = document.createElement('div'); document.body.append(el)
    root = createRoot(el)
    act(() => root!.render(createElement(Panel, { budgets: [], readings, sessions: [] as SessionMeta[], lang: 'en', now: NOW })))
    expect(grids.length).toBeGreaterThan(0)
    for (const g of grids) {
      expect(g.vertical).toBe(false)
      expect(g.verticalCoordinatesGenerator?.()).toEqual([])
    }
  })
})
