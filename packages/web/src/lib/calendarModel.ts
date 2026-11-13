/**
 * calendarModel.ts — PURE. The geometry and wording of the Delivery calendar's views, over core's
 * `CalendarReply` (`@agentistics/core` `deliveryCalendar.ts`, the one source the route, the MCP tool and the
 * CLI share). Nothing here decides what is active, when a version ships or what "confirmed" means — that is core's;
 * this file only places what core already decided on a month grid, a week, a day and a time axis.
 *
 * Every day is a BRT day (`brtDay`), whatever zone the browser is in.
 */
import {
  brtDay, brtDayStartMs, brtParts, CAL_STAGES, pieceDayPresence,
  type CalMark, type CalPiece, type CalPriority, type CalStage, type CalVersion,
} from '@agentistics/core'

export type CalView = 'month' | 'week' | 'day' | 'schedule' | 'agenda'
export const DAY_MS = 86_400_000

/** Horizontal swipes preserve the selected weekday; vertical scrolling never changes the date. */
export function swipeDay(day: string, dx: number, dy: number, span: number): string {
  return Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5 ? addDays(day, dx < 0 ? span : -span) : day
}

/** Interval partitioning. Touching endpoints reuse a lane; disconnected groups regain full width. */
export function packIntervals<T extends { fromMs: number; toMs: number }>(events: readonly T[]): (T & { lane: number; lanes: number })[] {
  const sorted = [...events].sort((a, b) => a.fromMs - b.fromMs || b.toMs - a.toMs)
  const out: (T & { lane: number; lanes: number })[] = []
  let group: typeof out = [], ends: number[] = [], groupEnd = -Infinity
  const finish = () => { for (const e of group) e.lanes = ends.length; group = []; ends = [] }
  for (const e of sorted) {
    if (e.fromMs >= groupEnd) finish()
    let lane = ends.findIndex(end => end <= e.fromMs)
    if (lane < 0) lane = ends.length
    ends[lane] = e.toMs
    const placed = { ...e, lane, lanes: 1 }
    out.push(placed); group.push(placed)
    groupEnd = Math.max(groupEnd, e.toMs)
  }
  finish()
  return out
}

export type ColumnItem =
  | { kind: 'card'; id: string; top: number; height: number; hidden: number }
  | { kind: 'chip'; top: number; height: number; count: number }

/**
 * A thin phone column (week, 3 days) never splits into lanes: it shows ONE full-width card per stretch of overlapping time,
 * then a single "+N" chip right under it counting what that card hides. One minute is one pixel, every target is at least
 * `minPx` tall, and an event that would start inside a card's footprint (or the chip's) joins the hidden count — so no two
 * targets of a column ever overlap.
 */
export function placeColumn(events: readonly { id: string; fromMs: number; toMs: number }[], d0: number, minPx = 44): ColumnItem[] {
  const sorted = [...events].sort((a, b) => a.fromMs - b.fromMs || b.toMs - a.toMs)
  const out: ColumnItem[] = []
  let i = 0
  while (i < sorted.length) {
    const e = sorted[i++]!
    const top = (e.fromMs - d0) / 60_000
    const height = Math.max(minPx, (e.toMs - e.fromMs) / 60_000)
    let end = top + height, hidden = 0
    while (i < sorted.length && (sorted[i]!.fromMs - d0) / 60_000 < end) {
      hidden++; i++
      if (hidden === 1) end += minPx // the chip's footprint is reserved as soon as there is something to count
    }
    out.push({ kind: 'card', id: e.id, top, height, hidden })
    if (hidden > 0) out.push({ kind: 'chip', top: top + height, height: minPx, count: hidden })
  }
  return out
}

// ------------------------------------------------------------------------------------------ day arithmetic

/** `yyyy-MM-dd` + n days (calendar arithmetic on the string; no zone involved). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10)
}
export function addMonths(day: string, n: number): string {
  const d = new Date(Date.parse(`${day}T00:00:00.000Z`))
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), last))).toISOString().slice(0, 10)
}
/** 0 = Monday … 6 = Sunday. */
export function weekdayMon0(day: string): number { return (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7 }
export function diffDays(a: string, b: string): number { return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / DAY_MS) }

