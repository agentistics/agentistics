/**
 * cronogramaTree.ts — PURE. The tree and the bars of the Cronograma (week) and of the day view: task → group → subtask,
 * drawn from what core's `CalPiece` already states. Nothing is invented:
 *  - a bar STARTS at the real start (`startedAtMs`); a piece with no start has NO bar (the view says "sem data"),
 *    never a 00:00;
 *  - it ENDS at the delivery instant when delivered, else at the ETA the calendar already computes (drawn hatched, the
 *    "previsto" part), else at now;
 *  - a task or group bar is the UNION of its children that have dates, and has none when no child does;
 *  - the percentage is on tasks and groups only: done leaves / all leaves, rounded DOWN (a bar that reads 100 % with a
 *    leaf open is the one error this figure cannot afford — the same rule as `taskProgress`).
 */
import { brtDayStartMs, pieceDayPresence, type CalPiece } from '@agentistics/core'
import { byPriority, clock, DAY_MS, stamp } from './calendarModel'

export type TreeKind = 'task' | 'group' | 'sub'

export interface TreeNode {
  /** Collapse key: `task:<id>`, `group:<taskId>/<groupId>`, or the piece key. */
  id: string
  kind: TreeKind
  title: string
  piece: CalPiece | null
  children: TreeNode[]
}

/** The interval a node draws: solid until `nowMs`, hatched after it. */
export interface Span { startMs: number; endMs: number; delivered: boolean }

export const BLIP_MS = 15 * 60_000

export const isDelivered = (p: CalPiece): boolean => p.stage === 'published' || p.publishedAtMs !== null

/** The bar of ONE piece, or null when it has no real start. */
export function pieceSpanOf(p: CalPiece, nowMs: number): Span | null {
  const start = p.startedAtMs
  if (start === null) return null
  const delivered = isDelivered(p)
  const eta = p.publishEta.kind === 'estimate' ? p.publishEta.atMs : null
  const end = delivered ? p.publishedAtMs ?? start + BLIP_MS : eta !== null && eta > nowMs ? eta : nowMs
  return { startMs: Math.min(start, end), endMs: Math.max(end, Math.min(start, end) + BLIP_MS), delivered }
}

export function leavesOf(n: TreeNode): TreeNode[] {
  return n.kind === 'sub' ? [n] : n.children.flatMap(leavesOf)
}

/** The union of the children with dates; null when none has one. */
export function spanOf(n: TreeNode, nowMs: number): Span | null {
  if (n.kind === 'sub') return n.piece ? pieceSpanOf(n.piece, nowMs) : null
  let a = Infinity, b = -Infinity, delivered = true, any = false
  for (const k of n.children) {
    const s = spanOf(k, nowMs)
    if (!s) continue
    any = true
    a = Math.min(a, s.startMs); b = Math.max(b, s.endMs); delivered = delivered && s.delivered
  }
  return any ? { startMs: a, endMs: b, delivered } : null
}

export function progressOf(n: TreeNode): { done: number; total: number; percent: number } {
  const l = leavesOf(n)
  const done = l.filter(x => x.piece && isDelivered(x.piece)).length
  return { done, total: l.length, percent: l.length ? Math.floor((100 * done) / l.length) : 0 }
}

/** task → group → subtask. A piece with no group hangs off its task; a task-level piece is its own leaf under it. */
export function buildTree(pieces: readonly CalPiece[]): TreeNode[] {
  const sorted = [...pieces].sort(byPriority)
  const tasks = new Map<string, TreeNode>()
  const groups = new Map<string, TreeNode>()
  for (const p of sorted) {
    let t = tasks.get(p.taskId)
    if (!t) { t = { id: `task:${p.taskId}`, kind: 'task', title: p.taskTitle, piece: null, children: [] }; tasks.set(p.taskId, t) }
    const leaf: TreeNode = { id: p.key, kind: 'sub', title: p.title, piece: p, children: [] }
    if (p.groupId && p.groupTitle) {
      const gk = `${p.taskId}/${p.groupId}`
      let g = groups.get(gk)
      if (!g) { g = { id: `group:${gk}`, kind: 'group', title: p.groupTitle, piece: null, children: [] }; groups.set(gk, g); t.children.push(g) }
      g.children.push(leaf)
    } else t.children.push(leaf)
  }
  return [...tasks.values()]
}

