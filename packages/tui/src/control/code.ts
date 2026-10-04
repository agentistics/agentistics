/**
 * code.ts — the `code` tab's arithmetic, PURE: the conversation fold, the layout, and every line the
 * screen draws. No React, no IO, no clock except values passed in.
 *
 * Spec: docs/superpowers/specs/2026-09-28-harness-tui-design.md (CD-01…04, CD-07, CD-09, CD-11,
 * CD-12 P1, GL-05). Prototype: `harness-tui-unified.html` (`turn7`, `permCard`, `composer`,
 * `sideSession`, `scrCode`, `ovDiff`).
 *
 * The split is the one the rest of this package keeps: `tabs/Code.tsx` holds React state and calls
 * the host, and everything that can be WRONG about a frame — a row one cell too wide, a counter
 * printed as `0` that nobody reported, the footer naming a key that does nothing, the no-sandbox
 * warning dropped on a narrow terminal — is decided here, where a test can hold it to account.
 *
 * Lines are built as styled SEGMENTS rather than strings because a row here carries several colours
 * (a glyph, a verb, a target, a right-aligned result; a diff line's background) and a string would
 * have to be re-parsed to draw them. Every builder FITS what it returns: `lineWidth(line) <= width`
 * for every line, which `code.test.ts` asserts over every builder at several widths.
 */

import { fmt, fmtCost, readTokens, totalTokens } from '@agentistics/core'
import { COLORS } from '../theme'
import type {
  CodeAsk,
  CodeDiff,
  CodeDiffFile,
  CodeEvent,
  CodeHistoryTurn,
  CodePlanItem,
  CodeSessionFacts,
  CodeToolCall,
  CodeUsage,
} from './code-types'
import type { CodeStrings } from './code-i18n'

// ═════════════════════════════════════════════════════════════════════════════════════════════
// text measurement
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Terminal cells one code point occupies: 0 for combining marks and joiners, 2 for East Asian wide
 * characters and emoji, 1 otherwise.
 *
 * The rest of this package measures with `.length`, which is right for the ASCII and box-drawing it
 * prints — but this tab prints what a MODEL wrote, and a model writes CJK and emoji. Counted as one
 * cell each, a row of them is drawn twice as wide as it was measured, wraps, and shears every row
 * under it: exactly the failure the "no row may exceed its width" rule exists to prevent. There is no
 * `string-width` dependency to lean on (and adding one means touching the lockfile), so this is the
 * small table that covers the ranges a conversation actually contains.
 */
function codePointCells(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1faff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}

export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) n += codePointCells(ch.codePointAt(0) ?? 0)
  return n
}

/** The longest prefix of `s` that fits `cells`, never splitting a wide character across the edge. */
export function sliceCells(s: string, cells: number): string {
  if (cells <= 0) return ''
  let n = 0
  let out = ''
  for (const ch of s) {
    const w = codePointCells(ch.codePointAt(0) ?? 0)
    if (n + w > cells) break
    out += ch
    n += w
  }
  return out
}

/** Cut to `cells` with an ellipsis when it had to cut. */
export function truncateCells(s: string, cells: number): string {
  if (cells <= 0) return ''
  if (cellWidth(s) <= cells) return s
  if (cells === 1) return '…'
  return sliceCells(s, cells - 1) + '…'
}

/**
 * What a model or a tool wrote, made safe to put in a cell: tabs become spaces and every other
 * control character — an ANSI escape, a carriage return, a bell — is dropped. One stray `\r` in a
 * streamed answer moves the terminal's cursor to column 0 and the rest of the row overwrites the
 * frame's own border.
 */
export function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\t/g, '    ').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

/**
 * Word-wrap to `width` cells. Paragraph breaks survive as their own (empty) lines, and a word longer
 * than the row is hard-broken rather than overflowing it.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return []
  const out: string[] = []
  for (const para of sanitize(text).split('\n')) {
    let cur = ''
    for (const word of para.split(' ')) {
      let w = word
      if (cur === '' && w === '') continue
      while (cellWidth(w) > width) {
        const room = cur ? width - cellWidth(cur) - 1 : width
        if (room <= 0) { out.push(cur); cur = ''; continue }
        const head = sliceCells(w, room)
        out.push(cur ? `${cur} ${head}` : head)
        cur = ''
        w = w.slice(head.length)
      }
      if (!w) continue
      if (!cur) cur = w
      else if (cellWidth(cur) + 1 + cellWidth(w) <= width) cur += ` ${w}`
      else { out.push(cur); cur = w }
    }
    out.push(cur)
  }
  return out
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// segments
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface Seg {
  text: string
  color?: string
  bg?: string
  bold?: boolean
  dim?: boolean
}

export type Line = Seg[]

/** Colours this tab needs beyond the shared palette: the two diff backgrounds. Dark on purpose —
 *  the foreground text over them has to stay readable in a dark terminal. */
export const DIFF_ADD_BG = '#12351f'
export const DIFF_DEL_BG = '#3d1320'

export const seg = (text: string, style: Omit<Seg, 'text'> = {}): Seg => ({ text, ...style })

export function lineWidth(line: Line): number {
  let n = 0
  for (const s of line) n += cellWidth(s.text)
  return n
}

export function lineText(line: Line): string {
  return line.map(s => s.text).join('')
}

/**
 * Cut a line to `width` cells, with an ellipsis in the style of the segment it cut. `fillBg` pads the
 * remainder with that background — a diff line whose colour stopped where its text did reads as a
 * highlighted word, not a changed line.
 */
export function fitLine(line: Line, width: number, fillBg?: string): Line {
  if (width <= 0) return []
  const out: Line = []
  let used = 0
  const total = lineWidth(line)
  for (const s of line) {
    const w = cellWidth(s.text)
    if (total <= width) { out.push(s); used += w; continue }
    if (used + w <= width - 1) { out.push(s); used += w; continue }
    const room = width - used
    if (room > 0) out.push({ ...s, text: sliceCells(s.text, room - 1) + '…' })
    used = width
    break
  }
  if (fillBg && used < width) {
    const got = lineWidth(out)
    if (got < width) out.push({ text: ' '.repeat(width - got), bg: fillBg })
  }
  return out
}

/**
 * `left` flush left and `right` flush right in `width` cells. The LEFT side gives way first — the
 * right is a result, a count or a state, and `✓ patch core/src/tok… +3 −1` still answers what
 * happened while `✓ patch core/src/tokens.ts +…` does not.
 */
export function lr(left: Line, right: Line, width: number, minGap = 1): Line {
  const rw = lineWidth(right)
  if (rw === 0) return fitLine(left, width)
  if (rw + minGap >= width) return fitLine(right, width)
  const room = width - rw - minGap
  const l = fitLine(left, room)
  const gap = width - lineWidth(l) - rw
  return [...l, seg(' '.repeat(Math.max(minGap, gap))), ...right]
}

const blank = (): Line => []

// ═════════════════════════════════════════════════════════════════════════════════════════════
// the conversation, folded
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** A piece of an assistant turn: text as it streamed, or a tool call (by id — the call lives in
 *  `CodeView.tools` so an upsert updates it where it already sits). */
export type TurnPart = { kind: 'text'; text: string } | { kind: 'tool'; id: string }

export type ConversationEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; runId?: string; parts: TurnPart[] }
  | { kind: 'note'; tone: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'answer'; outcome: 'answered' | 'cancelled' | 'timeout'; label?: string }

/**
 * Four counters, cost, and how many calls reported no price. Each counter is ABSENT until a call
 * reported it — `HARNESS_CAPABILITIES`' rule applied to one session: a counter the source never
 * produced renders N/A, and a confident `0` beside it would be a claim nobody measured.
 */
export interface UsageTotals {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  costUSD?: number
  calls: number
  unpriced: number
}

export const EMPTY_USAGE: UsageTotals = { calls: 0, unpriced: 0 }

export interface FileTouch {
  path: string
  /** Absent when the call changed the file without saying by how much. */
  added?: number
  removed?: number
}