export function monthCells(anchor: string): { day: string; inMonth: boolean }[] {
  const first = `${anchor.slice(0, 7)}-01`
  const start = addDays(first, -weekdayMon0(first))
  return Array.from({ length: 42 }, (_, i) => { const day = addDays(start, i); return { day, inMonth: day.slice(0, 7) === anchor.slice(0, 7) } })
}
export function weekDays(anchor: string): string[] {
  const start = addDays(anchor, -weekdayMon0(anchor))
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

/** Moves the anchor one step of the view: a month, a week or a day. */
export function stepAnchor(view: CalView, anchor: string, dir: -1 | 1): string {
  if (view === 'month') return addMonths(anchor, dir)
  if (view === 'week') return addDays(anchor, 7 * dir)
  return addDays(anchor, dir)
}

/** The instants the view covers, for the server's `from`/`to` semantics and for client-side clipping. */
export function viewWindow(view: CalView, anchor: string): { fromMs: number; toMs: number } {
  const [from, to] = view === 'month' ? [monthCells(anchor)[0]!.day, monthCells(anchor)[41]!.day]
    : view === 'week' ? [weekDays(anchor)[0]!, weekDays(anchor)[6]!]
      : view === 'schedule' ? [anchor, addDays(anchor, 1)] : [anchor, anchor]
  return { fromMs: brtDayStartMs(from), toMs: brtDayStartMs(addDays(to, 1)) - 1 }
}

const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DOW_PT = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo']
const DOW_EN = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const dowShort = (i: number, pt: boolean) => (pt ? DOW_PT : DOW_EN)[i]!.slice(0, 3)
export const monthName = (m: number, pt: boolean) => (pt ? MONTHS_PT : MONTHS_EN)[m]!
const dayNum = (d: string) => Number(d.slice(8, 10))
const monthIdx = (d: string) => Number(d.slice(5, 7)) - 1

export function rangeLabel(view: CalView, anchor: string, pt: boolean): string {
  const m = (d: string) => monthName(monthIdx(d), pt)
  if (view === 'month') return pt ? `${m(anchor)} de ${anchor.slice(0, 4)}` : `${m(anchor)} ${anchor.slice(0, 4)}`
  if (view === 'week') {
    const w = weekDays(anchor), a = w[0]!, b = w[6]!
    return pt ? `${dayNum(a)}${monthIdx(a) !== monthIdx(b) ? ` de ${m(a)}` : ''} – ${dayNum(b)} de ${m(b)}` : `${m(a)} ${dayNum(a)} – ${monthIdx(a) !== monthIdx(b) ? `${m(b)} ` : ''}${dayNum(b)}`
  }
  if (view === 'schedule') {
    const b = addDays(anchor, 1), s = (d: string) => `${dowShort(weekdayMon0(d), pt)} ${String(dayNum(d)).padStart(2, '0')}`
    return `${s(anchor)} – ${s(b)}`
  }
  const dow = (pt ? DOW_PT : DOW_EN)[weekdayMon0(anchor)]!
  return pt ? `${dow}, ${dayNum(anchor)} de ${m(anchor)}` : `${dow}, ${m(anchor)} ${dayNum(anchor)}`
}

/** `15h40` / `3:40 PM`-free: the product writes BRT clock times as `HHhMM`. */
export function clock(ms: number): string { const p = brtParts(ms); return `${String(p.hour).padStart(2, '0')}h${String(p.minute).padStart(2, '0')}` }
/** `Sáb 07/11 · 14h12`. */
export function stamp(ms: number, pt: boolean): string {
  const p = brtParts(ms)
  return `${dowShort(weekdayMon0(p.day), pt)} ${p.day.slice(8, 10)}/${p.day.slice(5, 7)} · ${clock(ms)}`
}
/** "hoje" / "amanhã" / "em N dias" / "ontem" / "há N dias". */
export function relativeDay(day: string, today: string, pt: boolean): string {
  const d = diffDays(today, day)
  if (d === 0) return pt ? 'hoje' : 'today'
  if (d === 1) return pt ? 'amanhã' : 'tomorrow'
  if (d === -1) return pt ? 'ontem' : 'yesterday'
  return d > 0 ? (pt ? `em ${d} dias` : `in ${d} days`) : (pt ? `há ${-d} dias` : `${-d} days ago`)
}

// ------------------------------------------------------------------------------------------ pieces

const PRIORITY_RANK: Record<CalPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
/** Urgent → low; a piece with no priority last; then the version, then the title — a total order. */
export function byPriority(a: CalPiece, b: CalPiece): number {
  const pa = a.priority ? PRIORITY_RANK[a.priority] : 9, pb = b.priority ? PRIORITY_RANK[b.priority] : 9
  return pa - pb || (a.version ?? '~').localeCompare(b.version ?? '~', undefined, { numeric: true }) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key)
}

