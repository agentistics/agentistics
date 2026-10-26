/**
 * USAGE CHARTS MODEL — the pure shaping behind the Usage screen's three charts. One filter
 * (everything overlaid | one harness | one account) selects the readings and the sessions all
 * three charts draw, so they can never disagree about what "this view" is.
 */
import type { SessionMeta } from '@agentistics/core'
import type { PlanReadings } from '../../lib/planLimits'

export type UsageScopeMode = 'all' | 'harness' | 'account'
export interface UsageScope { mode: UsageScopeMode; /** harness id, or `harness:account` */ key?: string }
export type ReadingHarness = PlanReadings['harness']

export const readingKey = (r: Pick<PlanReadings, 'harness' | 'account'>): string => `${r.harness}:${r.account}`

/** The readings the filter keeps. A mode with no pick yet keeps everything, never nothing. */
export function scopeReadings(readings: readonly PlanReadings[], scope: UsageScope): PlanReadings[] {
  if (scope.mode === 'harness' && scope.key) return readings.filter(r => r.harness === scope.key)
  if (scope.mode === 'account' && scope.key) return readings.filter(r => readingKey(r) === scope.key)
  return [...readings]
}

/** The same selection, for sessions (each one carries its harness and registry account). */
export function scopeSessions<S extends Pick<SessionMeta, 'harness' | 'account'>>(sessions: readonly S[], scope: UsageScope): S[] {
  if (scope.mode === 'harness' && scope.key) return sessions.filter(s => s.harness === scope.key)
  if (scope.mode === 'account' && scope.key) return sessions.filter(s => `${s.harness}:${s.account ?? 'default'}` === scope.key)
  return [...sessions]
}

export interface LimitSeries { key: string; harness: ReadingHarness; account: string; label: string; points: { at: number; pct: number; reset?: number; gapBefore?: boolean }[] }

/** One line per reading for a window kind; a reading with no point of that kind is `omitted` (named, not drawn as 0). */
export function limitSeries(readings: readonly PlanReadings[], kind: 'week' | '5h', labelOf: (r: PlanReadings) => string, since?: number): { series: LimitSeries[]; omitted: string[] } {
  const series: LimitSeries[] = []
  const omitted: string[] = []
  for (const r of readings) {
    let missing = false
    const points = [...r.points].sort((a, b) => a.at - b.at).flatMap(p => {
      const pct = kind === 'week' ? p.weekPct : p.fiveHourPct
      if (since !== undefined && p.at < since) return []
      if (pct === null || !Number.isFinite(pct)) { missing = true; return [] }
      const reset = kind === 'week' ? p.weekReset : p.fiveReset
      const point = { at: p.at, pct, ...(reset !== undefined ? { reset } : {}), ...(missing ? { gapBefore: true } : {}) }
      missing = false
      return [point]
    })
    if (points.length) series.push({ key: readingKey(r), harness: r.harness, account: r.account, label: labelOf(r), points })
    else omitted.push(labelOf(r))
  }
  return { series, omitted }
}

type LimitPoint = LimitSeries['points'][number]
/** Five-minute samples may jitter; a changed reset, decrease, or hour without readings breaks continuity. */
const disconnected = (a: LimitPoint, b: LimitPoint): boolean =>
  !!b.gapBefore || b.at - a.at > 3_600_000 || b.pct < a.pct
  || (a.reset !== undefined && b.reset !== undefined && Math.abs(a.reset - b.reset) > 300_000)

/** Series → chart rows. Nulls are real breaks; union timestamps inside a segment interpolate the
 * same straight line the chart draws, so another account's sample never interrupts this one. */
