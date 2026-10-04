/**
 * code-panels.ts — the swapping panel's two other sides, PURE: the INSPECTOR (CD-13, the selected
 * turn in detail) and the TIMELINE (CD-14, where the run spent its time and money).
 *
 * Spec: docs/superpowers/specs/2026-09-28-harness-tui-design.md (D-TUI-2, D-TUI-8, CD-13, CD-14).
 * Prototype: `harness-tui-unified.html` (`sideInspector`, `sideTimeline`, `sidePanel`).
 *
 * Both read the turn fold `code.ts` keeps (`CodeView.turnStats`, one per person's message) and the
 * tool calls it holds, and both follow D-TUI-8 to the letter: a figure the source did not report
 * reads N/A, never a confident 0 — a missing timestamp draws no bar rather than a bar at the origin,
 * an unpriced call makes the total N/A rather than a smaller total, and a call the policy recorded
 * nothing about says so in words. The clock is passed in (`now`), never read.
 */

import { fmt, fmtCost } from '@agentistics/core'
import { COLORS } from '../theme'
import {
  EMPTY_USAGE,
  cacheHit,
  cellWidth,
  contextGaugeLine,
  fitLine,
  fmtMs,
  kv,
  lineWidth,
  lr,
  segmentToolIds,
  seg,
  spanMs,
  tokenTotal,
  turnCost,
  turnSegments,
  truncateCells,
  wrapText,
  type CodeView,
  type Line,
  type Seg,
  type TurnStat,
} from './code'
import type { CodeStrings } from './code-i18n'
import type { CodeSessionFacts, CodeToolCall, CodeUsage } from './code-types'

const blank = (): Line => []
const muted = (text: string): Seg => seg(text, { color: COLORS.muted })
const head = (label: string, right: Line, w: number): Line => lr([seg(label, { color: COLORS.label, bold: true })], right, w)

/** The tool calls of turn `k`, in the order they appear. */
export function turnTools(view: CodeView, k: number): CodeToolCall[] {
  const sg = turnSegments(view.entries).find(s => s.turn === k)
  if (!sg) return []
  return segmentToolIds(view, sg).map(id => view.tools[id]).filter((c): c is CodeToolCall => c !== undefined)
}

/** The turn a panel shows: the one picked, clamped, else the last; null when nobody has spoken. */
export function resolveTurn(view: CodeView, picked: number | null): number | null {
  const n = view.turnStats.length
  if (n === 0) return null
  if (picked === null) return n - 1
  return Math.min(Math.max(0, picked), n - 1)
}

/** `HH:MM:SS` on the local clock, or null for an instant that does not parse. */
function clock(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toTimeString().slice(0, 8)
}

/** A sum over every call, or undefined (N/A) unless EVERY call reported that field. */
function sumAll(calls: readonly CodeUsage[], pick: (u: CodeUsage) => number | undefined): number | undefined {
  if (calls.length === 0) return undefined
  let total = 0
  for (const c of calls) {
    const v = pick(c)
    if (v === undefined) return undefined
    total += v
  }
  return total
}

/** A turn's duration: ended − started, or — for a turn still running — now − started, marked live. */
function turnDuration(st: TurnStat, live: boolean, now: number, t: CodeStrings): string {
  if (st.startedAt && st.endedAt) {
    const ms = spanMs(st.startedAt, st.endedAt)
    return ms === null ? t.na : fmtMs(ms)
  }
  const start = st.startedAt ? Date.parse(st.startedAt) : Number.NaN
  if (live && Number.isFinite(start) && now >= start) return `${fmtMs(now - start)} (${t.inspLive})`
  return t.na
}

/** What happened to a call, for the inspector's TOOLS rows — in words, never a bare glyph. */
function outcome(call: CodeToolCall, t: CodeStrings): Seg[] {
  switch (call.state) {
    case 'asking': return [seg(t.outcomeWaiting, { color: COLORS.accent })]
    case 'running': return [seg(t.toolRunning, { color: COLORS.info })]
    case 'failed': return [seg(t.toolFailed, { color: COLORS.danger })]
    case 'denied': return [seg(t.toolDenied, { color: COLORS.danger })]
    case 'done': {
      let added = 0
      let removed = 0
      for (const f of call.diff?.files ?? []) { added += f.added; removed += f.removed }
      if (call.diff && call.diff.files.length > 0) return [seg(`+${added}`, { color: COLORS.success }), seg(`−${removed}`, { color: COLORS.danger })]
      return [seg(call.result ? call.result : t.outcomeOk, { color: COLORS.success })]
    }
  }
}

