/**
 * session-table.ts — PURE. The sessions table, drawn as plain terminal lines.
 *
 * This is the cockpit's table printed instead of mounted: `agentop session ls` asks the same
 * question the Sessions tab answers ("what is running, grouped by where I am working") and a person
 * reading a log wants the same aligned columns and the same section headings. What changes is the
 * DRAWING — ANSI written once to stdout rather than Ink components repainted — and nothing else.
 *
 * So every rule about what a row IS lives in `@agentistics/tui/control/sessions` and is consumed
 * here: `sessionColumns` measures the page, `groupSessions` + `sessionRows` decide the sections and
 * the air between them, `sessionHandle` / `worktreeName` / `sessionMetric` / `padCell` fill the
 * cells. A second implementation of any of them is a second set of rules that agree until the day
 * they do not — this repository has already paid for that once, with a task `open` written twice
 * that left the registry in two different states depending on which one you pressed.
 *
 * Two things ARE this module's own, because they are drawing:
 *
 *  - **Nothing may exceed the width.** Ink truncates an over-wide row with `wrap="truncate"`; a
 *    terminal wraps it, and a wrapped row shears every column under it. `sessionColumns` fits the
 *    row for every width a person actually uses, but at ~20 columns its own floor (the state word
 *    plus a one-character title) is already wider than the terminal — so the last step here CLIPS,
 *    counting only visible characters.
 *  - **Colour is optional and is never measured.** It is applied to a cell that is already padded,
 *    so a pipe and a terminal are the same table with the same column positions.
 */

import {
  contextLevel,
  DEFAULT_ORDER,
  groupSessions,
  padCell,
  sessionColumns,
  sessionContext,
  sessionHandle,
  sessionMetric,
  sessionRows,
  sessionNotify,
  notifyCellWidth,
  worktreeName,
  type ContextLevel,
  type DimensionWordBook,
  type SessionColumns,
  type SessionGrouping,
  type SessionOrder,
} from '@agentistics/tui/control/sessions'
import type { ControlSession, SessionState } from '@agentistics/tui/control'

/**
 * The words the table wears. Supplied by the caller, already localized — the same split every pure
 * module in the control center keeps, and the reason `agentop session ls` can print the very
 * headings the cockpit prints without either of them owning a copy of the other's strings.
 */
export interface SessionTableStrings {
  cols: Record<keyof SessionColumns, string>
  /** Every dimension's bucket names — built once by `sessionWordBook`, never assembled here. */
  words: DimensionWordBook
  /** Heads the block of conversations that are not running. */
  closed: string
  /** Marks a task the user finished, on its heading. */
  done: string
}

// ---------------------------------------------------------------------------
// colour
// ---------------------------------------------------------------------------

const ESC = '\x1b'
const RESET = `${ESC}[0m`
const DIM = `${ESC}[2m`
const CYAN = `${ESC}[36m`
const YELLOW = `${ESC}[33m`
const RED = `${ESC}[1;31m`

/** The gauge's colour, by how full it is. `ok` inherits the row's dim like every other fact — a
 *  bar that shouts at 12% has spent the attention it needs at 95%. */
const CONTEXT_ANSI: Record<ContextLevel, string> = { ok: DIM, warn: YELLOW, full: RED }

/**
 * The state palette, mirroring the cockpit's `STATE_COLOR` intent in the sixteen colours a plain
 * terminal is guaranteed to have.
 *
 * The theme's hex values are not reused directly: Ink resolves them through chalk, which downgrades
 * per terminal, and writing a truecolor escape ourselves would render as nothing on a terminal that
 * does not speak it — on the one cell of the row that nothing else repeats.
 */
const STATE_ANSI: Record<SessionState, string> = {
  'waiting-approval': `${ESC}[1;31m`,
  waiting: `${ESC}[33m`,
  idle: `${ESC}[32m`,
  working: `${ESC}[32m`,
  exited: DIM,
  lost: DIM,
  unknown: DIM,
  closed: DIM,
}