export interface TreeRow {
  node: TreeNode
  /** One entry per ancestor level: does that ancestor still have siblings below (a continuing line)? The last entry is the tee/elbow of the row itself. */
  guides: ('line' | 'none')[]
  last: boolean
}

/** The visible rows in reading order, honouring the collapsed set. */
export function flattenTree(roots: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (list: readonly TreeNode[], guides: ('line' | 'none')[]) => {
    list.forEach((node, i) => {
      const last = i === list.length - 1
      rows.push({ node, guides: guides.slice(), last })
      if (node.children.length && !collapsed.has(node.id)) walk(node.children, [...guides, last ? 'none' : 'line'])
    })
  }
  walk(roots, [])
  return rows
}

// ------------------------------------------------------------------------------------------ axes

/** What the horizontal axis is: `units` columns of `unitMs` starting at `startMs`. */
export interface Axis { mode: 'week' | 'day'; startMs: number; unitMs: number; units: number }

/** The week view's axis: two weeks, Monday of the anchor's week first (the prototype shows 14 day columns). */
export function weekAxis(mondayDay: string): Axis {
  return { mode: 'week', startMs: brtDayStartMs(mondayDay), unitMs: DAY_MS, units: 14 }
}

/** The day view's axis: hour columns from `fromHour` (7, or earlier when a bar starts earlier) to midnight. */
export function dayAxis(day: string, spans: readonly Span[], nowMs?: number): Axis {
  const d0 = brtDayStartMs(day)
  // Only a bar that BEGINS on the day can pull the scale earlier; one carried in from before is clipped at the edge.
  const earliest = spans.reduce((m, s) => (s.startMs >= d0 ? Math.min(m, s.startMs) : m), Infinity)
  const h = Number.isFinite(earliest) ? Math.floor((earliest - d0) / 3_600_000) : 7
  // On today the axis also reaches back to the hour of "now", so the day can OPEN at now (at 00h30 the axis starts at 00h, never at 07h).
  const nowH = nowMs !== undefined && nowMs >= d0 && nowMs < d0 + DAY_MS ? Math.floor((nowMs - d0) / 3_600_000) - 1 : 7
  // …and one hour BEFORE it, so the now line has room on its left instead of sitting glued to the title column.
  const from = Math.max(0, Math.min(7, h, nowH))
  return { mode: 'day', startMs: d0 + from * 3_600_000, unitMs: 3_600_000, units: 24 - from }
}

/** The instant the Day view opens at: "now" on today; on any other day the first activity that begins on it (else the axis start). */
export function dayFocusMs(day: string, spans: readonly Span[], nowMs: number, axisStartMs: number): number {
  const d0 = brtDayStartMs(day)
  if (nowMs >= d0 && nowMs < d0 + DAY_MS) return nowMs
  const first = spans.reduce((m, s) => (s.startMs >= d0 && s.startMs < d0 + DAY_MS ? Math.min(m, s.startMs) : m), Infinity)
  return Number.isFinite(first) ? first : axisStartMs
}

/** Position of an instant in column units (fractional), unclamped. */
export const unitsAt = (a: Axis, ms: number): number => (ms - a.startMs) / a.unitMs

/** The span clipped to the axis, in units; null when it falls outside. */
export function clipToAxis(a: Axis, s: Span): { from: number; to: number; clippedLeft: boolean; clippedRight: boolean } | null {
  const f = unitsAt(a, s.startMs), t = unitsAt(a, s.endMs)
  if (t <= 0 || f >= a.units) return null
  return { from: Math.max(0, f), to: Math.min(a.units, t), clippedLeft: f < 0, clippedRight: t > a.units }
}