/** The stage bar of a version card: each stage's share, in the line's own order. */
export function stageSegments(v: CalVersion): { stage: CalStage; count: number; pct: number }[] {
  const total = Object.values(v.stageCounts).reduce((s, n) => s + (n ?? 0), 0) || 1
  return CAL_STAGES.flatMap(stage => { const count = v.stageCounts[stage] ?? 0; return count ? [{ stage, count, pct: (count / total) * 100 }] : [] })
}

// ------------------------------------------------------------------------------------------ month ribbons

export interface Ribbon {
  version: string
  /** Every version this ribbon stands for, oldest first: several releases of ONE day share a ribbon (a lane each pushed all but the first into "+N"). `version` is the newest. */
  versions: string[]
  state: 'published' | 'planned'
  /** The label's right side: `publicada` / `prevista` / `sem estimativa`. */
  note: 'published' | 'expected' | 'none'
  startCol: number
  endCol: number
  lane: number
  /** The ribbon continues past the week's edge on that side. */
  contLeft: boolean
  contRight: boolean
}

/** The days a version occupies on the calendar: a published one is its day; a planned one runs from where its work began to its expected day. */
export function versionDays(v: CalVersion, pieces: readonly CalPiece[], todayDay: string): { start: string; end: string } | null {
  if (v.state === 'published') return v.atMs === null ? null : { start: brtDay(v.atMs), end: brtDay(v.atMs) }
  if (v.atMs === null) return { start: todayDay, end: todayDay }
  const starts = pieces.filter(p => v.pieceKeys.includes(p.key)).flatMap(p => (p.startedAtMs !== null ? [brtDay(p.startedAtMs)] : []))
  const end = brtDay(v.atMs)
  const start = [...starts, todayDay].filter(d => d <= end).sort()[0] ?? end
  return { start: start < end ? start : end, end }
}

/** Ribbons for ONE week row (7 consecutive days), lane-packed so none overlaps. */
export function weekRibbons(days: readonly string[], versions: readonly CalVersion[], pieces: readonly CalPiece[], todayDay: string): Ribbon[] {
  const first = days[0]!, last = days[6]!
  const out: Ribbon[] = []
  for (const v of versions) {
    const span = versionDays(v, pieces, todayDay)
    if (!span || span.end < first || span.start > last) continue
    const startCol = Math.max(0, diffDays(first, span.start)), endCol = Math.min(6, diffDays(first, span.end))
    const same = v.state === 'published' && startCol === endCol && span.start === span.end
      ? out.find(r => r.state === 'published' && r.startCol === startCol && r.endCol === startCol && !r.contLeft && !r.contRight) : undefined
    if (same) {
      same.versions = [...same.versions, v.version].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      same.version = same.versions[same.versions.length - 1]!
      continue
    }
    out.push({
      version: v.version, versions: [v.version], state: v.state, note: v.state === 'published' ? 'published' : v.atMs === null ? 'none' : 'expected',
      startCol, endCol, lane: 0, contLeft: span.start < first, contRight: span.end > last,
    })
  }
  out.sort((a, b) => a.startCol - b.startCol || b.endCol - a.endCol || a.version.localeCompare(b.version, undefined, { numeric: true }))
  const laneEnds: number[] = []
  for (const r of out) {
    let lane = laneEnds.findIndex(e => e < r.startCol)
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(r.endCol) } else laneEnds[lane] = r.endCol
    r.lane = lane
  }
  return out
}