/** One piece of a line: its text, and the escape that colours it when colour is on. */
interface Seg {
  text: string
  code?: string
}

/**
 * Segments to one line, clipped to `width` — the only place a line is finished.
 *
 * Clipping counts the TEXT, never the escapes, so a coloured table and a piped one break in exactly
 * the same column. A segment that straddles the edge is cut; the ones after it are dropped whole.
 */
export function composeLine(segs: readonly Seg[], width: number, color: boolean): string {
  let left = Math.max(0, width)
  const kept: Seg[] = []
  for (const seg of segs) {
    if (left === 0) break
    const text = seg.text.length > left ? seg.text.slice(0, left) : seg.text
    if (text === '') continue
    left -= text.length
    kept.push({ text, ...(seg.code ? { code: seg.code } : {}) })
  }

  // The last cell's padding is blanks nobody can see, and it is what makes two identical rows differ
  // in a diff. Trimmed on the TEXT, before any escape is applied — a trailing space wrapped in a
  // colour would survive a trim of the finished string, so a coloured table and a piped one would
  // not end in the same place.
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!
    last.text = last.text.replace(/\s+$/, '')
    if (last.text !== '') break
    kept.pop()
  }

  return kept.map(s => (color && s.code ? `${s.code}${s.text}${RESET}` : s.text)).join('')
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

export interface SessionTableOptions {
  sessions: readonly ControlSession[]
  /** Columns available. See `naturalWidth` for what a pipe gets instead of a terminal's. */
  width: number
  grouping: SessionGrouping
  strings: SessionTableStrings
  color: boolean
  /** Tasks the user marked finished — their headings say so. */
  doneTasks?: readonly string[]
  order?: SessionOrder
}

/**
 * A width no row reaches, for output that is not going to a terminal and says nothing about one.
 *
 * A pipe has no width of its own, and inventing one truncates a session's name to fit a terminal
 * nobody is looking at. Passed as the budget, `sessionColumns` gives every column its natural size
 * and the lines come out exactly as long as their content.
 *
 * It is the LAST answer, not the first — see `resolveWidth`.
 */
export const NATURAL_WIDTH = 10_000

/**
 * How many columns to fit — PURE, and the whole precedence in one place.
 *
 *  1. `explicit` — `--width`. Somebody stated it; nothing else gets a say.
 *  2. `columns` — the terminal's own, via `process.stdout.columns`, which exists only on a tty.
 *  3. `env` — `COLUMNS`. **The reason this function exists.** Without a tty the width was the
 *     natural one, so `agentop session ls | less -S` in an 80-column terminal received a table as
 *     wide as its content and `less` broke every row. A pipe is not evidence that nobody is
 *     reading: a pager IS a reader, and when there is no tty to ask, `COLUMNS` is the only thing
 *     left that says how wide the reader is. It is the convention `git` and `ls` follow.
 *  4. The natural width — a pipe that said nothing about a width still gets nothing truncated.
 *
 * A `COLUMNS` that is present but not a width (`abc`, `0`, `-1`, `12.5`) falls through to the next
 * answer rather than throwing or being coerced: the variable is set by all sorts of things, and a
 * junk value is a statement about the environment, not an instruction. There is no MINIMUM applied
 * either — a caller asking for twenty columns gets twenty, and the clip is what keeps the rows
 * inside them. A floor here would silently overrule the one thing the caller actually said.
 */
export function resolveWidth(o: {
  /** `--width`, when it was given. */
  explicit?: number
  /** `process.stdout.columns` — pass it only when stdout really is a tty. */
  columns?: number
  /** The raw `COLUMNS` variable, exactly as the environment holds it. */
  env?: string
}): number {
  if (isWidth(o.explicit)) return o.explicit
  if (isWidth(o.columns)) return o.columns
  const fromEnv = o.env === undefined || o.env.trim() === '' ? Number.NaN : Number(o.env)
  if (isWidth(fromEnv)) return fromEnv
  return NATURAL_WIDTH
}

