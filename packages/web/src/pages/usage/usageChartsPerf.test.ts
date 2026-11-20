import { describe, expect, test } from 'bun:test'
import { toChartRows, type LimitSeries } from './usageChartsModel'

const H = 3_600_000
const T0 = Date.parse('2026-10-20T00:00:00Z')

/** The ORIGINAL quadratic reading of `toChartRows` (find + findLast per row), kept as the oracle. */
type P = LimitSeries['points'][number]
const disconnected = (a: P, b: P, kind: 'week' | '5h'): boolean =>
  kind === 'week' ? b.at - a.at > 6 * H || a.pct - b.pct > 20
    : !!b.gapBefore || b.at - a.at > H || b.pct < a.pct || (a.reset !== undefined && b.reset !== undefined && Math.abs(a.reset - b.reset) > 300_000)
function oracle(series: readonly LimitSeries[], duration: number) {
  const kind = duration > 24 * H ? 'week' : '5h'
  const segments = series.map(s => {
    const out: P[][] = []
    for (const p of s.points) {
      const last = out.at(-1)
      if (!last || disconnected(last.at(-1)!, p, s.kind ?? kind)) out.push([p]); else last.push(p)
    }
    return out.filter(segment => segment.length >= 2 && ((s.kind ?? kind) === 'week' || segment.at(-1)!.at - segment[0]!.at >= 60_000))
  })
  const times = new Set<number>()
  for (const group of segments) for (let i = 0; i < group.length; i++) {
    group[i]!.forEach(p => times.add(p.at))
    if (i) times.add(Math.floor((group[i - 1]!.at(-1)!.at + group[i]![0]!.at) / 2))
  }
  return [...times].sort((a, b) => a - b).map(at => {
    const row: { at: number; [key: string]: number | null } = { at }
    segments.forEach((groups, i) => {
      const segment = groups.find(g => at >= g[0]!.at && at <= g.at(-1)!.at)
      row[`s${i}`] = segment?.findLast(p => p.at <= at)?.pct ?? null
    })
    return row
  })
}

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 }
function randomSeries(seed: number, n: number, stepMin: number, kind: 'week' | '5h'): LimitSeries {
  const r = rng(seed); let at = T0; let pct = 10
  const points: P[] = []
  for (let i = 0; i < n; i++) {
    at += Math.round((stepMin * (0.5 + r())) * 60_000)
    if (r() < 0.03) pct = Math.floor(r() * 30); else if (r() < 0.3) pct = Math.min(100, pct + Math.floor(r() * 3))
    points.push({ at, pct, ...(r() < 0.5 ? { reset: T0 + Math.floor(at / (5 * H)) * 5 * H } : {}), ...(r() < 0.02 ? { gapBefore: true } : {}) })
  }
  return { kind, key: `k${seed}`, harness: 'claude', account: `a${seed}`, label: `s${seed}`, points }
}

describe('toChartRows stays equal to its definition while being linear', () => {
  for (const kind of ['week', '5h'] as const) test(`${kind}: identical rows on random series (incl. gaps, resets, ties)`, () => {
    for (let seed = 1; seed <= 12; seed++) {
      const series = [randomSeries(seed, 150, kind === 'week' ? 40 : 4, kind), randomSeries(seed + 100, 90, kind === 'week' ? 55 : 6, kind)]
      expect(toChartRows(series, kind === 'week' ? 7 * 24 * H : 5 * H).rows).toEqual(oracle(series, kind === 'week' ? 7 * 24 * H : 5 * H))
    }
  })
  test('14 days at 5 min × 4 accounts builds in well under a second (was quadratic)', () => {
    const series = [1, 2, 3, 4].map(s => randomSeries(s, 4032, 5, 'week'))
    const t = performance.now()
    const { rows } = toChartRows(series, 7 * 24 * H)
    const ms = performance.now() - t
    expect(rows.length).toBeGreaterThan(4000)
    expect(ms).toBeLessThan(150)
  })
})