export interface WeekFit {
  /** The ribbons that have a row. */
  ribbons: Ribbon[]
  /** Per column: how many due chips have a row. */
  dues: number[]
  /** Per column: how many ribbons + due chips have NO row — the number the "+N" says. */
  more: number[]
}

/**
 * Which chips of ONE month week get a row when only `cap` rows fit under the day numbers. Every chip that has no row is
 * COUNTED on each day it covers (the "+N" the day-number row shows, which costs no chip row) — nothing leaves the screen
 * without being said. A due chip is never sliced away silently.
 */
export function fitWeek(o: { ribbons: readonly Ribbon[]; dues: readonly number[]; cap: number }): WeekFit {
  const lanes = o.ribbons.reduce((m, r) => Math.max(m, r.lane + 1), 0)
  const cap = Math.max(0, o.cap)
  const ribbons = o.ribbons.filter(r => r.lane < cap)
  const hidden = o.ribbons.filter(r => r.lane >= cap)
  const dues = o.dues.map(n => Math.max(0, Math.min(n, cap - lanes)))
  const more = o.dues.map((n, i) => hidden.filter(r => r.startCol <= i && i <= r.endCol).length + (n - dues[i]!))
  return { ribbons, dues, more }
}

// ------------------------------------------------------------------------------------------ agenda (week + mobile)

export type AgendaEntry =
  | { kind: 'version'; atMs: number | null; version: CalVersion; state: 'published' | 'expected' }
  | { kind: 'resets'; atMs: number; items: { label: string; atMs: number; window: '5h' | 'week' }[] }
  | { kind: 'due'; atMs: null; mark: Extract<CalMark, { kind: 'task-due' }> }
  | { kind: 'piece'; atMs: number; piece: CalPiece; state: 'published' | 'expected' | 'started' }

/**
 * Open pieces that have a version-less place on the calendar by NOTHING but their start: no release version, no
 * publication, no estimate (a leader working alone is the common case). They are placed on the BRT day the work began,
 * never on an invented date, so a piece nobody can date ahead is still on the calendar.
 */
export function startedPiecesOfDay(day: string, pieces: readonly CalPiece[]): CalPiece[] {
  return pieces.filter(p => {
    if (p.version || p.stage === 'published' || p.publishedAtMs !== null || p.publishEta.kind === 'estimate') return false
    const at = p.startedAtMs ?? p.stageSinceMs
    return at !== null && brtDay(at) === day
  })
}

/** Open pieces are also discoverable on their expected publication day in the month grid. */
export function expectedPiecesOfDay(day: string, pieces: readonly CalPiece[]): CalPiece[] {
  return pieces.filter(p => p.stage !== 'published' && p.publishEta.kind === 'estimate' && brtDay(p.publishEta.atMs) === day).sort(byPriority)
}

/** Overdue pieces are grouped on today; their original ETA is no longer a future promise. */
export function overduePiecesOfDay(day: string, pieces: readonly CalPiece[], nowMs: number): CalPiece[] {
  return pieces.filter(p => p.stage !== 'published' && p.overdueSinceMs != null && brtDay(nowMs) === day).sort(byPriority)
}