function isWidth(n: number | undefined): n is number {
  return n !== undefined && Number.isInteger(n) && n > 0
}

/**
 * Why there is no table — PURE, and `null` when there is one.
 *
 * A blank where a list was expected is indistinguishable from a command that broke, so an empty run
 * has to say which of three things happened, and they are genuinely different claims:
 *
 *  - `unavailable` — the poll did not establish anything. Claiming "nothing is running" here would
 *    be a confident zero, which is the one answer this monitor may never give.
 *  - `empty` — the machine really has no sessions.
 *  - `filtered` — sessions exist and the default question ("what is running") withheld them. They
 *    are still named, still filed and still reopenable, so the caller names the flag that lists
 *    them.
 */
export function emptyReason(o: {
  /** How many rows the fleet holds, before the filter. */
  fleet: number
  /** How many are left after it. */
  shown: number
  unavailable?: string
}): 'unavailable' | 'empty' | 'filtered' | null {
  if (o.shown > 0) return null
  if (o.unavailable) return 'unavailable'
  return o.fleet === 0 ? 'empty' : 'filtered'
}

/** The whole table as lines — headings, the column header, the rows, and the air between sections. */
export function renderSessionTable(o: SessionTableOptions): string[] {
  const groups = groupSessions(
    o.sessions,
    o.grouping,
    o.strings.words,
    o.doneTasks ?? [],
    o.order ?? DEFAULT_ORDER,
  )
  const rows = sessionRows(groups, o.strings.closed, o.strings.done)
  if (rows.length === 0) return []

  // Measured across every row that will be PRINTED. Unlike the cockpit there is no window here —
  // the whole fleet is the page — so a long title does widen the column for all of it, which is
  // correct for a log: it is read as one block, not scrolled.
  // Zero on a quiet fleet — the same rule and the same function the cockpit uses.
  const notify = notifyCellWidth(rows.flatMap(r => (r.kind === 'session' ? [r.session] : [])))
  const columns = sessionColumns(
    rows.flatMap(r => (r.kind === 'session' ? [r.session] : [])),
    o.width,
    {
      groupedByTask: o.grouping === 'task',
      groupedByProject: o.grouping === 'project',
      headings: o.strings.cols,
    },
  )

  // Every line except the headings, first — because a heading's rule runs to the edge of the TABLE
  // and the table is only as wide as its widest row. Ruling to the budget instead is invisible at a
  // terminal's width and absurd at a pipe's, where it drew ten thousand dashes over four sessions.
  const drawn = [headerSegs(columns, o.strings.cols, notify), ...rows.map(
    r => (r.kind === 'session' ? rowSegs(r.session, columns, notify) : null),
  )]
  const table = drawn.reduce(
    (n, segs) => (segs ? Math.max(n, plainWidth(segs)) : n),
    0,
  )
  const edge = Math.min(o.width, table)

  const out: string[] = [composeLine(drawn[0]!, o.width, o.color)]
  rows.forEach((row, i) => {
    const segs = drawn[i + 1]
    if (segs) { out.push(composeLine(segs, o.width, o.color)); return }
    if (row.kind === 'spacer') { out.push(''); return }
    if (row.kind === 'heading') {
      // Indented by the cascade's branch depth, exactly as the cockpit's list does it — the two
      // draw ONE table, and a tree that reads as a flat list on the command line would be a
      // different arrangement wearing the same name.
      out.push(composeLine(
        headingSegs(`${HEADING_INDENT.repeat(row.depth ?? 0)}${row.label}`, row.count, edge, row.muted),
        o.width,
        o.color,
      ))
    }
  })
  return out
}

/** What these segments occupy on screen, escapes excluded — they are added after this is decided. */
function plainWidth(segs: readonly Seg[]): number {
  // Joined THEN trimmed, never per segment: the padding inside a row is real width, and only what
  // trails the last cell is the padding `composeLine` drops.
  return segs.map(s => s.text).join('').replace(/\s+$/, '').length
}