export interface CodeView {
  entries: ConversationEntry[]
  tools: Record<string, CodeToolCall>
  ask: CodeAsk | null
  /** The run in progress, or `null` between runs. */
  runId: string | null
  /** The current run's usage (reset when a run starts) — the panel's "this turn". */
  run: UsageTotals
  session: UsageTotals
  /** The latest context reading — a GAUGE, reassigned per call, never summed. */
  context: { tokens: number; window?: number } | null
  model?: string
  files: FileTouch[]
  /** Tool ids whose change has already been counted into `files`, so an upsert is not counted twice. */
  counted: Record<string, true>
  plan: CodePlanItem[] | null
  /** How many times the person spoke — the panel's turn number. */
  turns: number
  closed: string | null
}

export const EMPTY_VIEW: CodeView = {
  entries: [],
  tools: {},
  ask: null,
  runId: null,
  run: EMPTY_USAGE,
  session: EMPTY_USAGE,
  context: null,
  files: [],
  counted: {},
  plan: null,
  turns: 0,
  closed: null,
}

/** Add an optional counter: absent + absent stays absent, anything + a reading is a reading. */
function addOpt(a: number | undefined, b: number | undefined): number | undefined {
  if (b === undefined) return a
  return (a ?? 0) + b
}

export function addUsage(t: UsageTotals, u: CodeUsage): UsageTotals {
  return {
    input: addOpt(t.input, u.input),
    output: addOpt(t.output, u.output),
    cacheRead: addOpt(t.cacheRead, u.cacheRead),
    cacheWrite: addOpt(t.cacheWrite, u.cacheWrite),
    costUSD: addOpt(t.costUSD, u.costUSD),
    calls: t.calls + 1,
    unpriced: t.unpriced + (u.costUSD === undefined ? 1 : 0),
  }
}

/**
 * The index of the assistant entry a streamed piece belongs to, or -1 when a new one must open.
 *
 * It is the LAST entry when that entry is an assistant turn of the same run. A user message, a note
 * or a different run in between means the piece starts a new answer — appending across a user turn
 * would put the model's reply above the question it answers.
 */
function currentAssistant(entries: readonly ConversationEntry[], runId: string | undefined): number {
  const i = entries.length - 1
  const last = entries[i]
  if (!last || last.kind !== 'assistant') return -1
  if (runId !== undefined && last.runId !== undefined && last.runId !== runId) return -1
  return i
}

function withAssistant(
  entries: ConversationEntry[],
  runId: string | undefined,
  edit: (parts: TurnPart[]) => TurnPart[],
): ConversationEntry[] {
  const i = currentAssistant(entries, runId)
  if (i === -1) return [...entries, { kind: 'assistant', ...(runId ? { runId } : {}), parts: edit([]) }]
  const cur = entries[i] as Extract<ConversationEntry, { kind: 'assistant' }>
  const next = [...entries]
  next[i] = { ...cur, ...(runId && !cur.runId ? { runId } : {}), parts: edit(cur.parts) }
  return next
}

/** Merge a finished call's change into the files list, once per call id. */
function countFiles(view: CodeView, call: CodeToolCall): Pick<CodeView, 'files' | 'counted'> {
  if (call.state !== 'done' || view.counted[call.id]) return { files: view.files, counted: view.counted }
  const touches: FileTouch[] = []
  if (call.diff && call.diff.files.length > 0) {
    for (const f of call.diff.files) touches.push({ path: f.moveTo ?? f.path, added: f.added, removed: f.removed })
  } else if (call.linesAdded !== undefined || call.linesRemoved !== undefined) {
    // Lines without a diff: attributable only when the call names exactly one file. Spreading a
    // total across several would invent a per-file split nobody measured.
    const files = call.files ?? []
    if (files.length === 1) touches.push({ path: files[0]!, added: call.linesAdded, removed: call.linesRemoved })
    else for (const p of files) touches.push({ path: p })
  } else {
    return { files: view.files, counted: view.counted }
  }
  const files = [...view.files]
  for (const t of touches) {
    const at = files.findIndex(f => f.path === t.path)
    if (at === -1) files.push(t)
    else {
      const f = files[at]!
      files[at] = { path: f.path, added: addOpt(f.added, t.added), removed: addOpt(f.removed, t.removed) }
    }
  }
  return { files, counted: { ...view.counted, [call.id]: true } }
}

function fromHistory(turns: readonly CodeHistoryTurn[]): Pick<CodeView, 'entries' | 'tools' | 'turns'> {
  const entries: ConversationEntry[] = []
  const tools: Record<string, CodeToolCall> = {}
  let n = 0
  let user = 0
  for (const t of turns) {
    if (t.role === 'user') {
      entries.push({ kind: 'user', text: t.text })
      user++
      continue
    }
    const parts: TurnPart[] = []
    if (t.text) parts.push({ kind: 'text', text: t.text })
    for (const tool of t.tools) {
      const id = `history-${n++}`
      // A stored turn names the call and nothing about how it went — `done` because it is history,
      // and no duration or result because none was stored. Absent, never invented.
      tools[id] = { id, name: tool.name, verb: tool.verb, target: tool.target, state: 'done' }
      parts.push({ kind: 'tool', id })
    }
    entries.push({ kind: 'assistant', parts })
  }
  return { entries, tools, turns: user }
}

/**
 * Fold ONE host event into the view. Every `CodeEvent` kind is handled; the host decides what each
 * means and this only records it.
 */
export function reduceCode(view: CodeView, e: CodeEvent): CodeView {
  switch (e.kind) {
    case 'history': {
      // A resume REPLACES what was there: the history is the session's own record, and folding it
      // under a previous session's lines would put two conversations under one header.
      return { ...EMPTY_VIEW, ...fromHistory(e.turns) }
    }
    case 'user':
      return { ...view, entries: [...view.entries, { kind: 'user', text: e.text }], turns: view.turns + 1 }
    case 'run-started':
      return { ...view, runId: e.runId, run: EMPTY_USAGE }
    case 'delta': {
      if (!e.text) return view
      const entries = withAssistant(view.entries, e.runId, parts => {
        const last = parts[parts.length - 1]
        if (last && last.kind === 'text') return [...parts.slice(0, -1), { kind: 'text', text: last.text + e.text }]
        return [...parts, { kind: 'text', text: e.text }]
      })
      return { ...view, entries }
    }
    case 'tool': {
      const call = e.call
      const known = view.tools[call.id] !== undefined
      const tools = { ...view.tools, [call.id]: call }
      const entries = known
        ? view.entries
        : withAssistant(view.entries, view.runId ?? undefined, parts => [...parts, { kind: 'tool', id: call.id }])
      return { ...view, tools, entries, ...countFiles(view, call) }
    }
    case 'ask':
      return { ...view, ask: e.ask }
    case 'ask-closed': {
      if (!view.ask || view.ask.id !== e.id) {
        // A close for a question we never saw still happened; it is recorded, not dropped.
        return { ...view, entries: [...view.entries, { kind: 'answer', outcome: e.outcome, ...(e.choiceLabel ? { label: e.choiceLabel } : {}) }] }
      }
      return {
        ...view,
        ask: null,
        entries: [...view.entries, { kind: 'answer', outcome: e.outcome, ...(e.choiceLabel ? { label: e.choiceLabel } : {}) }],
      }
    }
    case 'usage': {
      const u = e.usage
      const context = u.contextTokens !== undefined
        ? { tokens: u.contextTokens, ...(u.contextWindow !== undefined ? { window: u.contextWindow } : {}) }
        : view.context
      return {
        ...view,
        run: addUsage(view.run, u),
        session: addUsage(view.session, u),
        context,
        model: u.model || view.model,
      }
    }
    case 'plan':
      return { ...view, plan: e.items }
    case 'run-ended': {
      // A completed run says nothing extra — the answer above IS the outcome. Anything else is a
      // run that did not finish, and that is said in the host's words, where it happened.
      const entries = e.status === 'completed'
        ? view.entries
        : [...view.entries, { kind: 'note' as const, tone: e.status === 'failed' || e.status === 'lost' ? 'error' as const : 'warn' as const, text: e.sentence }]
      return { ...view, runId: view.runId === e.runId || !e.runId ? null : view.runId, entries }
    }
    case 'notice':
      return { ...view, entries: [...view.entries, { kind: 'note', tone: e.tone, text: e.sentence }] }
    case 'closed':
      return { ...view, closed: e.sentence, runId: null, ask: null }
  }
}