/** What happens on one BRT day: versions shipping or shipped, pieces without a version, renewals, due days. */
export function agendaOf(day: string, o: { versions: readonly CalVersion[]; pieces: readonly CalPiece[]; marks: readonly CalMark[] }): AgendaEntry[] {
  const out: AgendaEntry[] = []
  for (const v of o.versions) if (v.atMs !== null && brtDay(v.atMs) === day) out.push({ kind: 'version', atMs: v.atMs, version: v, state: v.state === 'published' ? 'published' : 'expected' })
  for (const p of o.pieces) {
    if (p.version) continue
    const at = p.publishedAtMs ?? (p.publishEta.kind === 'estimate' ? p.publishEta.atMs : null)
    if (at !== null && brtDay(at) === day) out.push({ kind: 'piece', atMs: at, piece: p, state: p.publishedAtMs !== null ? 'published' : 'expected' })
  }
  for (const p of startedPiecesOfDay(day, o.pieces)) out.push({ kind: 'piece', atMs: (p.startedAtMs ?? p.stageSinceMs)!, piece: p, state: 'started' })
  const resets = o.marks.flatMap(m => (m.kind === 'account-reset' && brtDay(m.atMs) === day ? [{ label: m.label, atMs: m.atMs, window: m.window }] : []))
  if (resets.length) { resets.sort((a, b) => a.atMs - b.atMs); out.push({ kind: 'resets', atMs: resets[0]!.atMs, items: resets }) }
  for (const m of o.marks) if (m.kind === 'task-due' && m.day === day) out.push({ kind: 'due', atMs: null, mark: m })
  // Timed entries first, by time; the untimed (a due day) after them.
  return out.sort((a, b) => (a.atMs ?? Infinity) - (b.atMs ?? Infinity))
}

// ------------------------------------------------------------------------------------------ time axis (schedule + day)

export interface Seg { stage: CalStage | 'expected'; fromMs: number; toMs: number }

/** The real stages a piece went through, then — when it has an estimate — the rest of the way to Publicado as ONE expected span. */
export function pieceSegments(p: CalPiece, nowMs: number): Seg[] {
  const real: Seg[] = p.trail.map(v => ({ stage: v.stage, fromMs: v.enteredMs, toMs: Math.min(v.enteredMs + v.ms, p.stage === 'published' ? Infinity : nowMs) }))
  // A piece with no recorded visits but a start still shows where it is: its current stage since it began.
  const base = real.length ? real : p.startedAtMs !== null ? [{ stage: p.stage, fromMs: p.startedAtMs, toMs: p.publishedAtMs ?? nowMs } as Seg] : []
  if (p.stage !== 'published' && p.publishEta.kind === 'estimate' && p.publishEta.atMs > nowMs) base.push({ stage: 'expected', fromMs: nowMs, toMs: p.publishEta.atMs })
  return base.filter(s => s.toMs > s.fromMs)
}

/** Percent position of an instant inside [fromMs, toMs]; unclamped so a caller can tell "before" from "inside". */
export function pct(ms: number, fromMs: number, toMs: number): number { return ((ms - fromMs) / (toMs - fromMs)) * 100 }

export interface DayBlock { piece: CalPiece; stage: CalStage; fromMs: number; toMs: number; expected: boolean }

/** The blocks one piece draws on one day column: where it is now, then (dashed) the expected rest. Clipped to the day. */
export function dayBlocks(p: CalPiece, day: string, nowMs: number): DayBlock[] {
  // Core's `piecePresence` is the ONE rule (also the API's window): real activity, or start -> ETA, never "open since".
  return pieceDayPresence(p, day, nowMs).map(b => ({ piece: p, stage: p.stage, fromMs: b.fromMs, toMs: b.toMs, expected: b.expected }))
}

/** Which pieces have anything on that day — a column in the Dia view. */
export function piecesOnDay(pieces: readonly CalPiece[], day: string, nowMs: number): CalPiece[] {
  return pieces.filter(p => dayBlocks(p, day, nowMs).length > 0).sort(byPriority)
}

/** Month-cell chips for the context marks of one day. */
export function marksOfDay(day: string, marks: readonly CalMark[]): CalMark[] {
  return marks.filter(m => (m.kind === 'task-due' ? m.day === day : brtDay(m.atMs) === day))
}
