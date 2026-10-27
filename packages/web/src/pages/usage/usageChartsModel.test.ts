import { describe, expect, test } from 'bun:test'
import type { PlanReadings } from '../../lib/planLimits'
import { harnessSeries, hourlyUsage, limitSeries, messageActivity, rateRows, scopeReadings, scopeSessions, toChartRows, topPeaks } from './usageChartsModel'

const H = 3_600_000
const T0 = Date.parse('2026-10-20T00:00:00Z')
const claude: PlanReadings = { harness: 'claude', account: 'a', points: [
  { at: T0, weekPct: 10, fiveHourPct: 5, weekReset: T0 + 100 * H, fiveReset: T0 + 5 * H },
  { at: T0 + H, weekPct: 12, fiveHourPct: 25, weekReset: T0 + 100 * H, fiveReset: T0 + 5 * H },
  { at: T0 + 6 * H, weekPct: 13, fiveHourPct: 2, weekReset: T0 + 100 * H, fiveReset: T0 + 10 * H },
] }
const codex: PlanReadings = { harness: 'codex', account: 'default', points: [
  { at: T0, weekPct: 40, fiveHourPct: null }, { at: T0 + 2 * H, weekPct: 44, fiveHourPct: null },
] }
const label = (r: PlanReadings) => `${r.harness}/${r.account}`

describe('scope', () => {
  test('all keeps everything; harness and account narrow; no pick keeps everything', () => {
    expect(scopeReadings([claude, codex], { mode: 'all' })).toHaveLength(2)
    expect(scopeReadings([claude, codex], { mode: 'harness', key: 'codex' })).toEqual([codex])
    expect(scopeReadings([claude, codex], { mode: 'account', key: 'claude:a' })).toEqual([claude])
    expect(scopeReadings([claude, codex], { mode: 'harness' })).toHaveLength(2)
  })
  test('sessions are scoped by harness and account (absent = default)', () => {
    const ss = [{ harness: 'claude' as const, account: 'a' }, { harness: 'codex' as const }, { harness: 'claude' as const }]
    expect(scopeSessions(ss, { mode: 'harness', key: 'claude' })).toHaveLength(2)
    expect(scopeSessions(ss, { mode: 'account', key: 'codex:default' })).toEqual([ss[1]!])
  })
})

describe('limitSeries', () => {
  test('a harness with no 5 h window is omitted by name, not drawn as 0', () => {
    const five = limitSeries([claude, codex], '5h', label)
    expect(five.series.map(s => s.label)).toEqual(['claude/a'])
    expect(five.omitted).toEqual(['codex/default'])
    expect(limitSeries([claude, codex], 'week', label).omitted).toEqual([])
  })
  test('since drops older points', () => {
    expect(limitSeries([claude], '5h', label, T0 + H).series[0]!.points).toHaveLength(2)
  })
  test('a renewed window breaks the line instead of falling', () => {
    const { series } = limitSeries([claude], '5h', label)
    const { rows } = toChartRows(series, 5 * H)
    expect(rows.filter(r => r.s0 !== null).map(r => r.s0)).toEqual([5, 25]) // singleton after reset is omitted
  })
})

describe('peaks', () => {
  test('ranks the fastest climb and ignores a renewal drop', () => {
    const { series } = limitSeries([claude], '5h', label)
    const [peak] = topPeaks(series, '5h', 3, 0.5)
    expect(peak!.ratePerHour).toBe(20)
    expect(topPeaks(series, '5h').every(p => p.rise > 0)).toBe(true)
  })
  test('a window renewal is never a rise, however short the interval', () => {
    const s = [{ key: 'k', harness: 'claude' as const, account: 'a', label: 'l', points: [{ at: T0, pct: 1, reset: T0 + 5 * H }, { at: T0 + 60_000, pct: 90, reset: T0 + 10 * H }] }]
    expect(topPeaks(s, '5h')).toEqual([])
  })
  test('rate rows are capped and carry the interval end', () => {
    const { series } = limitSeries([claude], '5h', label)
    expect(rateRows(series, 100)).toEqual([{ at: T0 + H, rate: 20 }])
  })
})

describe('messageActivity', () => {
  test('counts by local day and hour inside the window only', () => {
    const now = Date.parse('2026-10-26T12:00:00Z')
    const a = messageActivity([{ user_message_timestamps: ['2026-10-25T15:00:00Z', '2026-10-25T15:30:00Z', '2026-09-01T00:00:00Z', 'junk'] }], now)
    expect(a.total).toBe(2)
    expect(a.perDay.reduce((n, d) => n + d.value, 0)).toBe(2)
    expect(Object.values(a.hourCounts).reduce((n, v) => n + v, 0)).toBe(2)
  })
})

