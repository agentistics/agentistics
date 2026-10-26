/**
 * PLAN HISTORY — the persisted, downsampled series behind Usage → History. The in-memory
 * `history` of `plan-limits.ts` keeps the last 32 raw readings for the pace maths; readings land
 * every few minutes, so those cover about an hour and vanish on restart. This keeps what a chart
 * needs: one point per 5-minute bucket (the newest reading of the bucket wins), a window's reset
 * id on every point so a line can break where a window renewed, bounded by age and by count, in a
 * file of its own so it never competes with the limits record for its lock.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PlanLimits } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR } from './config'
import { withFileLock } from './sessions/file-lock'

/** One model group's week reading inside a point (scoped harnesses, e.g. Antigravity). */
export interface ScopePoint { weekPct: number; weekReset?: number }

/**
 * `weekPct`/`weekReset` stay the TIGHTEST group's on a scoped record, so a reader that ignores `scopes`
 * (an older build, a flat chart) stays meaningful and conservative.
 */
export interface HistoryPoint { at: number; weekPct: number | null; fiveHourPct: number | null; weekReset?: number; fiveReset?: number; scopes?: Record<string, ScopePoint> }

export const BUCKET_MS = 5 * 60_000
export const RETAIN_MS = 14 * 24 * 3_600_000
/** 14 days of 5-minute buckets. */
export const MAX_POINTS = 14 * 24 * 12

export function pointOf(l: PlanLimits): HistoryPoint {
  const weeks = l.windows.filter(w => w.kind === 'week')
  // Scoped: the tightest group is the flat value (parsers sort tightest-first, but never rely on it).
  const week = l.windows.some(w => w.scope)
    ? weeks.reduce<typeof weeks[number] | undefined>((a, w) => (!a || w.usedPct > a.usedPct ? w : a), undefined)
    : weeks[0]
  const five = l.windows.find(w => w.kind === '5h')
  const scoped = weeks.filter(w => w.scope)
  return {
    at: l.updatedAt,
    ...(scoped.length ? { scopes: Object.fromEntries(scoped.map(w => [w.scope!.id, { weekPct: w.usedPct, weekReset: w.resetsAt }])) } : {}), weekPct: week?.usedPct ?? null, fiveHourPct: five?.usedPct ?? null,
    ...(week?.resetsAt !== undefined ? { weekReset: week.resetsAt } : {}),
    ...(five?.resetsAt !== undefined ? { fiveReset: five.resetsAt } : {}),
  }
}

/** A window renewed between two points: its reset id changed. Always kept, whatever the bucket. */
export const isBoundary = (a: HistoryPoint, b: HistoryPoint): boolean =>
  (a.weekReset !== undefined && b.weekReset !== undefined && Math.abs(a.weekReset - b.weekReset) > BUCKET_MS)
  || (a.fiveReset !== undefined && b.fiveReset !== undefined && Math.abs(a.fiveReset - b.fiveReset) > BUCKET_MS)

/** Fold one reading into a series: pure, ordered, bucketed, bounded. */
export function appendPoint(series: readonly HistoryPoint[], next: HistoryPoint): HistoryPoint[] {
  const cutoff = next.at - RETAIN_MS
  const out = series.filter(p => p.at >= cutoff)
  const last = out.at(-1)
  if (last && next.at < last.at) {
    // Late arrival: replace an identical timestamp, otherwise insert in order.
    const i = out.findIndex(p => p.at === next.at)
    if (i >= 0) out[i] = next
    else { out.push(next); out.sort((a, b) => a.at - b.at) }
  } else if (last && Math.floor(last.at / BUCKET_MS) === Math.floor(next.at / BUCKET_MS) && !isBoundary(last, next)) {
    // A source that reports one window (codex) must not erase the other's reading from the bucket.
    out[out.length - 1] = {
      ...next,
      weekPct: next.weekPct ?? last.weekPct, fiveHourPct: next.fiveHourPct ?? last.fiveHourPct,
      ...(next.weekReset === undefined && last.weekReset !== undefined ? { weekReset: last.weekReset } : {}),
      ...(next.fiveReset === undefined && last.fiveReset !== undefined ? { fiveReset: last.fiveReset } : {}),
      ...(next.scopes || last.scopes ? { scopes: { ...last.scopes, ...next.scopes } } : {}),
    }
  } else out.push(next)
  return out.length > MAX_POINTS ? out.slice(-MAX_POINTS) : out
}

