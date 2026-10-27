/**
 * Pure shaping for Usage: one scope selects plan readings and message activity. Account rows,
 * overlays and harness comparisons all preserve registry identity and observed reset boundaries.
 */
import type { SessionMeta } from '@agentistics/core'
import type { PlanReadings } from '../../lib/planLimits'

export type UsageScopeMode = 'accounts' | 'all' | 'harnesses' | 'harness' | 'account'
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

export interface LimitSeries { kind?: 'week' | '5h'; key: string; harness: ReadingHarness; account: string; label: string; points: { at: number; pct: number; reset?: number; gapBefore?: boolean }[] }

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
    if (points.length) series.push({ kind, key: readingKey(r), harness: r.harness, account: r.account, label: labelOf(r), points })
    else omitted.push(labelOf(r))
  }
  return { series, omitted }
}

type LimitPoint = LimitSeries['points'][number]
/** Weekly readings tolerate jitter and missing samples; short windows keep reset identities. */
const disconnected = (a: LimitPoint, b: LimitPoint, kind: 'week' | '5h' = '5h'): boolean =>
  kind === 'week' ? b.at - a.at > 6 * 3_600_000 || a.pct - b.pct > 20
    : !!b.gapBefore || b.at - a.at > 3_600_000 || b.pct < a.pct
      || (a.reset !== undefined && b.reset !== undefined && Math.abs(a.reset - b.reset) > 300_000)

/** Chart rows hold the last observed value. Nulls separate resets; isolated readings are omitted. */
export function toChartRows(series: readonly LimitSeries[], duration: number): { rows: { at: number; [key: string]: number | null }[]; keys: { key: string; identity: string; label: string; harness: ReadingHarness }[] } {
  const kind = duration > 24 * 3_600_000 ? 'week' : '5h'
  const segments = series.map(s => {
    const out: LimitPoint[][] = []
    for (const p of s.points) {
      const last = out.at(-1)
      if (!last || disconnected(last.at(-1)!, p, s.kind ?? kind)) out.push([p])
      else last.push(p)
    }
    return out.filter(segment => segment.length >= 2)
  })
  const times = new Set<number>()
  for (const group of segments) for (let i = 0; i < group.length; i++) {
    group[i]!.forEach(p => times.add(p.at))
    if (i) times.add(Math.floor((group[i - 1]!.at(-1)!.at + group[i]![0]!.at) / 2))
  }
  const rows = [...times].sort((a, b) => a - b).map(at => {
    const row: { at: number; [key: string]: number | null } = { at }
    segments.forEach((groups, i) => {
      const segment = groups.find(g => at >= g[0]!.at && at <= g.at(-1)!.at)
      row[`s${i}`] = segment?.findLast(p => p.at <= at)?.pct ?? null
    })
    return row
  })
  return { rows, keys: series.map((s, i) => ({ key: `s${i}`, identity: s.key, label: s.label, harness: s.harness })) }
}

/** Maximum observed account usage for each harness; never sum percentages of separate plans. */
export function harnessSeries(series: readonly LimitSeries[], duration: number, label: (h: ReadingHarness) => string): LimitSeries[] {
  const { rows, keys } = toChartRows(series, duration)
  return [...new Set(series.map(s => s.harness))].map(harness => {
    const own = keys.filter(k => k.harness === harness)
    let missing = false
    const points = rows.flatMap(row => {
      const values = own.map(k => row[k.key]).filter((v): v is number => v != null)
      if (!values.length) { missing = true; return [] }
      const point = { at: row.at, pct: Math.max(...values), ...(missing ? { gapBefore: true } : {}) }
      missing = false
      return [point]
    })
    return { key: harness, harness, account: '', label: label(harness), points }
  })
}

export interface Peak { label: string; kind: 'week' | '5h'; key: string; at: number; duration: number; ratePerHour: number; rise: number }

/** Interval rises (pp per hour) between consecutive points of one window; a renewal (the % fell) is not a rise. */
export function riseIntervals(series: readonly LimitSeries[]): { at: number; key: string; label: string; duration: number; ratePerHour: number; rise: number }[] {
  const out: { at: number; key: string; label: string; duration: number; ratePerHour: number; rise: number }[] = []
  for (const s of series) {
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1]!, b = s.points[i]!
      const hours = (b.at - a.at) / 3_600_000
      const rise = b.pct - a.pct
      if (hours <= 0 || rise <= 0 || disconnected(a, b)) continue
      out.push({ at: b.at, key: s.key, label: s.label, duration: b.at - a.at, rise, ratePerHour: rise / hours })
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
      for (const r of riseIntervals([{ ...s, points: merged }])) peaks.push({ key: r.key, label: r.label, kind, at: r.at, duration: r.duration, ratePerHour: r.ratePerHour, rise: r.rise })
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
  cells: number[][]
} {
  const since = now - days * 24 * 3_600_000
  const dayCounts = new Map<string, number>()
  const hourCounts: Record<number, number> = {}
  const cells = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  let total = 0
  for (const s of sessions) {
    for (const ts of s.user_message_timestamps ?? []) {
      const t = Date.parse(ts)
      if (!Number.isFinite(t) || t < since || t > now) continue
      const d = new Date(t)
      dayCounts.set(dayKey(d), (dayCounts.get(dayKey(d)) ?? 0) + 1)
      hourCounts[d.getHours()] = (hourCounts[d.getHours()] ?? 0) + 1
      cells[(d.getDay() + 6) % 7]![d.getHours()]!++
      total++
    }
  }
  return { perDay: [...dayCounts.entries()].map(([date, value]) => ({ date, value, sessions: 0, tools: 0 })), hourCounts, total, cells }
}

/** Allocate each observed increase across the hours it spans, conserving the measured amount. */
export function hourlyUsage(series: readonly LimitSeries[], since: number, until: number) {
  const rows = new Map<number, { at: number; [key: string]: number }>()
  for (let at = Math.floor(since / 3_600_000) * 3_600_000; at <= until; at += 3_600_000) rows.set(at, { at })
  for (const interval of riseIntervals(series)) {
    const start = interval.at - interval.duration
    for (let hour = Math.floor(start / 3_600_000) * 3_600_000; hour < interval.at; hour += 3_600_000) {
      const overlap = Math.max(0, Math.min(interval.at, hour + 3_600_000, until) - Math.max(start, hour, since))
      const row = rows.get(hour)
      if (row && overlap) row[interval.key] = (row[interval.key] ?? 0) + interval.rise * overlap / interval.duration
    }
  }
  return [...rows.values()]
}