const GAP = '  '

/** One level of the cascade, the same two columns the cockpit's list spends. */
const HEADING_INDENT = '  '

/** The header row — the same cells, from the same measured widths, so a heading can never sit over
 *  a column it no longer names. */
function headerSegs(
  c: SessionColumns,
  words: Record<keyof SessionColumns, string>,
  notify: number,
): Seg[] {
  const segs: Seg[] = [{ text: GAP + ' '.repeat(notify) }]
  if (c.id > 0) segs.push({ text: padCell(words.id, c.id) + GAP, code: DIM })
  segs.push({ text: padCell(words.state, c.state), code: DIM })
  const rest: Array<[number, string]> = [
    [c.title, words.title],
    [c.worktree, words.worktree],
    [c.task, words.task],
    [c.metrics, words.metrics],
    [c.context, words.context],
    [c.harness, words.harness],
    [c.where, words.where],
  ]
  for (const [w, word] of rest) {
    if (w > 0) segs.push({ text: GAP + padCell(word, w), code: DIM })
  }
  return segs
}

/**
 * A section heading: its name, how many rows are under it, and a rule out to the edge.
 *
 * The rule is what makes the sections visible in a wall of scrollback. A heading dimmed to the same
 * weight as its rows is not a hierarchy — it is a list that happens to be sorted.
 */
function headingSegs(label: string, count: number, width: number, muted?: boolean): Seg[] {
  const head = `${label}  ${count}`
  const rule = Math.max(0, width - head.length - 3)
  return [
    { text: head, code: muted ? DIM : CYAN },
    ...(rule > 0 ? [{ text: `${GAP}${'─'.repeat(rule)}`, code: DIM }] : []),
  ]
}

/** One session row. The cell order and the give-up order are `sessionColumns`', not this module's. */
function rowSegs(s: ControlSession, c: SessionColumns, notify: number): Seg[] {
  // Two columns where the cockpit draws its cursor and its mark. Kept rather than reclaimed: it is
  // what `sessionColumns` budgets for, and it is what leaves the rows indented under their heading.
  const segs: Seg[] = [{ text: GAP }]
  // The same NOTIFICATION cell the cockpit draws, for the same reason and out of the same measure:
  // one table, two renderers, and a dot that existed in only one of them would make `session ls`
  // and the screen disagree about which rows are asking for something.
  if (notify > 0) {
    segs.push(sessionNotify(s)
      ? { text: '● ', code: STATE_ANSI[s.state] }
      : { text: ' '.repeat(notify) })
  }
  if (c.id > 0) segs.push({ text: padCell(sessionHandle(s), c.id) + GAP, code: DIM })
  segs.push({ text: padCell(s.stateLabel, c.state), code: STATE_ANSI[s.state] })
  if (c.title > 0) segs.push({ text: GAP + padCell(s.title, c.title) })
  if (c.worktree > 0) segs.push({ text: GAP + padCell(worktreeName(s), c.worktree), code: DIM })
  if (c.task > 0) segs.push({ text: GAP + padCell(s.task ?? '', c.task), code: DIM })
  if (c.metrics > 0) segs.push({ text: GAP + padCell(sessionMetric(s), c.metrics), code: DIM })
  if (c.context > 0) {
    // A row with no reading still pays its column, so the ones that DO have a gauge stay aligned —
    // `padCell('')` is the blank, and a blank is the honest rendering of "cannot be known".
    segs.push({
      text: GAP + padCell(sessionContext(s), c.context),
      code: s.context ? CONTEXT_ANSI[contextLevel(s.context.fraction)] : DIM,
    })
  }
  if (c.harness > 0) segs.push({ text: GAP + padCell(s.harness, c.harness), code: CYAN })
  if (c.where > 0) {
    segs.push({ text: GAP + padCell(s.projectGroup || s.project, c.where), code: DIM })
  }
  return segs
}