/**
 * Where the solid (done) part ends and the hatched (expected) part starts, as a % of the bar AS DRAWN — i.e. of the span
 * clipped to the axis. Computed in axis units, never over the whole span: a bar that started days ago and is clipped at
 * the left would otherwise paint a boundary that sits nowhere near "now". `expectedPct` is 0 when nothing is forecast.
 */
/** The sticky chip/checkbox/hint/% stack may overflow its bar's right end, but ONLY while the bar is visible: once less than this many px of it remain right of the title column the stack is hidden with it. */
export const OVERLAY_EDGE = 10
export const overlayGone = (barRight: number, titleColRight: number): boolean => barRight < titleColRight + OVERLAY_EDGE

export const MIN_BAR_UNITS = 0.35

export function fillSplit(a: Axis, s: Span, nowMs: number, forecast: boolean): { solidPct: number; expectedPct: number } {
  const c = clipToAxis(a, s)
  if (!c || c.to <= c.from) return { solidPct: s.delivered ? 100 : 0, expectedPct: 0 }
  // The bar is drawn at least MIN_BAR_UNITS wide (a blip), so the boundary is measured against the DRAWN width.
  const w = Math.max(MIN_BAR_UNITS, c.to - c.from)
  const solid = s.delivered ? 100 : Math.max(0, Math.min(1, (unitsAt(a, Math.min(nowMs, s.endMs)) - c.from) / w)) * 100
  return { solidPct: solid, expectedPct: forecast ? 100 - solid : 0 }
}

/** Does the piece have anything on this BRT day? (bar touching it) */
export function spanTouchesDay(s: Span, day: string): boolean {
  const d0 = brtDayStartMs(day)
  return s.endMs > d0 && s.startMs < d0 + DAY_MS
}

/** An open piece with no real start: no bar, only the "sem data" chip. */
export const isUndated = (p: CalPiece): boolean => p.startedAtMs === null && !isDelivered(p)

/**
 * The pieces the DAY view lists: the ones with ACTIVITY on the day — core's `pieceDayPresence`, the same rule as the API's date
 * window and the phone — plus the undated open ones on today only (their "sem horário" chip). A piece merely open since
 * last month, with nothing done on the day, is left out (see `dayLeftOut`).
 */
export function dayPieces(pieces: readonly CalPiece[], day: string, nowMs: number, today: string): CalPiece[] {
  return pieces.filter(p => pieceDayPresence(p, day, nowMs).length > 0 || (day === today && isUndated(p)))
}

/** How many of the given pieces the Day view leaves out for having no activity on the day (the footer says so). */
export const dayLeftOut = (pieces: readonly CalPiece[], day: string, nowMs: number, today: string): number =>
  pieces.length - dayPieces(pieces, day, nowMs, today).length

/** The pieces the WEEK view lists: a bar touching the window, plus every undated open one (chip on today's column). */
export function weekPieces(pieces: readonly CalPiece[], axis: Axis, nowMs: number): CalPiece[] {
  const end = axis.startMs + axis.units * axis.unitMs
  return pieces.filter(p => {
    const s = pieceSpanOf(p, nowMs)
    return s ? s.endMs > axis.startMs && s.startMs < end : isUndated(p)
  })
}

export interface HintWords { since: string; continues: string; now: string }

/**
 * What a bar says on the DAY view, as ONE string (the bar's visible text AND its aria-label): where it really started —
 * `since <day> · hh` when that was another day, never the clipped 00h00 — and where it ends, `→ continues` when it runs past
 * the day's end. `endWord: 'now'` is a bar still going with nothing forecast.
 */
export function dayHint(s: Span, day: string, endWord: 'clock' | 'now', words: HintWords, pt: boolean): string {
  const d0 = brtDayStartMs(day)
  const from = s.startMs >= d0 ? clock(s.startMs) : `${words.since} ${stamp(s.startMs, pt)}`
  const to = s.endMs > d0 + DAY_MS ? words.continues : endWord === 'now' ? words.now : clock(s.endMs)
  return s.endMs > d0 + DAY_MS ? `${from} ${to}` : `${from} – ${to}`
}