/**
 * CD-13: the policy's decision on one call, in words. Three shapes — `allowed · <rule>`,
 * `asked → you: <choice>`, `denied by <who> (<code>)` — plus the two honest absences: a question
 * still open, and a call the host recorded no decision for.
 */
export function policyWords(call: CodeToolCall, choice: string | undefined, t: CodeStrings): Seg {
  const p = call.policy
  if (!p) {
    if (call.state === 'asking') return seg(t.polWaiting, { color: COLORS.accent })
    return seg(t.polNone, { color: COLORS.muted })
  }
  if (p.decision === 'denied') return seg(t.polDenied(p.by === 'user' ? t.byYou : t.byPolicy, p.code), { color: COLORS.danger })
  if (p.asked) return seg(t.polAsked(choice), { color: COLORS.accent })
  return seg(t.polAllowed(p.rule), { color: COLORS.success })
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CD-13: the inspector
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The selected turn in detail: when and how long, the model and why it stopped, time to first token
 * and the output rate, the FOUR counters with each one's own cost, the context after the turn, every
 * tool it ran, and what the policy decided about each.
 */
export function inspectorLines(
  view: CodeView,
  picked: number | null,
  facts: CodeSessionFacts | null,
  t: CodeStrings,
  width: number,
  now: number,
): Line[] {
  const w = Math.max(0, width)
  const k = resolveTurn(view, picked)
  if (k === null) return wrapText(t.inspectorEmpty, w).map(l => [muted(l)])
  const st = view.turnStats[k]!
  const L: Line[] = []
  if (view.turnStats.length > 1) L.push(fitLine([muted(t.inspectorPick)], w))
  const live = view.runId !== null && st.runIds.includes(view.runId)
  const when = clock(st.at)
  L.push(...kv(
    [seg(t.inspTurn(k + 1), { color: COLORS.text, bold: true }), ...(when ? [muted(` · ${when}`)] : [])],
    [seg(turnDuration(st, live, now, t), { color: COLORS.text })],
    w,
  ))
  const tools = turnTools(view, k)
  if (st.historic) {
    L.push(...wrapText(t.inspHistoric, w).map(l => [muted(l)]))
    if (tools.length > 0) {
      L.push(blank(), fitLine([seg(t.toolsInTurn, { color: COLORS.label, bold: true })], w))
      for (const c of tools) L.push(fitLine([seg(c.verb.padEnd(7), { color: COLORS.label }), seg(c.target, { color: COLORS.text })], w))
    }
    return L.map(l => fitLine(l, w))
  }

  const calls = st.calls
  const lastCall = calls[calls.length - 1]
  const model = lastCall?.model || facts?.model || view.model
  L.push(...kv([muted(t.inspModel)], [seg(model || t.na, { color: model ? COLORS.text : COLORS.muted })], w))
  L.push(...kv([muted(t.inspStop)], [seg(lastCall?.stopReason ?? t.na, { color: lastCall?.stopReason ? COLORS.text : COLORS.muted })], w))
  // ttft is the FIRST response's; the rate is that response's output over the time it spent
  // producing it — from its first token to its end. Either half missing is N/A, never a guess.
  const first = calls[0]
  const ttft = first?.ttftMs
  let rate: string = t.na
  if (first && ttft !== undefined && first.output !== undefined) {
    const span = spanMs(first.startedAt, first.endedAt)
    const gen = span === null ? null : span - ttft
    if (gen !== null && gen > 0) rate = t.tokPerSec(Math.round(first.output / (gen / 1000)))
  }
  L.push(...kv([muted(t.inspTtftRate)], [seg(`${ttft === undefined ? t.na : fmtMs(ttft)} · ${rate}`, { color: COLORS.text })], w))
  L.push(blank())

  // REQUEST — each counter, and what it cost at its own rate. A counter or a cost is N/A unless
  // every response of the turn reported it: a sum over some of them would read as the whole.
  L.push(head(t.request, [muted(t.tokensCost)], w))
  const rows: Array<[string, number | undefined, number | undefined]> = [
    [t.reqInput, sumAll(calls, c => c.input), sumAll(calls, c => c.costs?.input)],
    [t.reqCacheRead, sumAll(calls, c => c.cacheRead), sumAll(calls, c => c.costs?.cacheRead)],
    [t.reqCacheWrite, sumAll(calls, c => c.cacheWrite), sumAll(calls, c => c.costs?.cacheWrite)],
    [t.reqOutput, sumAll(calls, c => c.output), sumAll(calls, c => c.costs?.output)],
  ]
  const labelW = Math.max(...rows.map(r => cellWidth(r[0]))) + 1
  for (const [label, count, cost] of rows) {
    L.push(lr(
      [muted(label.padEnd(labelW)), seg(count === undefined ? t.na : fmt(count), { color: count === undefined ? COLORS.muted : COLORS.text })],
      [seg(cost === undefined ? t.na : fmtCost(cost), { color: cost === undefined ? COLORS.muted : COLORS.text })],
      w,
    ))
  }
  const total = tokenTotal(st.usage)
  const cost = turnCost(st)
  L.push(lr(
    [seg(t.total.padEnd(labelW), { color: COLORS.text, bold: true }), seg(total === null ? t.na : fmt(total), { color: total === null ? COLORS.muted : COLORS.text })],
    [seg(cost === null ? t.na : fmtCost(cost), { color: cost === null ? COLORS.muted : COLORS.text, bold: true })],
    w,
  ))
  L.push(blank())

  // CONTEXT AFTER — the last reading the turn produced: a GAUGE, not a sum.
  const reading = [...calls].reverse().find(c => c.contextTokens !== undefined)
  const ctx = reading ? { tokens: reading.contextTokens!, ...(reading.contextWindow !== undefined ? { window: reading.contextWindow } : {}) } : null
  L.push(head(t.contextAfter, ctx?.window !== undefined ? [muted(t.window(fmt(ctx.window)))] : [], w))
  L.push(contextGaugeLine(ctx, t, w))
  L.push(blank())

  // TOOLS IN THIS TURN and the POLICY on each.
  L.push(fitLine([seg(t.toolsInTurn, { color: COLORS.label, bold: true })], w))
  if (tools.length === 0) L.push(fitLine([muted(t.noTools)], w))
  for (const c of tools) {
    const right: Line = []
    if (c.durationMs !== undefined) right.push(muted(`${fmtMs(c.durationMs)} `))
    right.push(...outcome(c, t))
    // One row per call: the target gives way first (`lr`), the latency and the outcome never.
    L.push(lr([seg(c.verb.padEnd(7), { color: COLORS.label }), seg(c.target, { color: COLORS.text })], right, w))
  }
  if (tools.length > 0) {
    L.push(blank())
    L.push(fitLine([seg(t.policy, { color: COLORS.label, bold: true })], w))
    for (const c of tools) {
      const target = truncateCells(c.target, Math.max(0, Math.floor(w / 3)))
      L.push(...kv([seg(c.verb, { color: COLORS.label }), ...(target ? [muted(` ${target}`)] : [])], [policyWords(c, view.choices[c.id], t)], w))
    }
  }
  return L.map(l => fitLine(l, w))
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CD-14: the timeline
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type TimelineKind = 'model' | 'tool' | 'you'

export interface TimelineRow {
  kind: TimelineKind
  label: string
  /** Epoch ms; both absent when the source gave no timestamps — the row then says N/A. */
  start?: number
  end?: number
  /** Still going: its end is `now`. */
  open?: boolean
}

const ms = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined
  const v = Date.parse(iso)
  return Number.isFinite(v) ? v : undefined
}

/**
 * The rows of a turn's run: one per model call (invoke → completion), one per tool's EXECUTION
 * (`endedAt − durationMs → endedAt`, or `requestedAt → endedAt` when the host measured no duration),
 * and one per stretch a person was waited on (`waited`, open until answered). A tool that never ran
 * — still waiting, or denied without executing — has no execution row; its wait row is the story.
 */
export function timelineRows(view: CodeView, k: number, t: CodeStrings, now: number): TimelineRow[] {
  const st = view.turnStats[k]
  if (!st) return []
  const rows: TimelineRow[] = []
  st.calls.forEach((c, i) => {
    const start = ms(c.startedAt)
    const end = ms(c.endedAt)
    rows.push({ kind: 'model', label: t.modelN(i + 1), ...(start !== undefined && end !== undefined && end >= start ? { start, end } : {}) })
  })
  for (const c of turnTools(view, k)) {
    if (c.waited) {
      const start = ms(c.waited.openedAt)
      const closed = ms(c.waited.closedAt)
      const open = c.waited.closedAt === undefined
      const end = open ? now : closed
      rows.push({ kind: 'you', label: `${t.youRow} · ${c.verb}`, ...(start !== undefined && end !== undefined && end >= start ? { start, end } : {}), ...(open ? { open } : {}) })
    }
    if (c.state === 'asking') continue
    if (c.state === 'denied' && c.durationMs === undefined) continue
    const end = ms(c.endedAt)
    if (c.state === 'running') {
      const start = ms(c.requestedAt)
      rows.push({ kind: 'tool', label: c.verb, ...(start !== undefined && now >= start ? { start, end: now, open: true } : {}) })
      continue
    }
    let start: number | undefined
    if (end !== undefined && c.durationMs !== undefined) start = end - c.durationMs
    else start = ms(c.requestedAt)
    rows.push({ kind: 'tool', label: c.verb, ...(start !== undefined && end !== undefined && end >= start ? { start, end } : {}) })
  }
  // Timed rows in the order they happened; the rows with nothing to place stay last, still named.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.start ?? Number.POSITIVE_INFINITY) - (b.r.start ?? Number.POSITIVE_INFINITY) || a.i - b.i)
    .map(x => x.r)
}

const KIND_COLOR: Record<TimelineKind, string> = { model: COLORS.secondary, tool: COLORS.info, you: COLORS.accent }
const KIND_GLYPH: Record<TimelineKind, string> = { model: '█', tool: '█', you: '░' }

/** Where the run spent its time: a total per kind, N/A when any row of that kind has no span. */
export function timeTotals(rows: readonly TimelineRow[]): Record<TimelineKind, number | null> {
  const out: Record<TimelineKind, number | null> = { model: 0, tool: 0, you: 0 }
  for (const r of rows) {
    if (out[r.kind] === null) continue
    out[r.kind] = r.start === undefined || r.end === undefined ? null : out[r.kind]! + (r.end - r.start)
  }
  return out
}

/** Label column and duration column widths of a timeline row. */
const TL_LABEL = 12
const TL_META = 7
/** Narrower than this and a bar says nothing: the rows lose their bars and keep their durations. */
const TL_MIN_BAR = 6

/**
 * CD-14: the run as bars on one time axis — model calls, tool executions, and the stretches spent
 * waiting on YOU — then where the time went and what the run cost. `now` closes whatever is still
 * open, so a live run grows as the screen repaints.
 */
export function timelineLines(view: CodeView, picked: number | null, t: CodeStrings, width: number, now: number): Line[] {
  const w = Math.max(0, width)
  const k = resolveTurn(view, picked)
  if (k === null) return wrapText(t.timelineEmpty, w).map(l => [muted(l)])
  const st = view.turnStats[k]!
  const live = view.runId !== null && st.runIds.includes(view.runId)
  const L: Line[] = []
  if (st.runIds.length === 0 && st.calls.length === 0) {
    L.push(fitLine([seg(t.runN(k + 1), { color: COLORS.text, bold: true })], w))
    L.push(...wrapText(t.timelineNoRun, w).map(l => [muted(l)]))
    return L
  }
  const rows = timelineRows(view, k, t, now)
  const timed = rows.filter(r => r.start !== undefined && r.end !== undefined)
  const runStart = ms(st.startedAt) ?? (timed.length ? Math.min(...timed.map(r => r.start!)) : undefined)
  const runEnd = ms(st.endedAt) ?? (live ? now : timed.length ? Math.max(...timed.map(r => r.end!)) : undefined)
  const span = runStart !== undefined && runEnd !== undefined && runEnd > runStart ? runEnd - runStart : null

  L.push(...kv(
    [seg(t.runN(k + 1), { color: COLORS.text, bold: true })],
    live
      ? [seg(`● ${t.inspLive}`, { color: COLORS.running })]
      : [muted(`${span === null ? t.na : fmtMs(span)} · ${st.status === 'completed' || !st.status ? t.runEnded : st.status}`)],
    w,
  ))

  const bar = w - TL_LABEL - 1 - TL_META
  const bars = bar >= TL_MIN_BAR && span !== null
  if (bars) {
    const endLabel = fmtMs(span)
    const axis = '0s'.padEnd(Math.max(0, bar - endLabel.length)) + endLabel
    L.push(fitLine([seg(' '.repeat(TL_LABEL + 1)), muted(axis.slice(0, bar))], w))
  }
  for (const r of rows) {
    const label = seg(truncateCells(r.label, TL_LABEL - 1).padEnd(TL_LABEL), { color: KIND_COLOR[r.kind] })
    const hasSpan = r.start !== undefined && r.end !== undefined
    const meta = hasSpan ? `${fmtMs(r.end! - r.start!)}${r.open ? '▸' : ''}` : t.na
    const metaSeg = seg(` ${meta}`, { color: hasSpan ? COLORS.muted : COLORS.muted })
    if (!bars || !hasSpan) {
      // No bar: a missing timestamp is said, never drawn as a bar at the origin.
      L.push(fitLine([label, ...(bars ? [seg(' '.repeat(bar))] : []), metaSeg], w))
      continue
    }
    const x0 = Math.min(bar - 1, Math.max(0, Math.floor(((r.start! - runStart!) / span!) * bar)))
    const x1 = Math.min(bar, Math.max(x0 + 1, Math.round(((r.end! - runStart!) / span!) * bar)))
    const line: Line = [label, seg(' ')]
    if (x0 > 0) line.push(seg('·'.repeat(x0), { color: COLORS.border }))
    line.push(seg(KIND_GLYPH[r.kind].repeat(x1 - x0), { color: KIND_COLOR[r.kind] }))
    if (bar - x1 > 0) line.push(seg('·'.repeat(bar - x1), { color: COLORS.border }))
    line.push(metaSeg)
    L.push(fitLine(line, w))
  }
  L.push(blank())
  const legend: Line = [
    seg('█', { color: KIND_COLOR.model }), muted(` ${t.legendModel}  `),
    seg('█', { color: KIND_COLOR.tool }), muted(` ${t.legendTool}  `),
    seg('░', { color: KIND_COLOR.you }), muted(` ${t.legendYou}`),
  ]
  L.push(fitLine(legend, w))
  L.push(blank())

  // WHERE THE TIME WENT — each total and its share of the run. N/A when a row of that kind has no
  // timestamps (a partial sum reads as the whole) or when the run's own span is unknown.
  const totals = timeTotals(rows)
  L.push(fitLine([seg(t.whereTime, { color: COLORS.label, bold: true })], w))
  const share = (v: number | null): Line => {
    if (v === null) return [muted(t.na)]
    const pct = span === null ? t.na : `${Math.floor((v / span) * 100)}%`
    return [seg(fmtMs(v), { color: COLORS.text }), muted(` ${pct}`)]
  }
  L.push(...kv([seg(t.timeModel, { color: COLORS.text })], share(totals.model), w))
  L.push(...kv([seg(t.timeTools, { color: COLORS.text })], share(totals.tool), w))
  L.push(...kv([seg(t.timeWaiting, { color: COLORS.accent })], share(totals.you), w))
  L.push(blank())

  // MONEY — this run, api-equivalent; N/A when any response of it was unpriced.
  const cost = turnCost(st)
  const hit = cacheHit(st.usage ?? EMPTY_USAGE)
  L.push(head(t.money, [muted(t.apiEquivalent)], w))
  L.push(...kv([seg(t.thisRun, { color: COLORS.text })], [seg(cost === null ? t.na : fmtCost(cost), { color: cost === null ? COLORS.muted : COLORS.text })], w))
  L.push(...kv([seg(t.modelCalls, { color: COLORS.text })], [seg(String(st.calls.length), { color: COLORS.text })], w))
  L.push(...kv([seg(t.cacheHit, { color: COLORS.text })], [seg(hit === null ? t.na : `${Math.floor(hit * 100)}%`, { color: hit === null ? COLORS.muted : COLORS.success })], w))
  return L.map(l => (lineWidth(l) > w ? fitLine(l, w) : l))
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// the panel's own scroll
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The first line a panel of `rows` may start at, clamped. */
export function clampPanelTop(total: number, rows: number, top: number): number {
  return Math.min(Math.max(0, top), Math.max(0, total - rows))
}

/**
 * Exactly `rows` of a panel's lines from `top`, with what is cut SAID: a row above the window names
 * how many lines are above it and the key that shows them, a row at the bottom the same for below.
 * The inspector of a turn with a dozen tools is taller than a 24-row terminal, and a panel that
 * stops at CONTEXT AFTER with no word of the POLICY under it reads as a turn that had none.
 */
export function panelWindow(lines: readonly Line[], rows: number, top: number, t: CodeStrings, width: number, full: boolean): Line[] {
  if (rows <= 0) return []
  if (lines.length <= rows) return [...lines]
  const start = clampPanelTop(lines.length, rows, top)
  const shown = lines.slice(start, start + rows)
  if (rows < 3) return shown
  if (start > 0) shown[0] = fitLine([muted(t.panelAbove(start + 1))], width)
  const hiddenBelow = lines.length - (start + rows)
  if (hiddenBelow > 0) shown[rows - 1] = fitLine([muted(t.panelBelow(hiddenBelow + 1, full))], width)
  return shown
}