export function toChartRows(series: readonly LimitSeries[], _duration: number): { rows: { at: number; [key: string]: number | null }[]; keys: { key: string; label: string; harness: ReadingHarness }[] } {
  const times = new Set<number>()
  const keys = series.map((s, i) => ({ key: `s${i}`, label: s.label, harness: s.harness }))
  for (const s of series) {
    s.points.forEach(p => times.add(p.at))
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1]!, b = s.points[i]!
      if (disconnected(a, b) && b.at - a.at > 1) times.add(Math.floor((a.at + b.at) / 2))
    }
  }
  const rows = [...times].sort((a, b) => a - b).map(at => ({ at } as { at: number; [key: string]: number | null }))
  series.forEach((s, i) => {
    let next = 0
    for (const row of rows) {
      while (next < s.points.length && s.points[next]!.at < row.at) next++
      const b = s.points[next], a = s.points[next - 1]
      row[`s${i}`] = b?.at === row.at ? b.pct
        : a && b && !disconnected(a, b) ? a.pct + (b.pct - a.pct) * (row.at - a.at) / (b.at - a.at) : null
    }
  })
  return { rows, keys }
}

export interface Peak { label: string; kind: 'week' | '5h'; at: number; ratePerHour: number; rise: number }

/** Interval rises (pp per hour) between consecutive points of one window; a renewal (the % fell) is not a rise. */
export function riseIntervals(series: readonly LimitSeries[]): { at: number; label: string; ratePerHour: number; rise: number }[] {
  const out: { at: number; label: string; ratePerHour: number; rise: number }[] = []
  for (const s of series) {
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1]!, b = s.points[i]!
      const hours = (b.at - a.at) / 3_600_000
      const rise = b.pct - a.pct
      if (hours <= 0 || rise <= 0 || disconnected(a, b)) continue
      out.push({ at: b.at, label: s.label, rise, ratePerHour: rise / hours })
    }
  }
  return out
}

/** Where the % rose fastest, over intervals of at least `minHours` so a 5-min blip does not read as a spike. */
export function topPeaks(series: readonly LimitSeries[], kind: 'week' | '5h', n = 3, minHours = 0.5): Peak[] {
  const peaks: Peak[] = []
  for (const s of series) {
    let merged: LimitSeries['points'] = []
    const collect = () => {
      for (const r of riseIntervals([{ ...s, points: merged }])) peaks.push({ label: r.label, kind, at: r.at, ratePerHour: r.ratePerHour, rise: r.rise })
    }
    // Segment BEFORE coarsening: otherwise a skipped reset can turn into an invented climb.
    for (let i = 0; i < s.points.length; i++) {
      const p = s.points[i]!, prev = s.points[i - 1]
      if (prev && disconnected(prev, p)) { collect(); merged = [] }
      const last = merged.at(-1)
      if (!last || (p.at - last.at) / 3_600_000 >= minHours) merged.push(p)
    }
    collect()
  }
  return peaks.sort((a, b) => b.ratePerHour - a.ratePerHour).slice(0, n)
}

/** Observed interval rate rows (pp/h, max across the selected lines per interval end), for the peaks chart. */
export function rateRows(series: readonly LimitSeries[], cap = 100): { at: number; rate: number | null }[] {
  const by = new Map<number, number>()
  for (const r of riseIntervals(series)) by.set(r.at, Math.max(by.get(r.at) ?? 0, Math.min(cap, r.ratePerHour)))
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([at, rate]) => ({ at, rate }))
}

const dayKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Message counts by local day and by local hour over the last `days` days, from each message's own timestamp. */
export function messageActivity(sessions: readonly Pick<SessionMeta, 'user_message_timestamps'>[], now: number, days = 14): {
  perDay: { date: string; value: number; sessions: number; tools: number }[]
  hourCounts: Record<number, number>
  total: number
} {
  const since = now - days * 24 * 3_600_000
  const dayCounts = new Map<string, number>()
  const hourCounts: Record<number, number> = {}
  let total = 0
  for (const s of sessions) {
    for (const ts of s.user_message_timestamps ?? []) {
      const t = Date.parse(ts)
      if (!Number.isFinite(t) || t < since || t > now) continue
      const d = new Date(t)
      dayCounts.set(dayKey(d), (dayCounts.get(dayKey(d)) ?? 0) + 1)
      hourCounts[d.getHours()] = (hourCounts[d.getHours()] ?? 0) + 1
      total++
    }
  }
  return { perDay: [...dayCounts.entries()].map(([date, value]) => ({ date, value, sessions: 0, tools: 0 })), hourCounts, total }
}