/** Union of two series of one key (two processes may both have written): by timestamp, re-bucketed. */
export function mergeSeries(a: readonly HistoryPoint[], b: readonly HistoryPoint[]): HistoryPoint[] {
  const all = new Map<number, HistoryPoint>()
  for (const p of [...a, ...b]) all.set(p.at, p)
  let out: HistoryPoint[] = []
  for (const p of [...all.values()].sort((x, y) => x.at - y.at)) out = appendPoint(out, p)
  return out
}

let filePath: string | null = null
const FILE = (): string => filePath ?? join(AGENTISTICS_DATA_DIR, 'plan-history.json')
const series = new Map<string, HistoryPoint[]>()
let loaded = false
let timer: ReturnType<typeof setTimeout> | null = null

const valid = (p: unknown): p is HistoryPoint => {
  const x = p as HistoryPoint
  return !!x && typeof x.at === 'number' && Number.isFinite(x.at)
    && (x.weekPct === null || typeof x.weekPct === 'number') && (x.fiveHourPct === null || typeof x.fiveHourPct === 'number')
    && (x.scopes === undefined || (!!x.scopes && typeof x.scopes === 'object'
      && Object.values(x.scopes).every(s => !!s && typeof s.weekPct === 'number' && Number.isFinite(s.weekPct))))
}

async function readDisk(): Promise<Record<string, HistoryPoint[]>> {
  try {
    const raw = JSON.parse(await readFile(FILE(), 'utf8')) as { series?: Record<string, unknown> }
    const out: Record<string, HistoryPoint[]> = {}
    for (const [k, v] of Object.entries(raw.series ?? {})) if (Array.isArray(v)) out[k] = v.filter(valid)
    return out
  } catch { return {} }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  for (const [k, v] of Object.entries(await readDisk())) series.set(k, mergeSeries(v, series.get(k) ?? []))
}

function flushSoon(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flush().catch(() => { flushSoon() })
  }, 2000)
  timer.unref?.()
}

/** Write the series, merged with what another process wrote, under the file's lock. */
export async function flush(): Promise<void> {
  await withFileLock(FILE(), async ({ contended }) => {
    if (contended) throw new Error('contended')
    const disk = await readDisk()
    const out: Record<string, HistoryPoint[]> = {}
    for (const k of new Set([...Object.keys(disk), ...series.keys()])) out[k] = mergeSeries(disk[k] ?? [], series.get(k) ?? [])
    const tmp = `${FILE()}.${process.pid}.tmp`
    await mkdir(dirname(FILE()), { recursive: true })
    await writeFile(tmp, JSON.stringify({ v: 1, series: out }), { mode: 0o600 })
    await rename(tmp, FILE())
  })
}

export async function recordHistory(key: string, l: PlanLimits): Promise<void> {
  await ensureLoaded()
  series.set(key, appendPoint(series.get(key) ?? [], pointOf(l)))
  flushSoon()
}

export async function historyOf(key: string): Promise<HistoryPoint[]> {
  await ensureLoaded()
  return series.get(key) ?? []
}

export async function allHistory(): Promise<[string, HistoryPoint[]][]> {
  await ensureLoaded()
  return [...series.entries()]
}

/** A new meter segment, or an account re-key: the old series goes with its key. */
export async function dropHistory(key: string): Promise<void> {
  await ensureLoaded()
  if (series.delete(key)) flushSoon()
}
export async function moveHistory(from: string, to: string): Promise<void> {
  await ensureLoaded()
  const a = series.get(from)
  if (!a) return
  series.set(to, mergeSeries(series.get(to) ?? [], a))
  series.delete(from)
  flushSoon()
}

/** Tests only. */
export function __resetPlanHistoryForTest(file: string | null): void {
  series.clear(); loaded = false; filePath = file
  if (timer) { clearTimeout(timer); timer = null }
}
