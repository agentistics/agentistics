import { describe, expect, test } from 'bun:test'
import type { PlanReadings } from '../../lib/planLimits'
import { limitSeries, messageActivity, rateRows, scopeReadings, scopeSessions, toChartRows, topPeaks } from './usageChartsModel'

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
    expect(rows.some(r => r.s0 === null)).toBe(true)
    expect(rows.filter(r => r.s0 !== null).map(r => r.s0)).toEqual([5, 25, 2])
  })
})

describe('peaks', () => {
  test('ranks the fastest climb and ignores a renewal drop', () => {
    const { series } = limitSeries([claude], '5h', label)
    const [peak] = topPeaks(series, '5h', 3, 0.5)
    expect(peak!.ratePerHour).toBe(20)
    expect(topPeaks(series, '5h').every(p => p.rise > 0)).toBe(true)
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