describe('series boundaries', () => {
  test('accounts sharing a label stay independent at interleaved timestamps', () => {
    const a: PlanReadings = { harness: 'claude', account: 'a', points: [
      { at: T0, weekPct: 80, fiveHourPct: 90, weekReset: T0 + 10 * H },
      { at: T0 + H, weekPct: 82, fiveHourPct: 95, weekReset: T0 + 10 * H },
    ] }
    const b: PlanReadings = { harness: 'claude', account: 'b', points: [
      { at: T0 + H / 2, weekPct: 30, fiveHourPct: 20, weekReset: T0 + 20 * H },
    ] }
    const c: PlanReadings = { ...b, harness: 'codex', account: 'a' }
    const { series } = limitSeries([a, b, c], 'week', () => 'Principal')
    expect(series.map(s => s.key)).toEqual(['claude:a', 'claude:b', 'codex:a'])
    const { rows } = toChartRows(series, 7 * 24 * H)
    expect(rows.map(r => r.s0)).toEqual([80, 82])
    expect(rows.map(r => r.s1)).toEqual([null, null])
    expect(scopeReadings([a, b, c], { mode: 'account', key: 'claude:b' })).toEqual([b])
  })
  test('weekly chart breaks on the reset drop, ignoring timestamp-only reset changes', () => {
    const { series } = limitSeries([{ harness: 'claude', account: 'a', points: [
      { at: T0, weekPct: 100, fiveHourPct: 100, weekReset: T0 + 10 * H },
      { at: T0 + H / 12, weekPct: 35, fiveHourPct: 35, weekReset: T0 + 20 * H },
      { at: T0 + H / 6, weekPct: 100, fiveHourPct: 100, weekReset: T0 + 10 * H },
    ] }], 'week', label)
    const { rows } = toChartRows(series, 7 * 24 * H)
    expect(rows.map(r => r.s0)).toEqual([35, 100]) // initial singleton omitted; weekly rise remains continuous
    expect(topPeaks(series, 'week', 3, 0.1)).toEqual([])
  })
  test('coarsening cannot skip a reset and manufacture a peak', () => {
    const series = [{ key: 'a', harness: 'claude' as const, account: 'a', label: 'a', points: [
      { at: T0, pct: 10 }, { at: T0 + H / 6, pct: 0 }, { at: T0 + H / 2, pct: 50 },
    ] }]
    // Unknown reset ids: the decrease still starts a new window segment.
    expect(topPeaks(series, '5h')).toEqual([])
  })
  test('weekly charts tolerate missing readings under six hours; peaks remain conservative', () => {
    const { series } = limitSeries([{ harness: 'claude', account: 'a', points: [
      { at: T0, weekPct: 10, fiveHourPct: 10 },
      { at: T0 + H / 4, weekPct: null, fiveHourPct: null },
      { at: T0 + H / 2, weekPct: 20, fiveHourPct: 20 },
      { at: T0 + 4 * H, weekPct: 60, fiveHourPct: 60 },
    ] }], 'week', label)
    expect(toChartRows(series, 7 * 24 * H).rows.map(r => r.s0)).toEqual([10, 20, 60])
    expect(topPeaks(series, 'week')).toEqual([])
    expect(rateRows(series)).toEqual([])
  })
})


describe('readable chart views', () => {
  test('weekly small corrections are continuous, >20 point resets and >6h gaps break', () => {
    const series = [{ key: 'a', harness: 'claude' as const, account: 'a', label: 'A', points: [
      { at: T0, pct: 50 }, { at: T0 + H, pct: 49, gapBefore: true },
      { at: T0 + 2 * H, pct: 10 }, { at: T0 + 3 * H, pct: 12 },
      { at: T0 + 10 * H, pct: 15 }, { at: T0 + 11 * H, pct: 16 },
    ] }]
    expect(toChartRows(series, 7 * 24 * H).rows.map(r => r.s0)).toEqual([50, 49, null, 10, 12, null, 15, 16])
  })
  test('step values remain at the last reading across another account’s timestamp', () => {
    const a = { key: 'a', harness: 'claude' as const, account: 'a', label: 'A', points: [{ at: T0, pct: 10 }, { at: T0 + H, pct: 30 }] }
    const b = { ...a, key: 'b', account: 'b', points: [{ at: T0 + H / 2, pct: 20 }, { at: T0 + H, pct: 25 }] }
    expect(toChartRows([a, b], 5 * H).rows.map(r => r.s0)).toEqual([10, 10, 30])
    const grouped = harnessSeries([a, b], 5 * H, h => h)
    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.points.map(p => p.pct)).toEqual([10, 20, 30])
  })
  test('hour bars conserve measured increases and divide across hour boundaries', () => {
    const s = { key: 'a', harness: 'claude' as const, account: 'a', label: 'A', points: [{ at: T0 + H / 2, pct: 10 }, { at: T0 + H * 1.5, pct: 30 }] }
    const bars = hourlyUsage([s], T0, T0 + 2 * H)
    expect(bars.map(r => r.a ?? 0)).toEqual([10, 10, 0])
    expect(topPeaks([s], '5h')[0]).toMatchObject({ rise: 20, duration: H, key: 'a' })
  })
  test('weekday × hour bins use local message timestamps and conserve total', () => {
    const d = new Date(2026, 9, 26, 17, 30)
    const result = messageActivity([{ user_message_timestamps: [d.toISOString(), d.toISOString()] }], d.getTime())
    expect(result.cells).toHaveLength(7)
    expect(result.cells.every(row => row.length === 24)).toBe(true)
    expect(result.cells[0]![17]).toBe(2)
    expect(result.cells.flat().reduce((a, b) => a + b, 0)).toBe(result.total)
  })
})