export function reduceAll(view: CodeView, events: readonly CodeEvent[]): CodeView {
  let v = view
  for (const e of events) v = reduceCode(v, e)
  return v
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CD-02: coalescing a stream
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Adjacent deltas of the same run, merged into one. A model streams dozens of tiny deltas a second;
 * folding each as its own render repaints the whole frame per token, which is the flicker CD-02 is
 * judged on. The order of everything else is untouched.
 */
export function coalesceEvents(events: readonly CodeEvent[]): CodeEvent[] {
  const out: CodeEvent[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (e.kind === 'delta' && last && last.kind === 'delta' && last.runId === e.runId) {
      out[out.length - 1] = { ...last, text: last.text + e.text }
    } else {
      out.push(e)
    }
  }
  return out
}

/** The ~frame interval a stream is repainted at: under the eye's flicker threshold, over Ink's cost. */
export const STREAM_FLUSH_MS = 50

export interface Coalescer {
  push(e: CodeEvent): void
  /** Deliver now whatever is buffered. */
  flush(): void
  /** Drop the buffer and the timer — the session it belonged to is gone. */
  dispose(): void
}

/**
 * Buffers events and delivers them at most once per `intervalMs`, coalesced. The first event of a
 * quiet period is delivered within one interval, never later; the clock is injected so a test can
 * drive it.
 */
export function createCoalescer(o: {
  intervalMs: number
  deliver: (events: CodeEvent[]) => void
  schedule: (fn: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
}): Coalescer {
  let buffer: CodeEvent[] = []
  let timer: unknown = null
  let disposed = false
  const flush = () => {
    if (timer !== null) { o.cancel(timer); timer = null }
    if (buffer.length === 0 || disposed) return
    const batch = coalesceEvents(buffer)
    buffer = []
    o.deliver(batch)
  }
  return {
    push(e) {
      if (disposed) return
      buffer.push(e)
      if (timer === null) timer = o.schedule(() => { timer = null; flush() }, o.intervalMs)
    },
    flush,
    dispose() {
      disposed = true
      buffer = []
      if (timer !== null) { o.cancel(timer); timer = null }
    },
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// layout (D-TUI-10)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** At or above this many columns the conversation and the session panel stand side by side. */
export const CODE_WIDE_AT = 100
/** The session panel's width in the wide layout (prototype `scrCode`, `RW=38`). */
export const PANEL_WIDTH = 38
/** The composer is a framed one-line box. */
export const COMPOSER_ROWS = 3
/** The one header row (CD-01). */
export const CODE_HEADER_ROWS = 1

export interface CodeLayout {
  narrow: boolean
  /** Where the session panel is: beside the conversation, over the whole body, or not drawn. */
  panel: 'side' | 'full' | 'hidden'
  /** The narrow layout's one-line stand-in for the panel. 0 or 1. */
  statusRows: number
  /** Width of the conversation column (the whole width when the panel is not beside it). */
  mainWidth: number
  panelWidth: number
  /** Rows under the header (and the status row) for the column / the full panel. */
  bodyRows: number
}

/**
 * The tab's geometry. Wide: the conversation column plus a 38-column panel, which `ctrl+b` hides.
 * Narrow: one pane at a time — the conversation with a one-line status, or (`ctrl+b`) the panel
 * over the whole body, `esc` back.
 */
export function codeLayout(width: number, height: number, o: { panelOpen: boolean }): CodeLayout {
  const narrow = width < CODE_WIDE_AT
  const w = Math.max(0, width)
  const under = Math.max(0, height - CODE_HEADER_ROWS)
  if (narrow) {
    if (o.panelOpen) return { narrow, panel: 'full', statusRows: 0, mainWidth: w, panelWidth: w, bodyRows: under }
    const statusRows = under > COMPOSER_ROWS ? 1 : 0
    return { narrow, panel: 'hidden', statusRows, mainWidth: w, panelWidth: 0, bodyRows: under - statusRows }
  }
  if (!o.panelOpen) return { narrow, panel: 'hidden', statusRows: 0, mainWidth: w, panelWidth: 0, bodyRows: under }
  return { narrow, panel: 'side', statusRows: 0, mainWidth: w - PANEL_WIDTH, panelWidth: PANEL_WIDTH, bodyRows: under }
}

export interface ColumnRows {
  conversation: number
  hint: number
  popup: number
  card: number
  composer: number
}

/**
 * How the conversation column's rows are shared. The composer and the permission card KEEP their
 * rows — the card is what needs the person, the composer is how they answer — and the conversation
 * gives up rows first; a popup and a one-line hint come out of what is left before the conversation
 * does. Never a `Math.max(1, …)`: a row that does not exist is not handed out.
 */
export function columnRows(rows: number, want: { card: number; popup: number; hint: number }): ColumnRows {
  let rem = Math.max(0, rows)
  const composer = Math.min(COMPOSER_ROWS, rem)
  rem -= composer
  const card = Math.min(Math.max(0, want.card), rem)
  rem -= card
  const popup = Math.min(Math.max(0, want.popup), rem)
  rem -= popup
  const hint = Math.min(Math.max(0, want.hint), rem)
  rem -= hint
  return { conversation: rem, hint, popup, card, composer }
}

/**
 * A TAIL viewport: following the live edge until the person scrolls back, then anchored to the line
 * they scrolled to while new lines arrive below it. `top` is meaningful only when `follow` is false.
 */
export interface TailScroll {
  follow: boolean
  top: number
}

export const FOLLOW: TailScroll = { follow: true, top: 0 }

export function tailStart(total: number, height: number, s: TailScroll): number {
  const max = Math.max(0, total - height)
  return s.follow ? max : Math.min(Math.max(0, s.top), max)
}

/** `pgup`/`pgdn` over a tail view, CLAMPED; reaching the bottom again resumes following. */
export function scrollTail(total: number, height: number, s: TailScroll, dir: -1 | 1): TailScroll {
  const max = Math.max(0, total - height)
  const page = Math.max(1, height - 1)
  const top = Math.min(Math.max(0, tailStart(total, height, s) + dir * page), max)
  return top >= max ? FOLLOW : { follow: false, top }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// small formatters
// ═════════════════════════════════════════════════════════════════════════════════════════════

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
}

const plusMinus = (added: number | undefined, removed: number | undefined): Line => {
  const out: Line = []
  if (added !== undefined) out.push(seg(`+${added}`, { color: COLORS.success }))
  if (removed !== undefined) out.push(seg(`${out.length ? ' ' : ''}−${removed}`, { color: COLORS.danger }))
  return out
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CD-01: the header
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `session <title> · <ref> <task title> · <folder>` on the left, `▲ no sandbox  mode <mode>` on the
 * right. Under width pressure the folder goes first, then the task's title, then the session's
 * title (the subtask before the task's own title), then the mode word — and `▲ no sandbox` NEVER: D-TUI-9 puts it on screen for as long as
 * this tab is, because a session that runs tools as you with no sandbox must not be able to say so
 * only on terminals wide enough.
 */
export function headerLine(facts: CodeSessionFacts | null, t: CodeStrings, width: number): Line {
  const warn = seg(t.noSandbox, { color: COLORS.accent, bold: true })
  if (!facts) {
    return lr([seg(t.headerNoSession, { color: COLORS.label })], [warn], width, 2)
  }
  const mode = [seg(`  ${t.mode} `, { color: COLORS.muted }), seg(facts.mode, { color: COLORS.secondary, bold: true })]
  const sep = seg(' · ', { color: COLORS.muted })
  const ref = facts.task ? [seg(facts.task.ref, { color: COLORS.accent })] : [seg(t.notFiled, { color: COLORS.danger })]
  const taskTitle = facts.task ? [seg(` ${facts.task.title}`, { color: COLORS.label })] : []
  const sub = facts.subtask ? [seg(` › ${facts.subtask.title}`, { color: COLORS.muted })] : []
  const title = [seg(`${t.headerSession} `, { color: COLORS.label }), seg(facts.title, { color: COLORS.text })]
  const folder = [sep, seg(facts.cwd, { color: COLORS.muted })]

  const attempts: Array<{ left: Line; right: Line }> = [
    { left: [...title, sep, ...ref, ...taskTitle, ...sub, ...folder], right: [warn, ...mode] },
    { left: [...title, sep, ...ref, ...taskTitle, ...sub], right: [warn, ...mode] },
    { left: [...title, sep, ...ref, ...taskTitle], right: [warn, ...mode] },
    { left: [...title, sep, ...ref], right: [warn, ...mode] },
    { left: [...ref], right: [warn, ...mode] },
    { left: [...ref], right: [warn] },
  ]
  for (const a of attempts) {
    if (lineWidth(a.left) + 2 + lineWidth(a.right) <= width) return lr(a.left, a.right, width, 2)
  }
  // Too narrow for even the task handle beside the warning: the warning alone, cut only if the
  // terminal is narrower than the warning itself.
  return fitLine([warn], width)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CD-02 / CD-03 / CD-04: the conversation
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The live cursor at the end of a streaming answer. */
export const STREAM_CURSOR = '▍'
/** How many changed lines an applied patch shows inline before "+ K more". */
export const INLINE_DIFF_LINES = 4
const VERB_WIDTH = 6

function toolGlyph(state: CodeToolCall['state']): Seg {
  switch (state) {
    case 'done': return seg('✓', { color: COLORS.success })
    case 'failed':
    case 'denied': return seg('✗', { color: COLORS.danger })
    case 'asking': return seg('◐', { color: COLORS.accent })
    case 'running': return seg('◐', { color: COLORS.info })
  }
}

function diffTotals(diff: CodeDiff | undefined): { added: number; removed: number } | null {
  if (!diff || diff.files.length === 0) return null
  let added = 0
  let removed = 0
  for (const f of diff.files) { added += f.added; removed += f.removed }
  return { added, removed }
}

/** CD-03: one row per call — glyph · verb · target · right-aligned outcome. */
export function toolRow(call: CodeToolCall, t: CodeStrings, width: number): Line[] {
  const verb = call.verb.length >= VERB_WIDTH ? `${call.verb} ` : call.verb.padEnd(VERB_WIDTH)
  const left: Line = [toolGlyph(call.state), seg(' '), seg(verb, { color: COLORS.label }), seg(sanitize(call.target))]
  const right: Line = []
  const dur = call.durationMs !== undefined ? fmtMs(call.durationMs) : ''
  switch (call.state) {
    case 'asking': right.push(seg(t.toolNeedsYou, { color: COLORS.accent })); break
    case 'running': right.push(seg(t.toolRunning, { color: COLORS.info })); break
    case 'failed': right.push(seg(t.toolFailed, { color: COLORS.danger })); break
    case 'denied': right.push(seg(t.toolDenied, { color: COLORS.danger })); break
    case 'done': {
      const lines = diffTotals(call.diff)
      if (lines) right.push(...plusMinus(lines.added, lines.removed))
      else if (call.linesAdded !== undefined || call.linesRemoved !== undefined) right.push(...plusMinus(call.linesAdded, call.linesRemoved))
      else if (call.result) right.push(seg(sanitize(call.result), { color: COLORS.muted }))
      if (dur) right.push(seg(`${right.length ? ' · ' : ''}${dur}`, { color: COLORS.muted }))
      break
    }
  }
  const rows: Line[] = [lr(left, right, width, 2)]
  // Failures in WORDS (CD-03), on their own lines under the row: a reason truncated to fit beside
  // the target is a reason cut exactly where it starts to explain.
  if ((call.state === 'failed' || call.state === 'denied') && call.failure) {
    for (const l of wrapText(call.failure, Math.max(1, width - 4)).slice(0, 3)) {
      rows.push(fitLine([seg('    '), seg(l, { color: COLORS.danger })], width))
    }
  }
  return rows
}

function diffLine(op: '+' | '-', text: string, width: number, prefix: string): Line {
  const bg = op === '+' ? DIFF_ADD_BG : DIFF_DEL_BG
  const color = op === '+' ? COLORS.success : COLORS.danger
  return fitLine([seg(`${prefix}${op} `, { color, bg }), seg(sanitize(text), { color: COLORS.text, bg })], width, bg)
}

/** CD-04: an applied patch's changed lines under its row, then how many more there are. */
export function inlineDiffLines(diff: CodeDiff, t: CodeStrings, width: number, max = INLINE_DIFF_LINES): Line[] {
  const out: Line[] = []
  let shown = 0
  let total = 0
  const multi = diff.files.length > 1
  for (const f of diff.files) {
    const changed = f.hunks.flatMap(h => h.lines.filter(l => l.op !== ' '))
    total += changed.length
    if (shown >= max) continue
    if (multi) out.push(fitLine([seg(`  ${f.moveTo ?? f.path}`, { color: COLORS.muted })], width))
    for (const l of changed) {
      if (shown >= max) break
      out.push(diffLine(l.op as '+' | '-', l.text, width, '  '))
      shown++
    }
  }
  if (total > shown) out.push(fitLine([seg(`  ${t.moreChanged(total - shown)}`, { color: COLORS.muted })], width))
  return out
}

function speaker(label: string, color: string, extra: string | undefined, width: number): Line {
  const line: Line = [seg(label, { color, bold: true })]
  if (extra) line.push(seg(` · ${extra}`, { color: COLORS.muted }))
  return fitLine(line, width)
}

/**
 * Every line of the conversation, in order, at `width`. The screen shows its tail.
 *
 * `streaming` is whether the run is still in progress: the live cursor sits at the end of the LAST
 * answer's text only then, and only when that answer's last piece IS text — after a tool call the
 * tool's own `◐` is what says something is happening.
 */
export function conversationLines(view: CodeView, facts: CodeSessionFacts | null, t: CodeStrings, width: number): Line[] {
  const out: Line[] = []
  const model = facts?.model ?? view.model
  const lastAssistant = view.entries.map(e => e.kind).lastIndexOf('assistant')
  view.entries.forEach((e, index) => {
    switch (e.kind) {
      case 'user':
        if (out.length) out.push(blank())
        out.push(speaker(t.you, COLORS.info, undefined, width))
        for (const l of wrapText(e.text, width)) out.push([seg(l, { color: COLORS.text })])
        return
      case 'assistant': {
        if (out.length) out.push(blank())
        out.push(speaker(t.assistant, COLORS.accent, model, width))
        const live = view.runId !== null && index === lastAssistant
        e.parts.forEach((p, pi) => {
          if (p.kind === 'text') {
            const wrapped = wrapText(p.text, width)
            const cursorHere = live && pi === e.parts.length - 1
            wrapped.forEach((l, li) => {
              const isLast = li === wrapped.length - 1
              if (cursorHere && isLast) {
                // The cursor takes a cell; a line already full moves it to its own row rather than
                // pushing the row one cell past the edge.
                if (cellWidth(l) + 1 <= width) out.push([seg(l, { color: COLORS.text }), seg(STREAM_CURSOR, { color: COLORS.accent })])
                else { out.push([seg(l, { color: COLORS.text })]); out.push([seg(STREAM_CURSOR, { color: COLORS.accent })]) }
              } else {
                out.push([seg(l, { color: COLORS.text })])
              }
            })
            return
          }
          const call = view.tools[p.id]
          if (!call) return
          out.push(...toolRow(call, t, width))
          if (call.state === 'done' && call.diff) out.push(...inlineDiffLines(call.diff, t, width))
        })
        // A run that has started but not yet said anything still shows it is alive.
        if (live && e.parts.length === 0) out.push([seg(STREAM_CURSOR, { color: COLORS.accent })])
        return
      }
      case 'note': {
        const color = e.tone === 'error' ? COLORS.danger : e.tone === 'warn' ? COLORS.accent : COLORS.muted
        for (const l of wrapText(e.text, Math.max(1, width - 2))) out.push(fitLine([seg('› ', { color }), seg(l, { color })], width))
        return
      }
      case 'answer': {
        const text = e.outcome === 'answered'
          ? t.answered(e.label ?? '')
          : e.outcome === 'timeout' ? t.askTimeout : t.askCancelled
        const color = e.outcome === 'answered' ? COLORS.muted : COLORS.accent
        for (const l of wrapText(text, Math.max(1, width - 2))) out.push(fitLine([seg('↳ ', { color }), seg(l, { color })], width))
        return
      }
    }
  })
  // A run with nothing in the conversation yet (a first message still being queued) shows the cursor
  // on its own, so the pane is visibly waiting rather than empty.
  if (view.runId !== null && lastAssistant === -1) out.push([seg(STREAM_CURSOR, { color: COLORS.accent })])
  return out
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// fitting a card into the rows it was given
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A block of lines that may shrink to `min` rows. `drop` orders who gives up rows first (lower
 * first). The card's options never shrink: a permission whose options are off screen cannot be
 * answered — which is why they are the one section with `min === lines.length`.
 */
export interface Section {
  lines: Line[]
  min: number
  drop: number
}

export function fitSections(sections: readonly Section[], max: number): Line[] {
  const kept = sections.map(s => s.lines.length)
  let total = kept.reduce((a, b) => a + b, 0)
  const order = sections.map((s, i) => ({ i, drop: s.drop })).sort((a, b) => a.drop - b.drop)
  for (const { i } of order) {
    if (total <= max) break
    const s = sections[i]!
    const give = Math.min(total - max, kept[i]! - Math.min(s.min, kept[i]!))
    kept[i] = kept[i]! - give
    total -= give
  }
  const out: Line[] = []
  sections.forEach((s, i) => out.push(...s.lines.slice(0, kept[i])))
  return out.slice(0, Math.max(0, max))
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CD-07: the permission card
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** How many changed lines the card previews before `d full diff`. */
export const CARD_DIFF_LINES = 3

/**
 * `cwd <dir> · runs as you · no sandbox` — on one line when it fits, and otherwise on TWO, with the
 * directory the one that is cut. Truncating the joined line cut exactly the words it exists to say:
 * a long worktree path pushed `no sandbox` past the edge of the card.
 */
function runsAsYouLines(t: CodeStrings, width: number, cwd?: string): Line[] {
  const warn: Line = [seg(`${t.runsAsYou} · `, { color: COLORS.muted }), seg(t.noSandboxWord, { color: COLORS.accent, bold: true })]
  if (!cwd) return [fitLine(warn, width)]
  const where = seg(`${t.cwd} ${cwd}`, { color: COLORS.muted })
  const one: Line = [where, seg(' · ', { color: COLORS.muted }), ...warn]
  if (lineWidth(one) <= width) return [one]
  return [fitLine([where], width), fitLine(warn, width)]
}

/** The options exactly as the policy gave them, numbered 1..n in the policy's order. */
export function optionLines(ask: CodeAsk, width: number): Line[] {
  return ask.options.map((o, i) => {
    const line: Line = [seg(`${i + 1}`, { color: COLORS.accent, bold: true }), seg(` ${sanitize(o.label)}`, { color: COLORS.text })]
    if (o.description) line.push(seg(`  ${sanitize(o.description)}`, { color: COLORS.muted }))
    return fitLine(line, width)
  })
}

function fileHeader(f: CodeDiffFile, t: CodeStrings, width: number): Line {
  const left: Line = [seg(f.moveTo ? `${f.path} → ${f.moveTo}` : f.path, { color: COLORS.text, bold: true })]
  const right: Line = [...plusMinus(f.added, f.removed), seg(`  ${t.hunks(f.hunks.length)}`, { color: COLORS.muted })]
  return lr(left, right, width, 2)
}

/** The card's pane title, so the screen and the tests name it the same way. */
export function permissionTitle(ask: CodeAsk, t: CodeStrings): string {
  return ask.kind === 'permission' ? t.permTitle(ask.toolName ?? ask.title) : t.questionTitle
}

/**
 * CD-07: what a permission question says, fitted into `maxRows` content rows. It names the call
 * (the WHOLE shell command and where it runs; for a write, the file with its counts and its first
 * changed lines), says it runs as you with no sandbox, says WHY it asked, and lists the policy's
 * options numbered in the policy's order. The checkpoint line appears only when the runtime really
 * takes one — a promise of an undo that does not exist is worse than no promise.
 *
 * Under a short terminal the diff preview goes first, then the policy's restated title, then the
 * extra "why" lines; the options never go.
 */
export function permissionCardLines(ask: CodeAsk, t: CodeStrings, width: number, maxRows = Number.MAX_SAFE_INTEGER): Line[] {
  // The preview is sized BEFORE the "+ K more" count is written, so the count names every changed
  // line the card does not show. Trimming the preview afterwards (as the generic section budget
  // would) left a card showing one removed line, none of the added ones, and no word that anything
  // was missing — measured at 80x24 by code-tab.e2e.test.ts.
  const changedCount = ask.command ? 0 : (ask.diff?.files ?? []).reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.filter(l => l.op !== ' ').length, 0), 0)
  for (let n = Math.min(CARD_DIFF_LINES, changedCount); n > 0; n--) {
    // The other sections may still give rows up (the restated title, the extra reasons); the
    // preview may not. It fits when the sections' MINIMA do — `fitSections` cuts the tail when they
    // do not, and the tail is the options, which a card may never lose.
    const secs = cardSections(ask, t, width, n)
    if (secs.reduce((k, x) => k + Math.min(x.min, x.lines.length), 0) <= maxRows) return fitSections(secs, maxRows)
  }
  return fitSections(cardSections(ask, t, width, 0), maxRows)
}

function cardSections(ask: CodeAsk, t: CodeStrings, width: number, previewRows: number): Section[] {
  const sections: Section[] = []
  const headline = wrapText(ask.title, width).map(l => [seg(l, { color: COLORS.label })])
  sections.push({ lines: headline, min: 0, drop: 2 })

  if (ask.command) {
    const cmd = wrapText(ask.command.command, width).map(l => [seg(l, { color: COLORS.text, bold: true })])
    sections.push({ lines: cmd, min: 1, drop: 5 })
    const runs = runsAsYouLines(t, width, ask.command.cwd)
    sections.push({ lines: runs, min: runs.length, drop: 99 })
  } else if (ask.diff && ask.diff.files.length > 0) {
    const f = ask.diff.files[0]!
    sections.push({ lines: [fileHeader(f, t, width)], min: 1, drop: 99 })
    const changed = ask.diff.files.flatMap(x => x.hunks.flatMap(h => h.lines.filter(l => l.op !== ' ')))
    const preview = changed.slice(0, previewRows).map(l => diffLine(l.op as '+' | '-', l.text, width, ''))
    sections.push({ lines: preview, min: preview.length, drop: 1 })
    const rest = changed.length - preview.length
    const more: Line = []
    if (rest > 0) more.push(seg(`${t.moreLines(rest)} · `, { color: COLORS.muted }))
    more.push(seg('d', { color: COLORS.accent }), seg(t.fullDiffKey.replace(/^d/, ''), { color: COLORS.muted }))
    if (ask.diff.files.length > 1) more.push(seg(` · +${ask.diff.files.length - 1} file${ask.diff.files.length === 2 ? '' : 's'}`, { color: COLORS.muted }))
    sections.push({ lines: [fitLine(more, width)], min: 1, drop: 98 })
    if (ask.checkpoint) sections.push({ lines: [fitLine([seg(t.checkpoint, { color: COLORS.muted })], width)], min: 0, drop: 4 })
    sections.push({ lines: runsAsYouLines(t, width), min: 1, drop: 97 })
  } else if (ask.paths && ask.paths.length > 0) {
    const lines = ask.paths.map(p => fitLine([seg(`${p.op} `, { color: COLORS.label }), seg(p.path, { color: COLORS.text })], width))
    sections.push({ lines, min: 1, drop: 5 })
    if (ask.checkpoint) sections.push({ lines: [fitLine([seg(t.checkpoint, { color: COLORS.muted })], width)], min: 0, drop: 4 })
    sections.push({ lines: runsAsYouLines(t, width), min: 1, drop: 97 })
  } else if (ask.kind === 'permission') {
    sections.push({ lines: runsAsYouLines(t, width), min: 1, drop: 97 })
  }

  if (ask.why.length > 0) {
    const why: Line[] = []
    ask.why.forEach((w, i) => {
      const prefix = i === 0 ? `${t.askedBecause} ` : '  '
      const wrapped = wrapText(w, Math.max(1, width - cellWidth(prefix)))
      wrapped.forEach((l, li) => why.push(fitLine([seg(li === 0 ? prefix : ' '.repeat(cellWidth(prefix)), { color: COLORS.muted }), seg(l, { color: COLORS.muted })], width)))
    })
    sections.push({ lines: why, min: 1, drop: 3 })
  }

  sections.push({ lines: [blank()], min: 0, drop: 0 })
  const opts = optionLines(ask, width)
  sections.push({ lines: opts, min: opts.length, drop: 100 })
  return sections
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CD-09: the full diff
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** `@@ -39,7 +39,8 @@` → the first old and new line numbers; `null` when the header names none. */
export function hunkStart(header: string | undefined): { old: number; new: number } | null {
  if (!header) return null
  const m = /@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/.exec(header)
  return m ? { old: Number(m[1]), new: Number(m[2]) } : null
}

export interface FullDiff {
  /** Fixed above the scrolling body: runs-as-you / no sandbox, and the checkpoint only when true. */
  head: Line[]
  /** Every hunk of every file — the part that scrolls. */
  body: Line[]
  /** The policy's options, numbered — fixed under the body, never scrolled away. */
  options: Line[]
}

/**
 * CD-09: every hunk of every file, with line numbers where the hunk header gave a starting point
 * (a `-` line carries its OLD number, the others their NEW one), then the same numbered options.
 */
export function fullDiffLines(ask: CodeAsk, t: CodeStrings, width: number): FullDiff {
  const head: Line[] = [...runsAsYouLines(t, width, ask.command?.cwd)]
  if (ask.checkpoint) head.push(fitLine([seg(t.checkpoint, { color: COLORS.muted })], width))
  const body: Line[] = []
  const files = ask.diff?.files ?? []
  files.forEach((f, fi) => {
    if (fi > 0) body.push(blank())
    const opLabel = seg(`  ${t.fileOp[f.op]}`, { color: COLORS.muted })
    body.push(lr([seg(f.moveTo ? `${f.path} → ${f.moveTo}` : f.path, { color: COLORS.text, bold: true }), opLabel], [...plusMinus(f.added, f.removed), seg(`  ${t.hunks(f.hunks.length)}`, { color: COLORS.muted })], width, 2))
    const numWidth = Math.max(3, ...f.hunks.map(h => {
      const s = hunkStart(h.header)
      return s ? String(Math.max(s.old, s.new) + h.lines.length).length : 0
    }))
    for (const h of f.hunks) {
      if (h.header) body.push(fitLine([seg(sanitize(h.header), { color: COLORS.secondary })], width))
      const start = hunkStart(h.header)
      let oldN = start?.old ?? 0
      let newN = start?.new ?? 0
      for (const l of h.lines) {
        let num = ''
        if (start) {
          if (l.op === '-') num = String(oldN++)
          else if (l.op === '+') num = String(newN++)
          else { num = String(newN); oldN++; newN++ }
        }
        const gutter = start ? `${num.padStart(numWidth)} │ ` : ''
        if (l.op === ' ') {
          body.push(fitLine([seg(`  ${gutter}`, { color: COLORS.muted }), seg(sanitize(l.text), { color: COLORS.label })], width))
        } else {
          const bg = l.op === '+' ? DIFF_ADD_BG : DIFF_DEL_BG
          const color = l.op === '+' ? COLORS.success : COLORS.danger
          body.push(fitLine([seg(`${l.op} ${gutter}`, { color, bg }), seg(sanitize(l.text), { color: COLORS.text, bg })], width, bg))
        }
      }
    }
  })
  return { head, body, options: optionLines(ask, width) }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CD-11: the composer and its command table
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type CodeCommandId = 'new' | 'diff' | 'cancel' | 'panel'

/**
 * What a key or a command asks the screen to do. The screen performs it (calling the host where the
 * intent names a host action) and leaves ONE sentence on the status row for it.
 */
export type CodeIntent =
  | { kind: 'none' }
  | { kind: 'draft'; draft: string }
  | { kind: 'send'; text: string }
  | { kind: 'open-wizard'; firstMessage?: string }
  | { kind: 'answer'; choice: number }
  | { kind: 'deny' }
  | { kind: 'open-diff' }
  | { kind: 'close-diff' }
  | { kind: 'diff-scroll'; delta: number }
  | { kind: 'cancel-run' }
  | { kind: 'toggle-panel' }
  | { kind: 'tab'; step: 1 | -1 }
  | { kind: 'scroll'; dir: -1 | 1 }
  | { kind: 'popup-move'; delta: 1 | -1 }
  | { kind: 'unknown-command'; text: string }
  | { kind: 'say'; code: 'answer-first' | 'no-diff' }

export interface CodeCommand {
  id: CodeCommandId
  /** What is typed: `/new`. */
  label: string
  /** The key that does the same thing without the popup — shown beside it. */
  keys: string
  /** What running it asks for — the same intent the key produces. */
  intent: CodeIntent
}

/**
 * THE command list. The `/` popup reads it now and the P2 palette (GL-03) will read it too — one
 * list, so a command cannot exist in one door and not the other. Every entry does something real:
 * a `/help` that printed nothing new, or an `/undo` with no checkpoint behind it, would be a dead
 * control, and this table is where one would hide.
 */
export const CODE_COMMANDS: readonly CodeCommand[] = [
  { id: 'new', label: '/new', keys: 'n', intent: { kind: 'open-wizard' } },
  { id: 'diff', label: '/diff', keys: 'd', intent: { kind: 'open-diff' } },
  { id: 'cancel', label: '/cancel', keys: 'esc', intent: { kind: 'cancel-run' } },
  { id: 'panel', label: '/panel', keys: 'ctrl+b', intent: { kind: 'toggle-panel' } },
] as const

/** Commands the draft could still become — the popup's rows. Only while the draft is one `/word`. */
export function matchCommands(draft: string): CodeCommand[] {
  if (!draft.startsWith('/') || /\s/.test(draft)) return []
  return CODE_COMMANDS.filter(c => c.label.startsWith(draft))
}

/** CD-11: the composer's one content row. `cursorOn` blinks nothing — the cursor is static. */
export function composerLine(
  o: { draft: string; ask: CodeAsk | null; closed: string | null; sessionOpen: boolean },
  t: CodeStrings,
  width: number,
): Line {
  if (o.ask) {
    return fitLine([seg('› ', { color: COLORS.muted }), seg(t.locked(o.ask.options.length), { color: COLORS.muted })], width)
  }
  const prompt = seg('› ', { color: COLORS.text })
  if (!o.draft) {
    const text = o.closed ? t.closed(o.closed) : t.placeholder
    return fitLine([prompt, seg(text, { color: COLORS.muted }), seg(STREAM_CURSOR, { color: COLORS.accent })], width)
  }
  // Keep the TAIL of a long draft — what was just typed matters more than what scrolled off left.
  const room = Math.max(0, width - 3)
  let shown = sanitize(o.draft)
  while (cellWidth(shown) > room) shown = shown.slice(1)
  return fitLine([prompt, seg(shown, { color: COLORS.text }), seg(STREAM_CURSOR, { color: COLORS.accent })], width)
}

/** The one-line hint an `@` or a leading `!` earns, or `null`. */
export function composerHint(draft: string, t: CodeStrings, width: number): Line | null {
  if (draft.startsWith('!')) return fitLine([seg(t.hintBang, { color: COLORS.muted })], width)
  if (/(^|\s)@/.test(draft)) return fitLine([seg(t.hintAt, { color: COLORS.muted })], width)
  return null
}

export function popupLines(matches: readonly CodeCommand[], selected: number, t: CodeStrings, width: number): Line[] {
  return matches.map((c, i) => lr(
    [seg(i === selected ? '▸ ' : '  ', { color: COLORS.accent }), seg(c.label, { color: COLORS.text, bold: i === selected }), seg(`  ${t.commandDescriptions[c.id]}`, { color: COLORS.muted })],
    [seg(c.keys, { color: COLORS.muted })],
    width,
    2,
  ))
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CD-12 (P1): the session panel
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Width of the context gauge's bar inside the panel. */
const GAUGE_MAX = 24

function gauge(fraction: number, width: number): string {
  const w = Math.max(0, width)
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
  const filled = Math.min(w, Math.floor(f * w))
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

const na = (t: CodeStrings): Seg => seg(t.na, { color: COLORS.muted })
const num = (n: number | undefined, t: CodeStrings): Seg => (n === undefined ? na(t) : seg(fmt(n), { color: COLORS.text }))

function costCell(u: UsageTotals, t: CodeStrings): Line {
  if (u.costUSD === undefined) return [na(t)]
  return [seg(fmtCost(u.costUSD), { color: COLORS.text })]
}

/**
 * Cache hit rate — `cacheRead / readTokens`, core's denominator (`input + cacheRead + cacheWrite`),
 * never a second definition. `null` unless the counters it needs were REPORTED; an absent cache-write
 * counter (a source that records none) is the one that may stand in as zero, because it is not
 * "unknown", it is "this source does not write a cache".
 */
export function cacheHit(u: UsageTotals): number | null {
  if (u.input === undefined || u.cacheRead === undefined) return null
  const read = readTokens({ input: u.input, output: u.output ?? 0, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite ?? 0 })
  if (read <= 0) return null
  return u.cacheRead / read
}

/** All four counters, or `null` while any is unreported — a total over three of four is not one. */
export function tokenTotal(u: UsageTotals): number | null {
  if (u.input === undefined || u.output === undefined || u.cacheRead === undefined || u.cacheWrite === undefined) return null
  return totalTokens({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite })
}

function stateWord(view: CodeView, t: CodeStrings): Seg {
  if (view.closed !== null) return seg(`○ ${t.stateEnded}`, { color: COLORS.muted })
  if (view.ask) return seg(`● ${t.needsYou}`, { color: COLORS.accent })
  if (view.runId !== null) return seg(`● ${t.stateWorking}`, { color: COLORS.running })
  return seg(`● ${t.stateIdle}`, { color: COLORS.accent })
}

/**
 * CD-12, P1 scope: who/what (title, task, model, turn, state), the CONTEXT gauge as a total (the
 * system/tools/chat split waits for the runtime to report it), SPEND labelled api-equivalent (this
 * turn and this session — no "today" line: the host does not provide one), the four TOKENS counters
 * plus the cache hit, FILES touched with their +/−, and the PLAN when there is one. No "also open":
 * that needs the server to host native sessions (a stated B4 limit), and a section that could only
 * ever say "nothing" would be a claim, not a fact.
 */
export function sessionPanelLines(view: CodeView, facts: CodeSessionFacts | null, t: CodeStrings, width: number): Line[] {
  const L: Line[] = []
  const w = Math.max(0, width)
  // No session: one sentence, not a column of N/A — every one of those would be true and none of
  // them would be about anything.
  if (!facts && view.entries.length === 0) return wrapText(t.panelEmpty, w).map(l => [seg(l, { color: COLORS.muted })])
  const head = (label: string, right: Line = []) => lr([seg(label, { color: COLORS.label, bold: true })], right, w)
  if (facts) {
    L.push(lr([seg(facts.title, { color: COLORS.text, bold: true })], [seg(facts.shortId, { color: COLORS.muted })], w))
    L.push(fitLine(facts.task
      ? [seg(facts.task.ref, { color: COLORS.accent }), seg(` › ${facts.subtask?.title ?? facts.task.title}`, { color: COLORS.muted })]
      : [seg(t.notFiled, { color: COLORS.danger })], w))
    const model = view.model ?? facts.model
    L.push(lr([seg(`${model} · ${t.turn(view.turns)}`, { color: COLORS.muted })], [stateWord(view, t)], w))
  }
  L.push(blank())

  // CONTEXT — a gauge, and N/A with its reason when either half is missing. Never a 0 %.
  const ctx = view.context
  L.push(head(t.context, ctx?.window !== undefined ? [seg(t.window(fmt(ctx.window)), { color: COLORS.muted })] : []))
  if (!ctx) L.push(fitLine([seg(t.contextNoReading, { color: COLORS.muted })], w))
  else if (ctx.window === undefined || ctx.window <= 0) {
    L.push(lr([seg(t.contextNoWindow, { color: COLORS.muted })], [seg(fmt(ctx.tokens), { color: COLORS.text })], w))
  } else {
    const fraction = ctx.tokens / ctx.window
    // The label is UNCLAMPED (a session really can exceed its stated window) and rounded DOWN; the
    // bar saturates — the context-gauge rule from CLAUDE.md.
    const label = `${Math.floor(fraction * 100)}%`
    const bar = Math.min(GAUGE_MAX, Math.max(0, w - label.length - 1))
    const color = fraction >= 0.9 ? COLORS.danger : fraction >= 0.75 ? COLORS.accent : COLORS.success
    L.push(fitLine([seg(gauge(fraction, bar), { color }), seg(` ${label}`, { color: COLORS.text })], w))
  }
  L.push(blank())

  // SPEND — api-equivalent, always said.
  L.push(head(t.spend, [seg(t.apiEquivalent, { color: COLORS.muted })]))
  L.push(lr([seg(t.thisTurn, { color: COLORS.text })], costCell(view.run, t), w))
  L.push(lr([seg(t.sessionSpend, { color: COLORS.text })], costCell(view.session, t), w))
  if (view.session.unpriced > 0 && view.session.costUSD !== undefined) {
    L.push(fitLine([seg(t.unpriced(view.session.unpriced), { color: COLORS.muted })], w))
  }
  L.push(blank())

  // TOKENS — all four, each N/A until reported; the headline only when all four are.
  const u = view.session
  const total = tokenTotal(u)
  L.push(head(t.tokens, [total === null ? na(t) : seg(fmt(total), { color: COLORS.text })]))
  L.push(lr([seg(`${t.tokIn} `, { color: COLORS.muted }), num(u.input, t)], [seg(`${t.tokOut} `, { color: COLORS.muted }), num(u.output, t)], w))
  L.push(lr([seg(`${t.cacheRead} `, { color: COLORS.muted }), num(u.cacheRead, t)], [seg(`${t.cacheWrite} `, { color: COLORS.muted }), num(u.cacheWrite, t)], w))
  const hit = cacheHit(u)
  L.push(lr([seg(t.cacheHit, { color: COLORS.muted })], [hit === null ? na(t) : seg(`${Math.floor(hit * 100)}%`, { color: COLORS.success })], w))

  if (view.files.length > 0) {
    L.push(blank())
    let added: number | undefined
    let removed: number | undefined
    for (const f of view.files) { added = addOpt(added, f.added); removed = addOpt(removed, f.removed) }
    L.push(head(t.files, plusMinus(added, removed)))
    for (const f of view.files) {
      const name = f.path.split('/').pop() || f.path
      L.push(lr([seg('M ', { color: COLORS.accent }), seg(name, { color: COLORS.text })], plusMinus(f.added, f.removed), w))
    }
  }

  if (view.plan && view.plan.length > 0) {
    L.push(blank())
    const done = view.plan.filter(p => p.status === 'done').length
    L.push(head(t.plan, [seg(`${done}/${view.plan.length}`, { color: COLORS.muted })]))
    for (const p of view.plan) {
      const glyph = p.status === 'done' ? seg('✓ ', { color: COLORS.success }) : p.status === 'active' ? seg('◐ ', { color: COLORS.info }) : seg('○ ', { color: COLORS.muted })
      L.push(fitLine([glyph, seg(p.text, { color: p.status === 'todo' ? COLORS.muted : COLORS.text })], w))
    }
  }
  return L.map(l => fitLine(l, w))
}

/** D-TUI-10: the narrow layout's one-line stand-in for the panel — `ctx · cost · task · mode`. */
export function narrowStatusLine(view: CodeView, facts: CodeSessionFacts | null, t: CodeStrings, width: number): Line {
  const sep = seg(' · ', { color: COLORS.muted })
  const ctx = view.context && view.context.window ? `${Math.floor((view.context.tokens / view.context.window) * 100)}%` : t.na
  const left: Line = [seg(`${t.statusCtx} `, { color: COLORS.muted }), seg(ctx, { color: COLORS.accent }), sep, ...costCell(view.session, t)]
  if (facts) {
    left.push(sep, facts.task ? seg(facts.task.ref, { color: COLORS.accent }) : seg(t.notFiled, { color: COLORS.danger }))
    left.push(sep, seg(`${t.mode} `, { color: COLORS.muted }), seg(facts.mode, { color: COLORS.secondary }))
  }
  return lr(left, [seg(t.keyPanel, { color: COLORS.muted })], width, 2)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// keys → intents
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The subset of Ink's key object this tab reads. */
export interface CodeKey {
  input: string
  return?: boolean
  escape?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
  tab?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  pageUp?: boolean
  pageDown?: boolean
}

export interface CodeKeyContext {
  draft: string
  sessionOpen: boolean
  closed: boolean
  ask: CodeAsk | null
  diffOpen: boolean
  /** Narrow terminal with the panel over the whole body. */
  panelFull: boolean
  running: boolean
  /** The popup's selected row, when the popup is showing. */
  popup: number | null
}

/** Delete the word before the end, the way a shell's `ctrl+w` does (the `Prompt.tsx` rule). */
function deleteWord(v: string): string {
  const trimmed = v.replace(/\s+$/, '')
  const cut = trimmed.lastIndexOf(' ')
  return cut === -1 ? '' : trimmed.slice(0, cut + 1)
}

function isCtrl(k: CodeKey, letter: string, byte: string): boolean {
  return (Boolean(k.ctrl) && k.input === letter) || k.input === byte
}

/** Edit the draft for a key, or `null` when the key is not an edit. */
export function editDraft(draft: string, k: CodeKey): string | null {
  if (isCtrl(k, 'u', '\x15')) return ''
  if (isCtrl(k, 'w', '\x17')) return deleteWord(draft)
  if (k.backspace || k.delete) return draft.slice(0, -1)
  if (k.ctrl || k.meta || k.tab || k.upArrow || k.downArrow || k.leftArrow || k.rightArrow || k.return || k.escape) return null
  // A paste arrives as one chunk: line breaks become spaces (the composer is one line and enter
  // sends), every other control byte is dropped.
  const printable = [...k.input.replace(/\r\n|\r|\n/g, ' ')].filter(ch => ch >= ' ' && ch !== '\x7f').join('')
  return printable ? draft + printable : null
}

const digit = (k: CodeKey): number | null => (/^[1-9]$/.test(k.input) && !k.ctrl && !k.meta ? Number(k.input) : null)

/**
 * The ONE decision about what a key means on this tab, given what is on screen. The screen performs
 * the intent; the footer (`codeHints`) is derived from the same context, so the keys it names and
 * the keys this answers cannot drift apart.
 */
export function codeKeyIntent(ctx: CodeKeyContext, k: CodeKey): CodeIntent {
  if (isCtrl(k, 'b', '\x02')) return { kind: 'toggle-panel' }

  if (ctx.diffOpen) {
    if (k.escape) return { kind: 'close-diff' }
    const d = digit(k)
    if (d !== null && ctx.ask && d <= ctx.ask.options.length) return { kind: 'answer', choice: d - 1 }
    if (k.upArrow) return { kind: 'diff-scroll', delta: -1 }
    if (k.downArrow) return { kind: 'diff-scroll', delta: 1 }
    if (k.pageUp) return { kind: 'diff-scroll', delta: -10 }
    if (k.pageDown) return { kind: 'diff-scroll', delta: 10 }
    return { kind: 'none' }
  }

  if (ctx.panelFull) {
    if (k.escape) return { kind: 'toggle-panel' }
    if (k.input === '[' && !k.ctrl) return { kind: 'tab', step: -1 }
    if (k.input === ']' && !k.ctrl) return { kind: 'tab', step: 1 }
    return { kind: 'none' }
  }

  if (ctx.ask) {
    const d = digit(k)
    if (d !== null) return d <= ctx.ask.options.length ? { kind: 'answer', choice: d - 1 } : { kind: 'say', code: 'answer-first' }
    if (k.input === 'd' && !k.ctrl) return ctx.ask.diff && ctx.ask.diff.files.length > 0 ? { kind: 'open-diff' } : { kind: 'say', code: 'no-diff' }
    if (k.escape) return { kind: 'deny' }
    if (k.input === '[' && !k.ctrl) return { kind: 'tab', step: -1 }
    if (k.input === ']' && !k.ctrl) return { kind: 'tab', step: 1 }
    if (k.pageUp) return { kind: 'scroll', dir: -1 }
    if (k.pageDown) return { kind: 'scroll', dir: 1 }
    if (editDraft('', k) !== null) return { kind: 'say', code: 'answer-first' }
    return { kind: 'none' }
  }

  const matches = matchCommands(ctx.draft)
  if (ctx.popup !== null && matches.length > 0) {
    if (k.upArrow) return { kind: 'popup-move', delta: -1 }
    if (k.downArrow) return { kind: 'popup-move', delta: 1 }
    if (k.return) return matches[Math.min(ctx.popup, matches.length - 1)]!.intent
  }

  if (k.escape) {
    if (ctx.draft) return { kind: 'draft', draft: '' }
    if (ctx.running) return { kind: 'cancel-run' }
    return { kind: 'none' }
  }

  if (k.return) {
    const text = ctx.draft.trim()
    if (!text) return { kind: 'none' }
    if (text.startsWith('/')) {
      const word = text.split(/\s+/)[0]!
      const exact = CODE_COMMANDS.find(c => c.label === word)
      return exact ? exact.intent : { kind: 'unknown-command', text: word }
    }
    // With no session to send to, a typed message is the FIRST message of a new one — and a new one
    // starts at its task (D-TUI-6), so it opens the wizard rather than going nowhere.
    if (!ctx.sessionOpen || ctx.closed) return { kind: 'open-wizard', firstMessage: text }
    return { kind: 'send', text }
  }

  if (k.pageUp) return { kind: 'scroll', dir: -1 }
  if (k.pageDown) return { kind: 'scroll', dir: 1 }

  if (!ctx.draft && !k.ctrl && !k.meta) {
    if (k.input === '[') return { kind: 'tab', step: -1 }
    if (k.input === ']') return { kind: 'tab', step: 1 }
    if (k.input === 'n' && (!ctx.sessionOpen || ctx.closed)) return { kind: 'open-wizard' }
  }

  const next = editDraft(ctx.draft, k)
  return next === null ? { kind: 'none' } : { kind: 'draft', draft: next }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// GL-05: the footer
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface CodeHintState extends CodeKeyContext {
  /** The composer column has lines above its viewport to scroll back to. */
  canScroll: boolean
  narrow: boolean
}

/**
 * The keys that work NOW, most important first (`footerHints` drops from the right). Derived from
 * the same context `codeKeyIntent` answers, so a hint never names a key that does nothing here.
 */
export function codeHints(st: CodeHintState, t: CodeStrings): string[] {
  if (st.diffOpen) {
    return [...(st.ask ? [t.keyAnswer(st.ask.options.length)] : []), t.keyScroll, t.keyBack]
  }
  if (st.panelFull) return [t.keyPanelBack, t.keyTabs, t.keyQuit]
  if (st.ask) {
    const hasDiff = Boolean(st.ask.diff && st.ask.diff.files.length > 0)
    return [
      t.keyAnswer(st.ask.options.length),
      ...(hasDiff ? [t.keyFullDiff] : []),
      st.ask.denyIndex === null ? t.keyDismiss : t.keyDeny,
      t.keyTabs,
      ...(st.canScroll ? [t.keyHistory] : []),
      t.keyPanel,
    ]
  }
  if (st.popup !== null && matchCommands(st.draft).length > 0) return [t.keyRun, t.keyChoose, t.keyClear]
  const empty = st.draft === ''
  const noSession = !st.sessionOpen || st.closed
  const out: string[] = []
  if (empty && noSession) out.push(t.keyNew)
  if (!empty) out.push(noSession && !st.draft.startsWith('/') ? t.keyStartWith : t.keySend)
  if (empty) out.push(t.keyTabs)
  if (!empty) out.push(t.keyClear)
  else if (st.running) out.push(t.keyCancelRun)
  out.push(t.keyCommands)
  if (st.canScroll) out.push(t.keyHistory)
  out.push(t.keyPanel, t.keyQuit)
  return out
}
