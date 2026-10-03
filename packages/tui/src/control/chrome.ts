/**
 * chrome.ts — PURE layout arithmetic for the control center's persistent chrome.
 *
 * The header, the tab bar with its rule, and the footer are on screen no matter which screen is
 * open, which makes them the rows most likely to wrap and shear the whole frame. Every width
 * decision they make lives here, against plain strings, so the collapse thresholds are derived
 * from the measured text rather than from a magic column count — and so they can be tested without
 * mounting Ink.
 */

import type { ControlService, TabId } from './types'
import type { PaneId } from './nav'
import type { ControlStrings } from './i18n'
import type { CliLang } from './lang'
// Type-only, and therefore erased: `hit.ts` imports this module's values, so a runtime import back
// would be a cycle. The rectangle is a hit-testing concept and belongs there; what belongs HERE is
// the function that turns a `CockpitLayout` into one, beside the function that produced the layout.
import type { Rect } from './hit'
import { truncate } from '../components/Primitives'
// The SAME bar the session rows draw for the context window. One gauge shape per application: two
// drawn differently read as two different kinds of measurement.
import { contextBar } from './sessions'
import { MARK_WIDTH, WORDMARK_ART, WORDMARK_WIDTH } from '../components/Wordmark'

export interface TabSpec {
  id: TabId
  label: string
}

export interface TabCell extends TabSpec {
  active: boolean
  /** Cell width including the one-space padding on each side; the underline matches it. */
  width: number
}

/**
 * What the strip should draw. A discriminated union rather than a bag of flags so the component
 * has no layout decision left to make: it renders one branch or the other.
 */
export type TabStripLayout =
  | { kind: 'full'; cells: TabCell[] }
  | { kind: 'collapsed'; id: TabId; label: string; hasPrev: boolean; hasNext: boolean }

/** One space either side of the label, so the active cell's underline has room to breathe. */
const CELL_PAD = 2
/** Columns between two cells. */
const CELL_GAP = 1
/** The rule drawn under the active cell. Heavy, so it reads as an underline and not as a border. */
const TAB_RULE = '━'

/** `‹ ` + label + ` ›` — the collapsed form's fixed overhead. */
const AFFORDANCE = 4

/**
 * The strip's real width. Every cell carries its gap, including the last one — counting `n - 1`
 * gaps overstates the room by a column, and at exactly that width Yoga takes it back out of an
 * interior gap, so the rhythm of the whole row visibly breaks at one terminal size per language.
 */
export function tabStripWidth(tabs: TabSpec[]): number {
  if (tabs.length === 0) return 0
  return tabs.reduce((n, t) => n + t.label.length + CELL_PAD + CELL_GAP, 0)
}

/**
 * The full strip when it fits, otherwise the active tab alone with `‹ ›` affordances.
 *
 * The threshold is the strip's own measured width, not a hardcoded column count: the six tab
 * names are translated, and the Portuguese set is longer than the English one, so a fixed 60
 * would collapse one language too early and wrap the other.
 *
 * The strip sits at the TOP now, which is what turned it from a legend into navigation: the reading
 * order is title, where-am-I, content, keys. It also cost the digits their only documentation, and
 * the digits went with them — screens move on `←`/`→` alone, which is why nothing here numbers a
 * cell any more.
 */
export function fitTabs(tabs: TabSpec[], active: TabId, width: number): TabStripLayout {
  if (tabs.length === 0) return { kind: 'full', cells: [] }

  if (tabStripWidth(tabs) <= width) {
    return {
      kind: 'full',
      cells: tabs.map(t => ({
        ...t,
        active: t.id === active,
        width: t.label.length + CELL_PAD,
      })),
    }
  }

  // An unknown active id would leave the strip nameless, which reads as a broken frame; fall back
  // to the first tab so something is always labelled.
  const i = Math.max(0, tabs.findIndex(t => t.id === active))
  const tab = tabs[i]!

  return {
    kind: 'collapsed',
    id: tab.id,
    label: truncate(tab.label, Math.max(1, width - AFFORDANCE)),
    // Positional, not wrapping: the arrows say where you are in the strip. Navigation still
    // wraps — the affordance is orientation, not a disabled control.
    hasPrev: i > 0,
    hasNext: i < tabs.length - 1,
  }
}

/**
 * The accent rule under the active tab, as one row of the same width as the strip.
 *
 * A row of its own rather than the terminal's `underline` attribute: the attribute is the first
 * thing a multiplexer or a minimal terminfo drops, and "which screen am I on" is not something this
 * frame may say only when the terminal feels like it. Spaces elsewhere, so the whole row can be
 * drawn as ONE accent-colored string — a space has no color to get wrong.
 *
 * The guarantee: the run starts and ends exactly where the active cell does, which is why the cell
 * widths come from `fitTabs` rather than being measured a second time here.
 */
export function tabUnderline(layout: TabStripLayout): string {
  if (layout.kind === 'collapsed') {
    // `‹ ` is two columns before the label; the affordances themselves are not underlined.
    return ' '.repeat(2) + TAB_RULE.repeat(layout.label.length)
  }
  return layout.cells
    .map(cell => (cell.active ? TAB_RULE : ' ').repeat(cell.width) + ' '.repeat(CELL_GAP))
    .join('')
}

/**
 * What a column of the tab strip belongs to.
 *
 * `prev`/`next` exist only in the collapsed form, where the strip is one name between `‹` and `›`.
 * Those arrows are the only orientation a narrow terminal has, and a pointer that could not use them
 * would be reading a control the keyboard can work and the mouse cannot.
 */
export type TabHit =
  | { kind: 'tab'; id: TabId }
  | { kind: 'prev' }
  | { kind: 'next' }
  | null

/**
 * Which tab a column of the strip belongs to — resolved from the SAME layout that was drawn.
 *
 * `fitTabs` already decided the cell widths, so this is arithmetic on its answer rather than a
 * second measurement of the labels: a hit test that re-measured would agree today and drift the
 * first time a cell's padding changed, and the failure mode is a click that switches to the tab
 * beside the one under the pointer.
 *
 * The trailing gap after each cell belongs to that cell. It is one column of air between two names,
 * and refusing it would leave a dead stripe down a bar whose whole job is to be pointed at.
 */
export function tabAtColumn(layout: TabStripLayout, x: number): TabHit {
  if (x < 0) return null

  if (layout.kind === 'collapsed') {
    // `‹ ` + label + ` ›` — the affordances are two columns each, and each is live only when the
    // strip actually drew it.
    if (x < 2) return layout.hasPrev ? { kind: 'prev' } : null
    if (x < 2 + layout.label.length) return { kind: 'tab', id: layout.id }
    if (x < 2 + layout.label.length + 2) return layout.hasNext ? { kind: 'next' } : null
    return null
  }

  let left = 0
  for (const cell of layout.cells) {
    left += cell.width + CELL_GAP
    if (x < left) return { kind: 'tab', id: cell.id }
  }
  return null
}

/** The separator between the header's own runs, and between a detail pane's facts. */
const SEP = ' · '

// ---------------------------------------------------------------------------
// header meta — the right-hand end of the one-row header
// ---------------------------------------------------------------------------

export interface HeaderMetaInput {
  /** The SHORT mode token — `solo` / `central` / `member`, never the sentence. */
  mode: string
  version: string
  latestVersion?: string
  /**
   * How many sessions are waiting on a person, or 0.
   *
   * It lives in the HEADER because it is the one fact that must be readable from a tab that is not
   * the sessions screen — a counter you have to navigate to in order to see is a counter that
   * cannot tell you to navigate there.
   */
  attention?: number
  /**
   * Which language the counter's WORDS are in (`● 2 need you` / `● 2 precisam de você`). Absent reads
   * as English, the CLI's default — the counter is the one piece of the tag that is a sentence.
   */
  lang?: CliLang
  /**
   * How many assistants are up out of how many this MACHINE can hold, when it could be measured.
   *
   * Absent means nobody could read the memory (not Linux, no `/proc`) and the gauge is simply not
   * drawn. `red` is decided by the host, from the distance to the ceiling and from swap pressure —
   * the TUI owns no logic, here as everywhere.
   */
  memory?: { used: number; max: number; red: boolean; percent: number }
  /** What this machine is called on its central, when it has one. */
  machineName?: string
  /**
   * Which ACCOUNT that central knows it under.
   *
   * Beside the name because they answer different halves of one question: two machines can be
   * called `laptop` on two centrals, and the account is what says whose fleet this row belongs to.
   * Absent on a machine that is not connected — and then nothing here is drawn at all.
   */
  accountName?: string
  /**
   * Whether the link is WORKING, as the host decided it — never derived here.
   *
   * A name and a latency say a connection was configured and once answered; they cannot say it is
   * alive now. This is the dot beside them, and it is the only part of the cell that carries a
   * colour, on the same rule the rest of the app follows: the state is also said in the numbers
   * (`ms`) and in words in the config pane, so colour never carries the message alone.
   */
  linkState?: CentralLinkState
  /** Round trip of the last successful push, ms. */
  pushMs?: number
  width: number
}

/**
 * What the central link is DOING — decided by the host, drawn here.
 *
 * `stale` is its own answer rather than folded into `offline`: a member whose last push is old has
 * not failed at anything (the central owns the cadence and may simply be quiet), and reporting that
 * as a broken connection is the false alarm that teaches people to ignore the dot.
 */
export type CentralLinkState = 'ok' | 'stale' | 'offline' | 'unauthorized'

/**
 * `text` is the dim run; `alert` and `update` are the accent-colored ones, empty when there is
 * nothing to say. Split rather than pre-joined because the coloured pieces cannot be coloured inside
 * a string a component was handed whole.
 */
export interface HeaderMeta {
  text: string
  /** The waiting-sessions counter, e.g. `● 2 need you` — or `● 2` once the row is too tight. */
  alert: string
  update: string
  /**
   * The parallel-sessions budget, e.g. `ram 3/17` — how many assistant PROCESSES are up, out of how many this
   * MACHINE can hold. Empty where memory could not be read at all.
   *
   * It answers the question actually asked before opening one, which "10 GB used" does not.
   *
   * It is NAMED rather than drawn as a glyph. `▤ n/m` was chosen so it could not be misread as a
   * session count and it failed at that twice on real machines — the two numbers legitimately
   * differ, because this one counts assistant PROCESSES and the sessions list counts ROWS after its
   * filter, and only the label can say so.
   */
  memory: string
  /** True when the budget is inside its warning distance — the caller colours it. */
  memoryRed?: boolean
  /**
   * How full the machine is, as a LEVEL — what the caller colours the bar by.
   *
   * Separate from `memoryRed`, which is the SESSION budget's alarm ("no room for another
   * assistant"). A machine can be at 95% with room for three more sessions, and it can have room
   * for none while sitting at 40% because the sessions running are enormous. Two facts, two
   * colours, and collapsing them would make one of the two lie.
   */
  memoryLevel?: 'ok' | 'warn' | 'full'
  /**
   * The machine's name on its central, and the last push's round trip.
   *
   * One cell, because they are one fact: WHICH machine this is and whether its link is alive.
   * Split in two they would compete for the same corner and drop independently, leaving a latency
   * belonging to no named machine.
   */
  machine: string
  /** The link's state, when there is a link — what the caller colours the dot by. */
  machineState?: CentralLinkState
}

/** What the pieces cost together, separators included — the number the caller budgets against. */
/**
 * Columns the load bar takes. Short on purpose: it shares a row with the mode, the version, the
 * machine, the waiting counter and the update notice, and every column it takes is one of theirs.
 * Eight is enough to read a half from a quarter at a glance, which is all a bar has to do.
 */
export const LOAD_BAR = 8

/** How full the machine is, as a bar — the same shape the context gauge uses. */
export function loadBar(percent: number): string {
  return contextBar(Math.max(0, Math.min(100, percent)) / 100, LOAD_BAR)
}

/**
 * What the bar is SAYING, so the caller can colour it — the same three-level vocabulary the context
 * gauge uses, and for the same reason: a machine at 90% and a context window at 90% are the same
 * warning to the person reading them.
 *
 * The thresholds are the memory's own, not the context window's. A context window at 80% is worth
 * noticing; a machine at 80% is already slow, and one at 90% is minutes from swapping.
 */
export const LOAD_WARN = 75
export const LOAD_HIGH = 90

export function loadLevel(percent: number): 'ok' | 'warn' | 'full' {
  if (percent >= LOAD_HIGH) return 'full'
  if (percent >= LOAD_WARN) return 'warn'
  return 'ok'
}

/** The dot and its space, charged to the machine cell whenever one is drawn. */
export const LINK_DOT = 2

export function headerMetaWidth(meta: HeaderMeta): number {
  return meta.text.length
    + (meta.machine ? SEP.length + LINK_DOT + meta.machine.length : 0)
    + (meta.alert ? SEP.length + meta.alert.length : 0)
    + (meta.memory ? SEP.length + meta.memory.length : 0)
    + (meta.update ? SEP.length + meta.update.length : 0)
}

/**
 * The attention counter's words — `● 2 need you`, `● 1 needs you`, `● 2 precisam de você` — PURE.
 *
 * It counts every row that needs a PERSON (an approval and a plain "needs you" alike) across the
 * fleet plus the native session's open questions, and it is a SENTENCE rather than a glyph and a
 * digit because it is the one thing on the header a user is meant to act on: `⏳ 2` had to be taught
 * before it could be read. Plural-correct in both languages. Empty at zero — a counter that says
 * "0 need you" on every tab of a quiet machine is a light nobody looks at, and absence is the calm
 * state. `compact` is the form it degrades to under width pressure: the number keeps its dot.
 */
export function attentionCell(n: number, lang: CliLang, compact = false): string {
  if (!(n > 0)) return ''
  if (compact) return `● ${n}`
  if (lang === 'pt') return `● ${n} ${n === 1 ? 'precisa' : 'precisam'} de você`
  return `● ${n} ${n === 1 ? 'needs' : 'need'} you`
}

/**
 * Whether a change in a waiting count RINGS — PURE (GL-02). The bell is for the TRANSITION from
 * nothing waiting to something waiting, never for the level: a count that stays at 1 while a
 * question goes unanswered would otherwise beep on every report, and one that goes 2 → 1 is a
 * person having answered, not a new thing to answer.
 */
export function attentionRings(prev: number, next: number): boolean {
  return prev <= 0 && next > 0
}

/**
 * The header's right-hand tag: mode, version, and the update dot.
 *
 * The mode SENTENCE used to live here and blew the row apart in member mode — "member — sends
 * metrics to a central · http://198.51.100.199:48080" is a paragraph, not a tag. Only the short
 * token survives; the sentence and the endpoint moved to the config pane, which has rows to spare.
 *
 * Under width pressure the pieces drop from the right, LEAST ACTIONABLE FIRST: the update notice,
 * then the version, then the waiting counter. The mode token is the last thing standing because it
 * is the only one that says WHICH machine you are looking at.
 *
 * The counter outranks the version deliberately. A version you cannot see is one `agentop --version`
 * away and changes once a month; a session waiting on you is the reason this application is open,
 * and it is the piece that must survive a narrow terminal.
 */
export function headerMeta(input: HeaderMetaInput): HeaderMeta {
  const {
    mode, version, latestVersion, attention, memory,
    machineName, accountName, linkState, pushMs, width,
  } = input
  if (width <= 0) return { text: '', machine: '', alert: '', update: '', memory: '' }

  const outdated = Boolean(latestVersion && latestVersion !== version)
  const text = version ? `${mode}${SEP}v${version}` : mode
  const n = attention && attention > 0 ? attention : 0
  const alert = attentionCell(n, input.lang ?? 'en')
  // The same count without its words — what the counter degrades to before it is given up at all.
  const alertShort = attentionCell(n, input.lang ?? 'en', true)
  const update = outdated ? `● ${latestVersion}` : ''
  // Absent memory renders nothing at all — a machine whose `/proc` cannot be read shows no gauge
  // rather than a zero, the same rule the boot row and the harness capabilities follow.
  //
  // NAMED `ram`, not drawn as a bare `▤`. The glyph was chosen so the pair could not be misread as
  // a session count, and it did not work: reported twice from real machines, once as `▤ 4/18` over
  // a list of 4 rows and once as `▤ 5/…` over a list of 3. The two numbers legitimately differ —
  // this side counts assistant PROCESSES (a background agent sharing its parent's directory is one
  // process and no row of its own) while the list counts ROWS after its filter — so no arithmetic
  // fix is available or wanted. What was missing is that the gauge never said what it measures. A
  // word costs one column over the glyph and is the same in both languages.
  // Sessions AND load, because they answer different questions: `3/17` is how many more assistants
  // fit, `62%` is how hard the box is already working — a machine at 90% for reasons unrelated to
  // agentop reads comfortable on the ratio alone. Reported as missing after the first pass.
  // A BAR, like htop, because a bare `62%` does not say what is 62% full. The shape is what gets
  // read at a glance and the number is what gets acted on, so both are drawn — and the bar is the
  // SAME `contextBar` the session rows use for the context window rather than a second one: two
  // gauges drawn differently in one application read as two different kinds of measurement.
  const mem = memory
    ? `ram ${loadBar(memory.percent)} ${memory.percent}% · ${memory.used}/${memory.max}`
    : ''
  const red = memory?.red === true
  // Which machine this is, and whether its link is alive. Two SSH'd terminals running identical
  // cockpits are otherwise indistinguishable — the name already existed and was simply never shown.
  // WHICH machine, on WHOSE account, and how fast it last answered — one cell, because they are one
  // fact and split apart they would drop independently, leaving a latency belonging to no named
  // machine. Drawn only when there IS a central: on a solo box every piece of this is absent, and a
  // dot with nothing to say about a connection that does not exist is worse than no dot.
  // Gated on LINKSTATE, not on `machineName`: the central resolves the name from `whoami`, and a
  // token whose central never returned one (or an older central that predates the field) leaves
  // `machineName` absent while `accountName`, `linkState` and `pushMs` are all real — gating on the
  // name dropped the whole cell, dot included, over one missing piece of a fact otherwise known.
  // `linkState` is the right presence signal because it is set (in `cli-start.ts`) exactly when
  // there IS a connection, independent of whether that connection could be named.
  const machine = linkState !== undefined
    ? [machineName, accountName, pushMs !== undefined ? `${pushMs}ms` : '']
        .filter(Boolean).join(' · ')
    : ''

  const level = memory ? loadLevel(memory.percent) : undefined
  const linked = linkState !== undefined ? { machineState: linkState } : {}
  const full = {
    text, machine, alert, update, memory: mem, memoryRed: red, ...linked,
    ...(level ? { memoryLevel: level } : {}),
  }
  if (headerMetaWidth(full) <= width) return full

  // Dropped least-actionable first, exactly as before. The budget sits between the update notice
  // and the version: it is more actionable than "there is a new release" and less than the waiting
  // counter, which stays the last thing standing after the mode token.
  const withoutUpdate = { ...full, update: '' }
  if (headerMetaWidth(withoutUpdate) <= width) return withoutUpdate

  // …unless it is RED. A budget about to run out is the most actionable thing on the row, so it
  // outranks the version and keeps its place — dropping the warning to keep a version number would
  // be the wrong trade at exactly the moment it matters.
  const withoutMemory = { ...full, update: '', memory: red ? mem : '' }
  if (headerMetaWidth(withoutMemory) <= width) return withoutMemory

  // The version goes before the machine NAME: a version is one `agentop --version` away, while the
  // name is the answer to "which box am I looking at" — the whole reason it is on the row, and
  // unanswerable from anywhere else in a terminal SSH'd into somewhere.
  const withoutVersion = { text: mode, machine, alert, update: '', memory: red ? mem : '', memoryRed: red, ...linked, ...(level ? { memoryLevel: level } : {}) }
  if (headerMetaWidth(withoutVersion) <= width) return withoutVersion

  // Then the ACCOUNT and the latency, keeping the bare name and its dot. Knowing WHICH machine, and
  // whether its link is alive, both survive longer than knowing whose account it is or how fast it
  // answered — the dot is one column and is the only part of the cell that is a warning.
  const bareName = machineName ?? ''
  const withoutLatency = { text: mode, machine: bareName, alert, update: '', memory: red ? mem : '', memoryRed: red, ...linked, ...(level ? { memoryLevel: level } : {}) }
  if (headerMetaWidth(withoutLatency) <= width) return withoutLatency

  const modeAndAlert = { text: mode, machine: '', alert, update: '', memory: '' }
  if (headerMetaWidth(modeAndAlert) <= width) return modeAndAlert

  // The WORDS go before the number: `● 2` still says that two things need you, and it is the last
  // form the counter takes before the mode token is all that is left.
  const modeAndCount = { text: mode, machine: '', alert: alertShort, update: '', memory: '' }
  if (headerMetaWidth(modeAndCount) <= width) return modeAndCount

  if (mode.length <= width) return { text: mode, machine: '', alert: '', update: '', memory: '' }
  return { text: truncate(mode, width), machine: '', alert: '', update: '', memory: '' }
}

// ---------------------------------------------------------------------------
// the header itself — block art, or the one-line mark
// ---------------------------------------------------------------------------

/**
 * Columns between the art and the meta. Two, so the two runs read as two things: at one column the
 * version looks like the last letter of the wordmark.
 */
export const HEADER_GAP = 2

/** The widest row of a block of art — what the header has to reserve to draw it. */
export function artWidth(art: readonly string[]): number {
  return art.reduce((n, line) => Math.max(n, line.length), 0)
}

/**
 * What the header draws, and how many rows it costs.
 *
 * A discriminated union rather than a flag, so `Header` renders one branch or the other and holds
 * no decision of its own — and `rows` is on it because the SHELL has to budget the body against a
 * header whose height is not a constant.
 */
export type HeaderLayout =
  | { kind: 'art'; art: readonly string[]; meta: HeaderMeta; rows: number }
  | { kind: 'compact'; meta: HeaderMeta; rows: 1 }

/**
 * The block wordmark when the row can carry it AND everything the meta has to say, the one-line
 * mark otherwise.
 *
 * THE THRESHOLD IS MEASURED, never written down: the art is `artWidth(WORDMARK_ART)` columns and
 * the meta is `headerMetaWidth` of the tag this machine actually produces — a mode word that is
 * `solo` or `member`, a version whose digits grow, and an update dot that only exists while there
 * is an update. A hardcoded 68 would be right for one of those combinations and wrong for the rest.
 *
 * The rule is deliberately all-or-nothing: the art costs a ROW as well as 38 columns, so it is only
 * worth taking when the meta beside it is complete. Below that the header degrades to the compact
 * mark — one row, and the meta fitted against what the mark leaves — rather than wrapping the art,
 * which shears every row under it.
 *
 * The meta shares the LAST line of the art, which is the one change from the original banner. It
 * used to be three right-aligned lines beside two lines of art, on no shared baseline at all, and
 * that is what made the old header read as two things that had been placed near each other.
 */
export function headerLayout(input: HeaderMetaInput): HeaderLayout {
  const art = WORDMARK_ART
  // The meta as it would read with nothing in its way. Measuring the FULL form is the point: the
  // art branch has to be affordable at the tag's real width, not at whatever a squeezed one shrank
  // to — otherwise the header would take the art and then quietly drop the version to pay for it.
  const full = headerMeta({ ...input, width: Number.MAX_SAFE_INTEGER })
  if (input.width >= artWidth(art) + HEADER_GAP + headerMetaWidth(full)) {
    return { kind: 'art', art, meta: full, rows: art.length }
  }
  // The mark's columns are RESERVED before the tag is fitted — see `Header`. Without that the tag
  // took the whole row in Portuguese member mode and the title named a version and no application.
  return { kind: 'compact', meta: headerMeta({ ...input, width: Math.max(0, input.width - 1 - MARK_WIDTH) }), rows: 1 }
}

/** The columns the art reserves — exported for the tests that pin the threshold to the artwork. */
export const HEADER_ART_WIDTH = WORDMARK_WIDTH

// ---------------------------------------------------------------------------
// panes
// ---------------------------------------------------------------------------

/**
 * A pane's frame cost: a border column on each side plus one column of padding inside each.
 * Content that is not held off the border by a space reads as if it were part of it.
 */
export const PANE_FRAME_X = 4
/** The titled top row and the bottom border. */
export const PANE_FRAME_Y = 2
/** A pane below this cannot show a single row of content, so it is not worth framing. */
export const PANE_MIN_ROWS = PANE_FRAME_Y + 1

export const paneInnerWidth = (width: number): number => Math.max(0, width - PANE_FRAME_X)
export const paneInnerHeight = (height: number): number => Math.max(0, height - PANE_FRAME_Y)

/**
 * The pieces of a pane's titled top border, in drawing order.
 *
 * Returned as parts rather than as one string because they are three different colors — the rule is
 * the border, the title is accent or dim depending on focus, and the badge is always dim. The
 * guarantee is that concatenating them is EXACTLY `width` columns: a top border one cell out is
 * visible on every pane at once and reads as a broken renderer rather than as a rounding error.
 */
export interface PaneTop {
  /** `╭─ `, or a bare `╭` on a pane too narrow for a title. */
  head: string
  title: string
  /** The rule between the title and the badge, with the spaces that separate them. */
  gap: string
  badge: string
  /** The closing `╮`, with the space in front of a badge. */
  tail: string
}

/** `╭─ ` + title + ` ` + rule + ` ` + badge + ` ` + `╮`. */
const TOP_OVERHEAD = 5
/** Below this a title would leave no rule at all, and the pane would read as a broken box. */
const TOP_MIN = TOP_OVERHEAD + 2

export function paneTop(title: string, badge: string, width: number): PaneTop {
  const empty: PaneTop = { head: '', title: '', gap: '', badge: '', tail: '' }
  if (width <= 0) return empty
  if (width < TOP_MIN) {
    // Still a box, just an anonymous one. The pane's contents say what it is at this size.
    return { ...empty, head: '╭' + '─'.repeat(Math.max(0, width - 2)), tail: width >= 2 ? '╮' : '' }
  }

  const budget = width - TOP_OVERHEAD
  // The TITLE is served first and the badge takes what is left, whole or not at all. The badge is a
  // status the pane's own rows repeat (`following`, the runtimes it is running under), while the
  // title is the only thing naming the pane — and a badge that grew, as the detail pane's did when
  // it started naming BOTH runtimes of a conflict, must not be able to turn `agentistics` into
  // `agentist…`. Whole or nothing for the same reason the state cell works that way: `nativ…` is
  // not a terser badge, it is a badge that has stopped answering.
  const shownTitle = truncate(title, Math.max(1, budget - 1))
  const room = budget - shownTitle.length
  const shownBadge = badge && badge.length + 3 <= room ? badge : ''
  const badgeCost = shownBadge ? shownBadge.length + 2 : 0
  const fill = budget - shownTitle.length - badgeCost

  return {
    head: '╭─ ',
    title: shownTitle,
    gap: ' ' + '─'.repeat(Math.max(0, fill)) + (shownBadge ? ' ' : ''),
    badge: shownBadge,
    tail: (shownBadge ? ' ' : '') + '╮',
  }
}

/**
 * The widest badge `paneTop` will actually DRAW beside this title — PURE.
 *
 * Its rule is whole-or-nothing, which is right for a badge the pane's rows repeat and wrong for one
 * that is the only place a fact appears: a card's group would simply disappear on a narrow card,
 * and a card that does not say which project it belongs to is the feature not working. A caller
 * with such a badge truncates it against this rather than guessing at the frame's overhead.
 */
export function paneBadgeRoom(title: string, width: number): number {
  if (width < TOP_MIN) return 0
  const budget = width - TOP_OVERHEAD
  const shownTitle = truncate(title, Math.max(1, budget - 1))
  return Math.max(0, budget - shownTitle.length - 3)
}

/**
 * The widest TITLE that still leaves `paneTop` room to draw this badge — PURE, and the inverse of
 * `paneBadgeRoom`.
 *
 * `paneTop` serves the title first and then keeps the badge whole or not at all, which is right when
 * the badge repeats something the pane's rows already say and wrong when the badge is the only place
 * a fact appears. A card puts the session HANDLE there — the prefix `agentop session attach 3f5f`
 * resolves, and the one thing on the card naming the session to anything outside this screen — so a
 * long project name in the title must be cut to make room for it, rather than silently taking it.
 */
export function paneTitleRoom(badge: string, width: number): number {
  if (width < TOP_MIN) return 0
  const budget = width - TOP_OVERHEAD
  const whole = Math.max(1, budget - 1)
  return badge === '' ? whole : Math.max(1, Math.min(whole, budget - badge.length - 3))
}

// ---------------------------------------------------------------------------
// row cells shared by the two band panes
//
// Declared before the geometry because the geometry's column FLOORS are these numbers added up —
// a module-level const cannot reference one declared below it.
// ---------------------------------------------------------------------------

/** `❯ ` — reserved on every row, so the list does not shift sideways as the cursor moves. */
export const SERVICE_MARKER = 2

/** Below this a config value is a stub — "m…" answers nothing, and the row would be a label alone. */
const CONFIG_VALUE_MIN = 4
/** Below this a config label stops naming the setting, and the row is two stubs instead of one. */
const CONFIG_LABEL_MIN = 4

// ---------------------------------------------------------------------------
// the cockpit's geometry
// ---------------------------------------------------------------------------

/** What each pane would like, measured from the rows the caller is about to draw. */
export interface CockpitContent {
  /**
   * The services list's ideal width: the marker plus each CELL measured across the whole list —
   * the widest label, the widest runtime, the widest state.
   *
   * Per column rather than per row, because that is how `serviceCells` lays it out. The state is
   * measured as it will be DRAWN (glyph and word) rather than as the glyph alone: those two words
   * are the difference between a list that says `stopped` and one that says `○`, and it is bounded
   * — only a service that is genuinely undetectable widens it, and `SERVICES_MAX_SHARE` is the
   * ceiling either way.
   */
  services: number
  /** Widest config row with each value in its SHORT form — the long one is opportunistic. */
  config: number
  /** How many content rows each pane would use with nothing in its way. */
  serviceRows: number
  configRows: number
  detailRows: number
}

/** Rows per pane INCLUDING its frame. `0` means the pane is not drawn at all. */
export interface CockpitHeights {
  services: number
  config: number
  detail: number
}

export interface CockpitLayout {
  /**
   * `columns` is the cockpit proper; `stacked` is the short-and-narrow fallback, one pane per row
   * band; `single` is a NARROW terminal (D-TUI-10) — one pane over the whole body, under a one-line
   * strip naming the panes, and `tab` walks between them.
   */
  kind: 'columns' | 'stacked' | 'single'
  /** `single` only: which pane is drawn. */
  shown?: SinglePane
  /** `single` only: rows the pane strip takes above the pane — 1, or 0 on a one-row body. */
  strip?: number
  /** The services pane's width — the left half of the BAND. */
  leftWidth: number
  /** The config pane's width — the right half of the band. Equal to `leftWidth` when stacked. */
  rightWidth: number
  /**
   * Rows for the two panes of the BAND (services, config) plus the detail pane.
   *
   * The detail pane is drawn at the FULL width under the band — see `cockpitLayout` — so its width
   * is `leftWidth + rightWidth`, which is the terminal.
   */
  heights: CockpitHeights
}

export interface CockpitOptions {
  /**
   * Something OTHER than the detail pane owns the detail region — a question, or the output of a
   * task that is streaming into it.
   *
   * The region is then reserved `QUESTION_ROWS` before the band gets its own, because neither one's
   * height comes from the service it is about: a question's comes from the sentence it asks and the
   * answers it offers, and a build's output is as long as the build. `cockpitLayout` can see none of
   * that, so it reserves the tallest thing that can land there.
   */
  question?: boolean
  /**
   * The terminal is NARROW (`narrowTerminal`): draw ONE pane, this one, over the whole body. A
   * question or a task still owns the detail region, so `question` wins and the detail is drawn.
   */
  single?: SinglePane
}

/**
 * Below this many columns of body the cockpits show ONE pane at a time (D-TUI-10).
 *
 * Measured against the SAME width the `code` tab measures its own narrow mode against (the shell's
 * body width, `CODE_WIDE_AT`), so every screen of the app changes shape at one terminal width rather
 * than each at its own. Three panes squeezed into 80 columns is two columns of stubs and a detail
 * pane truncating every URL it exists to state; one pane at the full width says all of it, and the
 * strip above it says what else there is and `tab` reaches it.
 */
export const NARROW_WIDTH = 100

export function narrowTerminal(width: number): boolean {
  return width < NARROW_WIDTH
}

/** The panes a narrow cockpit walks between, in reading order. */
export type SinglePane = 'services' | 'config' | 'detail'

/** Rows the pane strip costs — the one line that names the panes a narrow cockpit is not showing. */
export const STRIP_ROWS = 1

/** One name on the pane strip, and where it starts (for the pointer). */
export interface StripCell {
  label: string
  active: boolean
  x: number
}

export const STRIP_SEP = ' · '

/**
 * The narrow cockpit's pane strip — `services · config · detail` with the shown one marked — PURE.
 *
 * It is what keeps a one-pane screen from being a screen that hides two thirds of itself: the panes
 * that are not drawn are still NAMED, in the order `tab` walks them. It starts one column in so it
 * lines up with the pane titles under it. When the names cannot all fit, only the shown one is kept
 * — the one fact that has to survive is which pane this is.
 */
export function paneStrip(labels: readonly string[], active: number, width: number): StripCell[] {
  const cells: StripCell[] = []
  let x = 1
  labels.forEach((label, i) => {
    if (i > 0) x += STRIP_SEP.length
    cells.push({ label, active: i === active, x })
    x += label.length
  })
  if (x <= width) return cells
  const only = labels[active] ?? ''
  return [{ label: truncate(only, Math.max(0, width - 1)), active: true, x: 1 }]
}

/** Which strip name a column lands on, or `-1`. */
export function stripAt(cells: readonly StripCell[], labels: readonly string[], x: number): number {
  for (const c of cells) {
    if (x >= c.x && x < c.x + c.label.length) return labels.indexOf(c.label)
  }
  return -1
}

/**
 * Rows a question needs, frame included: the sentence, a blank, and the three archive options with
 * their hints — the tallest question the cockpit asks. Reserved rather than measured because the
 * layout is decided before the question is drawn, and a question composited over a pane border is
 * the one failure this file exists to prevent.
 */
export const QUESTION_ROWS = 12

/** `❯ ` plus a label short enough to still name a service, plus one glyph of state. */
const SERVICES_FLOOR = 2 + 8 + 2
export const LEFT_MIN = SERVICES_FLOOR + PANE_FRAME_X
/**
 * `❯ ` plus a label and a value that both still say something — the config row's own floor.
 *
 * It is `configCells`' two minimums stated once: below this the pane is a column of labels pointing
 * at stubs, which is what the stacked fallback exists to avoid.
 */
const CONFIG_FLOOR = SERVICE_MARKER + CONFIG_LABEL_MIN + 1 + CONFIG_VALUE_MIN
export const RIGHT_MIN = CONFIG_FLOOR + PANE_FRAME_X
/**
 * Past this share the services list starves the config pane beside it. It is a share rather than a
 * column count because both columns' content is translated and the Portuguese words are longer.
 *
 * It only ever binds on a narrow terminal — a wide one is settled by the measured ideal long before
 * the share does anything, and the SURPLUS goes to the config pane, which is the one that can spend
 * it: `fitValue` shows the mode sentence and the whole endpoint URL as soon as the column can hold
 * them whole.
 */
export const LEFT_MAX_SHARE = 0.55
/** Below this the two columns cannot both say anything, and the layout stacks instead. */
export const COCKPIT_MIN_WIDTH = LEFT_MIN + RIGHT_MIN

/**
 * Divides the body between the three panes.
 *
 * THE INVARIANT: nothing ever EXCEEDS `height`, and nothing is left dead inside it. Ink does not
 * clip an overflowing child, it composites it — two rows land on the same line and the screen reads
 * as corrupted rather than as cramped — so a region that asks for one row too many is not a
 * cosmetic bug; and a region nobody asked for is the complaint that produced this shape.
 *
 * THE SHAPE — a band over a full-width detail pane:
 *
 *     ╭─ services ─────────╮╭─ config ─────────────╮   the BAND: two columns, equal height,
 *     ╰────────────────────╯╰──────────────────────╯   both content-sized
 *     ╭─ agentistics ───────────────────────────────╮  everything under it, full width
 *     │                                             │
 *     ╰─────────────────────────────────────────────╯
 *
 * The log pane used to be the thing under the band, and taking it away (logs belong to the Logs
 * screen) would have reopened the dead region it was introduced to fill — so the DETAIL pane moved
 * down into it. That is the right pane for the job on three counts: it is the one the enrichment is
 * for (runtimes and why one is unavailable, pid and uptime, the addresses, boot, history, the
 * endpoint), it is the one carrying the verbs, and at the full width its URLs and its reasons stop
 * being truncated by a column that was never wide enough for them.
 *
 * The band is exactly as tall as the TALLER of its two panes wants and no taller, so the surplus
 * belongs to the detail pane rather than sitting under a column as air. What remains is slack
 * INSIDE the detail pane, between its facts and the action row pinned to its floor — air inside a
 * pane is a pane, air under one is a fault.
 *
 * MINIMUM USEFUL HEIGHTS, and the order things give way:
 *
 *  1. Everything drawn: the band, then the detail pane with the rest.
 *  2. The DETAIL pane is served FIRST when the body is short — it holds the verbs, and a cockpit
 *     that can describe a service but not act on it is not a degraded cockpit. So the band is
 *     capped at `height - PANE_MIN_ROWS` (or `height - QUESTION_ROWS` while a question is open) and
 *     the config pane scrolls inside whatever that leaves.
 *  3. Below two frames' worth of body the detail pane goes, whole, and the band takes the rows
 *     back: a two-row box under everything says less than the rows it costs.
 *  4. The SERVICES pane is never dropped. It is the selection that drives the other two, and a
 *     cockpit with nothing selected is not a degraded cockpit but a blank screen; it scrolls its
 *     own rows instead.
 *  5. Width pressure is separate. Below `COCKPIT_MIN_WIDTH` — the two band columns' measured floors
 *     added together, not a round number — neither can say anything, so the layout STACKS:
 *     full-width panes in priority order services, detail, config. That is a deliberate collapse
 *     rather than letting Ink compress two columns into an unreadable pair.
 *  6. Below `PANE_MIN_ROWS` of body there is no room for a frame at all; the services pane comes
 *     back frameless (see `Pane`), which is the last honest thing this screen can be.
 */
export function cockpitLayout(
  width: number,
  height: number,
  content: CockpitContent,
  opts: CockpitOptions = {},
): CockpitLayout {
  if (opts.single) {
    // NARROW: one pane at the full width. A question or a running task owns the detail region, so
    // it is the detail that is drawn while one is up — the keys are going there.
    const strip = height > STRIP_ROWS ? STRIP_ROWS : 0
    const shown: SinglePane = opts.question ? 'detail' : opts.single
    const heights: CockpitHeights = { services: 0, config: 0, detail: 0 }
    heights[shown] = Math.max(1, height - strip)
    return { kind: 'single', shown, strip, leftWidth: width, rightWidth: width, heights }
  }

  const wantServices = content.serviceRows + PANE_FRAME_Y
  const wantConfig = content.configRows + PANE_FRAME_Y
  const wantDetail = content.detailRows + PANE_FRAME_Y

  // The two band panes sit side by side, so the band is as tall as the taller of them.
  const wantBand = Math.max(wantServices, wantConfig)

  const leftIdeal = content.services + PANE_FRAME_X
  // Two ceilings, both derived: a share of the terminal (the words are translated, and the
  // Portuguese ones are longer, so a column count would be wrong in one language), and whatever
  // still leaves the config pane a row it can say something on.
  const cap = Math.min(Math.floor(width * LEFT_MAX_SHARE), Math.max(LEFT_MIN, width - RIGHT_MIN))
  const leftWidth = Math.max(LEFT_MIN, Math.min(leftIdeal, cap))
  const rightWidth = width - leftWidth

  if (width >= COCKPIT_MIN_WIDTH && rightWidth >= RIGHT_MIN && height >= PANE_MIN_ROWS) {
    // The detail region is reserved BEFORE the band is served: it holds the verbs, and while a
    // question is open it holds the question. The band then takes what it wants out of the rest,
    // and the config pane scrolls (`windowOffset`) whenever that is less than its four rows.
    const reserved = opts.question ? Math.max(QUESTION_ROWS, wantDetail) : PANE_MIN_ROWS
    const maxBand = Math.max(PANE_MIN_ROWS, height - reserved)
    let band = Math.min(wantBand, maxBand)
    let detail = height - band
    if (detail < PANE_MIN_ROWS) {
      // Too few rows to frame — and a frame with nothing in it is worse than one pane fewer, so the
      // band takes them back rather than leaving a two-row box under everything.
      band = height
      detail = 0
    }

    return { kind: 'columns', leftWidth, rightWidth, heights: { services: band, config: band, detail } }
  }

  // Stacked: one column, allocated by priority, and the last pane that got any rows keeps the
  // remainder — same no-holes rule, applied down a single column.
  let rest = height
  const take = (want: number): number => {
    if (rest < PANE_MIN_ROWS) return 0
    const got = Math.min(want, rest)
    rest -= got
    return got
  }

  const heights: CockpitHeights = { services: 0, config: 0, detail: 0 }
  heights.services = Math.min(wantServices, Math.max(rest, 0))
  rest -= heights.services
  heights.detail = take(opts.question ? Math.max(QUESTION_ROWS, wantDetail) : wantDetail)
  heights.config = take(wantConfig)

  if (rest > 0) {
    const last = (['detail', 'config', 'services'] as const).find(id => heights[id] > 0)
    if (last) heights[last] += rest
  }

  return { kind: 'stacked', leftWidth: width, rightWidth: width, heights }
}

/** Where the cockpit's three panes actually sit, in body coordinates. `null` = not drawn. */
export interface CockpitRects {
  services: Rect
  config: Rect | null
  detail: Rect | null
}

/**
 * The panes' rectangles, DERIVED from the layout rather than measured a second time.
 *
 * This is the same arrangement `Services` renders and it has to stay that way, so it reads the
 * allocation instead of repeating the reasoning behind it: the band is two columns of equal height
 * (`columns`) or the three panes stacked in the order they are drawn — services, DETAIL, config,
 * which is the render order because the detail pane belongs directly under the selection that drives
 * it. A hit test that assumed the declaration order instead would hand every click on the config
 * pane to the detail pane on every narrow terminal.
 */
export function cockpitRects(layout: CockpitLayout): CockpitRects {
  const { heights, leftWidth, rightWidth } = layout

  if (layout.kind === 'single') {
    // The one drawn pane, under the strip; the others have no rectangle at all, so no click can
    // land on a pane nobody can see. `services` cannot be null, so it is an EMPTY rect instead.
    const shown = layout.shown ?? 'services'
    const full = { x: 0, y: layout.strip ?? 0, width: leftWidth, height: heights[shown] }
    return {
      services: shown === 'services' ? full : { x: 0, y: 0, width: 0, height: 0 },
      config: shown === 'config' ? full : null,
      detail: shown === 'detail' ? full : null,
    }
  }

  if (layout.kind === 'columns') {
    // Equal by construction — `cockpitLayout` sizes the band to the taller of the two — so either
    // one is the band's height and the detail pane starts under it.
    const band = heights.services
    return {
      services: { x: 0, y: 0, width: leftWidth, height: heights.services },
      config: heights.config > 0 ? { x: leftWidth, y: 0, width: rightWidth, height: heights.config } : null,
      detail: heights.detail > 0
        ? { x: 0, y: band, width: leftWidth + rightWidth, height: heights.detail }
        : null,
    }
  }

  let top = heights.services
  const detail = heights.detail > 0 ? { x: 0, y: top, width: leftWidth, height: heights.detail } : null
  top += heights.detail
  const config = heights.config > 0 ? { x: 0, y: top, width: leftWidth, height: heights.config } : null

  return { services: { x: 0, y: 0, width: leftWidth, height: heights.services }, config, detail }
}

// ---------------------------------------------------------------------------
// the services pane's own columns
// ---------------------------------------------------------------------------

/** Cell widths inside a services row; `0` means the cell is not drawn. */
export interface ServiceCells {
  label: number
  runtime: number
  state: number
}

/**
 * The narrowest label cell that still tells the two services apart.
 *
 * They are `agentistics` and `agentistics central`, forever, and they differ only in the SUFFIX —
 * so a squeezed name stays honest as long as the ellipsis is visible past the shared prefix. Below
 * that the two rows read as the same row, and the list that drives the whole screen has become
 * ambiguous, which is worse than any cell it could buy.
 */
const LABEL_FLOOR = 12
/** What a set of cells costs, gaps included. A cell of zero is not drawn and carries no gap. */
function serviceRowCost(cells: ServiceCells): number {
  return cells.label
    + (cells.runtime > 0 ? cells.runtime + 1 : 0)
    + (cells.state > 0 ? cells.state + 1 : 0)
}

/**
 * Fits the services row: name, runtime, state.
 *
 * A ladder of whole allocations rather than a chain of `if`s that each drop a cell: the first rung
 * that fits is the most the row can say, and whatever that rung did not spend is handed back
 * afterwards instead of sitting idle. That last part is the fix for a row that read `agentistics
 * ▲` with ten empty columns beside it — the old chain dropped a cell whole the moment the full row
 * was a single column too wide, and then nothing claimed the columns it freed.
 *
 * THE ORDER OF GIVING WAY, and it is the one thing in this file worth arguing about:
 *
 *  1. The NAME is squeezed first, down to `LABEL_FLOOR`. `agentistics centr…` is still that
 *     service, and the detail pane titles it in full.
 *  2. Then the RUNTIME cell goes, whole.
 *  3. The state WORD is the LAST thing to go, and only a glyph survives it.
 *
 * The runtime cell used to outlive the word, on the grounds that in a conflict `native+docker` is
 * the whole of what the row has to say. It is not, and the consequence was the failure this screen
 * exists to prevent: below about a hundred columns the row read `agentistics  native+docker ▲`,
 * where the only thing marking two copies fighting over one port was a red triangle. The word is
 * what the row cannot be reduced to a colour without — and unlike the runtimes it is repeated
 * nowhere else, while the names are said twice more beside it, by the detail pane's badge and by
 * the conflict sentence that leads its facts.
 *
 * Because the preference is a single order rather than a trade that flips with the width, both
 * cells degrade monotonically: nothing that fitted at one column comes back at a narrower one,
 * which is what keeps a resize from flickering the row between two halves of the same message.
 */
export function serviceCells(
  rows: { label: string; runtime: string; state: string }[],
  width: number,
): ServiceCells {
  const avail = width - SERVICE_MARKER
  if (rows.length === 0 || avail <= 0) return { label: 0, runtime: 0, state: 0 }

  const widest = (pick: (r: (typeof rows)[number]) => string) =>
    rows.reduce((n, r) => Math.max(n, pick(r).length), 0)

  const label = widest(r => r.label)
  const runtime = widest(r => r.runtime)
  const state = widest(r => r.state)
  // The glyph is the state cell's floor: `truncate('● up', 1)` is `…`, which says less than
  // nothing, while the glyph alone still says whether the service is running.
  const glyph = Math.min(state, 1)
  const floor = Math.min(label, LABEL_FLOOR)

  const ladder: ServiceCells[] = [
    { label, runtime, state },
    { label: floor, runtime, state },
    { label, runtime: 0, state },
    { label: floor, runtime: 0, state },
    { label, runtime: 0, state: glyph },
    { label: Math.max(1, avail - glyph - 1), runtime: 0, state: glyph },
  ]

  const picked = ladder.find(c => serviceRowCost(c) <= avail) ?? ladder[ladder.length - 1]!
  const spare = avail - serviceRowCost(picked)
  // A pane two columns wide cannot hold a name AND a glyph. The name is the row, so the glyph is
  // what goes — a row that overflows would be composited over the pane's border, not clipped.
  if (spare < 0) return { label: Math.max(0, avail), runtime: 0, state: 0 }
  if (spare === 0) return picked

  // Whatever the rung did not spend goes to the NAME, which is the only cell with a use for one
  // more column: the state word is all of it or none (`▲ confl…` is not a terser way of saying
  // conflict, it is a word that has stopped being one), and so is the runtime cell.
  //
  // The word needs no second pass here. The ladder already offers it at BOTH label widths, so a row
  // that can afford `floor + word` was given the word by the rung it was picked from — leftover
  // columns can only ever be too few to buy it back.
  return { ...picked, label: Math.min(label, picked.label + spare) }
}

// ---------------------------------------------------------------------------
// the config pane's values
// ---------------------------------------------------------------------------

/**
 * The fuller wording when it fits, the shorter one when it does not, a cut only as a last resort.
 *
 * The config pane is the left column, which is the narrow one, and two of its rows have a long form
 * that is genuinely better: the mode SENTENCE ("member — sends metrics to a central") says what the
 * mode means, and the full endpoint URL is the thing you would paste. Neither is worth showing as
 * "member — sen…", which reads as a broken row and answers nothing, so each falls back to a short
 * form that is still TRUE and whole rather than to a prefix of itself.
 */
export function fitValue(preferred: string, fallback: string, room: number): string {
  if (room <= 0) return ''
  if (preferred.length <= room) return preferred
  if (fallback.length <= room) return fallback
  return truncate(fallback, room)
}

/** `http://host:port` → `host:port`. The scheme is the least informative part of a cramped URL. */
export function stripScheme(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
}

// ---------------------------------------------------------------------------
// the detail pane's content
// ---------------------------------------------------------------------------

/**
 * An uptime, from an INSTANT.
 *
 * `ControlService.startedAt` is when the process started, not how long it has been up, precisely so
 * this can be recomputed on every repaint — a duration handed over by the host would freeze at
 * whatever it was when `refresh()` last ran while the clock beside it kept moving. The units are
 * `d`/`h`/`m`/`s`, which are the same in both languages, so this needs no string table.
 *
 * Two units at most: "2h14m" is the answer, "2h14m38s" is a stopwatch nobody asked for.
 */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h${min % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

/**
 * How a detail line is painted.
 *
 * A tone NEVER carries the meaning on its own: `good` and `bad` always arrive on a row that already
 * has a glyph and a word (`● up`, `▲ conflict`), and `info` on a row that is a sentence. The tone is
 * emphasis, and a terminal that flattens the palette loses nothing but emphasis.
 */
export type DetailTone = 'plain' | 'muted' | 'good' | 'bad' | 'info'

/**
 * One drawable line of the detail pane.
 *
 * A flat list rather than a tree of sections, because the pane's whole layout problem is "how many
 * rows do I have and which ones do I keep" — and that is a question about a list. `detailPlan`
 * counts these; the component maps `kind` to a shape and `tone` to a colour and decides nothing.
 */
export interface DetailLine {
  kind: 'section' | 'row' | 'text' | 'blank'
  /** `section`: its title. `row`: the label column. Empty otherwise. */
  label: string
  /** `row`: its value. `text`: the sentence. Empty otherwise. */
  value: string
  tone: DetailTone
}

/** What the detail pane draws for the selected service, before any of it is colored. */
export interface DetailContent {
  /**
   * Every line, in the order they must survive a short pane — the alert first, then the summary,
   * then the sections.
   */
  lines: DetailLine[]
  /** The label column's width, measured across the `row` lines so the values align. */
  labelWidth: number
  /**
   * The conflict sentence, when both runtimes of one service are up. Drawn in `COLORS.danger` —
   * and the sentence NAMES both runtimes, so the colour is never what carries the meaning.
   *
   * Kept as a field of its own as well as a line, because callers ask whether there IS one.
   */
  alert: string
}

/** The already-localized facts the MACHINE contributes, which are not facts about a runtime. */
export interface MachineFacts {
  /** `history`, `endpoint` — each already a label/value pair, and absent when there is nothing. */
  rows: { label: string; value: string }[]
}

/**
 * The facts about one service, composed but not yet laid out.
 *
 * WHAT IS ON HERE, and why each piece earned its row:
 *
 *  - the ALERT, first, because two copies of one program fighting over one port is the thing this
 *    pane must never be shown without;
 *  - the SUMMARY of the runtime that is actually serving — a logical service has no pid or URL of
 *    its own, its runtimes do;
 *  - every RUNTIME this box could run the service under, with its state and, when it cannot be run
 *    here at all, WHY. "docker not installed" is the answer to "why does this offer me nothing",
 *    which is the most confusing thing a service panel can fail to say;
 *  - the ADDRESSES, which are the things you retype into a browser;
 *  - the MACHINE's own settings that bear on it — whether it comes back on boot (only when the host
 *    can tell), how history is preserved, and the central it pushes to.
 *
 * Every part is dropped when it is absent rather than rendered as a zero: a service whose pid the
 * box would not give up says nothing about a pid, and never `pid 0`; a box whose init system we
 * cannot ask says nothing about boot, and never "no". That is the same rule the dashboard applies
 * to harness capabilities, for the same reason: this screen is acted on, and a confident wrong fact
 * is worse than a visible gap.
 */
export function detailContent(
  service: ControlService,
  s: ControlStrings,
  now: number,
  machine: MachineFacts = { rows: [] },
): DetailContent {
  const lines: DetailLine[] = []
  const active = service.active

  const alert = service.conflict ?? ''
  if (alert) lines.push({ kind: 'text', label: '', value: alert, tone: 'bad' })

  // A second copy under the SAME runtime, holding no port. Its own line rather than folded into the
  // conflict sentence: the two are different faults with different answers — a conflict asks which
  // runtime to stop, this one names a pid that is doing work for nobody. Both can be true at once,
  // and then both are said.
  if (service.idle) lines.push({ kind: 'text', label: '', value: service.idle, tone: 'bad' })

  const summary = summaryOf(service, s, now)
  if (summary) lines.push({ kind: 'text', label: '', value: summary, tone: 'muted' })

  // Two things a note answers, and they are the same question: why can this row not tell me more.
  // Either detection failed (`unknown`), or the service is down and this box cannot run it at all.
  const note = service.state === 'unknown' ? service.reason ?? '' : blockedReason(service)
  if (note) lines.push({ kind: 'text', label: '', value: note, tone: 'info' })

  if (service.runtimes.length > 0) {
    lines.push({ kind: 'blank', label: '', value: '', tone: 'plain' })
    lines.push({ kind: 'section', label: s.sectionRuntimes, value: '', tone: 'plain' })
    // The REASON is worth a runtime row only when there is more than one runtime, because then it
    // answers "which of them" — with a single runtime the note above has already said it, in the
    // place a short pane keeps. Saying it twice on a three-line pane is two rows for one fact.
    const withReason = service.runtimes.length > 1
    for (const runtime of service.runtimes) {
      lines.push({
        kind: 'row',
        // The runtime WORD (`native` / `docker`), which is the same in both languages and is the
        // word the compose files and the docs already use.
        label: runtime.kind,
        value: runtimeState(runtime, s, now, withReason),
        tone: runtime.state === 'up' ? 'good' : runtime.available ? 'muted' : 'info',
      })
    }
  }

  // What this box CANNOT start, and why. Placed after the runtimes — it is the same subject read
  // one level down — and only while the service is DOWN: a running central has no start verbs at
  // all, so listing what it could not have started is a paragraph about a decision nobody is
  // making. Absent when nothing is withheld, rather than a line saying so.
  const startNotes = service.state === 'up' ? [] : service.startNotes ?? []
  if (startNotes.length > 0) {
    lines.push({ kind: 'blank', label: '', value: '', tone: 'plain' })
    lines.push({ kind: 'section', label: s.sectionStartBlocked, value: '', tone: 'plain' })
    for (const note of startNotes) {
      lines.push({ kind: 'text', label: '', value: note, tone: 'info' })
    }
  }

  const addresses: DetailLine[] = []
  if (active?.webUrl) {
    addresses.push({ kind: 'row', label: s.webLabel, value: active.webUrl, tone: 'plain' })
  }
  if (active?.apiUrl && active.apiUrl !== active.webUrl) {
    addresses.push({ kind: 'row', label: s.apiLabel, value: active.apiUrl, tone: 'plain' })
  }
  if (addresses.length > 0) {
    lines.push({ kind: 'blank', label: '', value: '', tone: 'plain' })
    lines.push({ kind: 'section', label: s.sectionAddresses, value: '', tone: 'plain' })
    lines.push(...addresses)
  }

  const boot = service.boot
  const machineRows: { label: string; value: string }[] = [
    // Absent, not "no": a box whose init system this host cannot ask must say nothing at all.
    //
    // The UNIT is named beside the state whenever the host carried one, and that is the whole of
    // the honest trail: "starts at boot" tells a user that SOMETHING will bring their central back
    // and gives them nothing to go and look at. With the unit named, the answer to "why did this
    // come back after I stopped it" is on the same row as the verb that turns it off.
    ...(boot
      ? [{
          label: s.bootLabel,
          value: (boot === 'on' ? s.bootOn : s.bootOff) + (service.bootUnit ? `${SEP}${service.bootUnit}` : ''),
        }]
      : []),
    ...machine.rows,
  ]
  if (machineRows.length > 0) {
    lines.push({ kind: 'blank', label: '', value: '', tone: 'plain' })
    lines.push({ kind: 'section', label: s.sectionMachine, value: '', tone: 'plain' })
    for (const row of machineRows) lines.push({ ...row, kind: 'row', tone: 'plain' })
  }

  const labelWidth = lines.reduce((n, l) => (l.kind === 'row' ? Math.max(n, l.label.length) : n), 0)
  return { lines, labelWidth, alert }
}

/** Runtime, pid and uptime on one row — or the state word, when there is no process to describe. */
function summaryOf(service: ControlService, s: ControlStrings, now: number): string {
  const active = service.active
  const parts: string[] = []
  if (active) parts.push(active.kind)
  if (service.state !== 'up') {
    parts.push(service.state === 'down' ? s.stateDown : s.stateUnknown)
  }
  if (active?.pid !== undefined) parts.push(`${s.pidLabel} ${active.pid}`)
  if (active?.startedAt !== undefined) {
    const up = formatUptime(now - active.startedAt)
    if (up) parts.push(`${s.uptimeLabel} ${up}`)
  }
  return parts.join(SEP)
}

/**
 * One runtime's row: the state, said with a glyph AND a word, plus whatever is true beside it.
 *
 * A runtime this box cannot run at all states the REASON — that sentence is the difference between
 * a row that offers nothing and a row that explains why it offers nothing.
 */
function runtimeState(
  runtime: ControlService['runtimes'][number],
  s: ControlStrings,
  now: number,
  withReason: boolean,
): string {
  const parts: string[] = [
    `${DETAIL_STATE_GLYPH[runtime.state]} ${
      runtime.state === 'up' ? s.stateUp : runtime.state === 'down' ? s.stateDown : s.stateUnknown
    }`,
  ]
  if (withReason && runtime.reason && (!runtime.available || runtime.state === 'unknown')) {
    parts.push(runtime.reason)
  }
  if (runtime.pid !== undefined) parts.push(`${s.pidLabel} ${runtime.pid}`)
  if (runtime.startedAt !== undefined) {
    const up = formatUptime(now - runtime.startedAt)
    if (up) parts.push(`${s.uptimeLabel} ${up}`)
  }
  return parts.join(SEP)
}

/**
 * The state glyphs, duplicated from `Chrome.tsx` on purpose: this module is pure and may not import
 * a component, and the three glyphs are the vocabulary rather than an implementation detail. The
 * pairing is asserted in the tests so the two cannot drift.
 */
const DETAIL_STATE_GLYPH: Record<string, string> = { up: '●', down: '○', unknown: '?' }

/**
 * The lines a pane of `max` rows may draw — cut from the BOTTOM, then trimmed.
 *
 * The cut alone is not enough. `detailContent` emits a blank and a rule in front of each group, so
 * a slice can land immediately after one and leave `ADDRESSES ────────` heading nothing, or a blank
 * row hanging off the last fact — a heading for nothing says nothing, and it costs a row the pane
 * was short of in the first place. Trimming both is what makes a short pane read as fewer facts
 * rather than as a truncated one.
 *
 * From the bottom because `detailContent` orders its lines by what must survive: the conflict, the
 * summary, the reason, then the groups.
 */
export function fitDetailLines(lines: readonly DetailLine[], max: number): DetailLine[] {
  if (max <= 0) return []
  const kept = lines.slice(0, max)
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!
    if (last.kind !== 'section' && last.kind !== 'blank') break
    kept.pop()
  }
  return kept
}

/** How the detail pane spends its rows: facts at the top, verbs on the floor, air between them. */
export interface DetailPlan {
  /** Fact rows the caller may draw, in the order it emits them. */
  facts: number
  /** Blank rows under the last fact, so the action row lands on the pane's last line. */
  pad: number
  /** Whether the action row is drawn at all. */
  actions: boolean
}

/**
 * Divides the detail pane between its facts and its verbs.
 *
 * The ACTION ROW is the last thing to go — a pane that dropped its verbs and kept a URL is a
 * readout, and the reason the verbs live here rather than in a menu of their own is that they
 * belong to the thing described above them.
 *
 * It is also PINNED to the bottom, which is what the padding is for. The detail pane now owns
 * everything under the band (see `cockpitLayout`), so on a tall terminal it has rows to spare — and
 * with the verbs following the last fact, those rows landed under the action row, where they read
 * as the dead region the whole cockpit was reshaped to remove. On the floor the same rows read as
 * air, and the verbs stop jumping up and down the pane as the selection moves between a service
 * with a dozen facts and one with three.
 */
export function detailPlan(rows: number, facts: number, wantActions: boolean): DetailPlan {
  if (rows <= 0) return { facts: 0, pad: 0, actions: false }
  const actions = wantActions
  const shown = Math.min(facts, Math.max(0, rows - (actions ? 1 : 0)))
  return { facts: shown, pad: actions ? rows - shown - 1 : 0, actions }
}

/** Why a stopped service cannot be started here, when that is the case. Empty otherwise. */
function blockedReason(service: ControlService): string {
  if (service.state === 'up' || service.startOptions.length > 0) return ''
  return service.runtimes.find(r => !r.available && r.reason)?.reason ?? ''
}

// ---------------------------------------------------------------------------
// the config pane's own columns
// ---------------------------------------------------------------------------

/** Cell widths inside a config row. */
export interface ConfigCells {
  label: number
  value: number
}

/**
 * Fits the config row: an aligned label column and its value.
 *
 * The LABEL gives way here, which is the opposite of the services row — and for the same underlying
 * reason. There, the label is the identity and the state is a glyph you can spare; here the label
 * is four fixed words the user learns once ("mode", "endpoint", "history", "language") while the
 * value is the answer they came for. Portuguese is what forces the question: `histórico` is nine
 * columns, and reserving all nine in a sixteen-column pane left every value with none at all — a
 * column of labels pointing at nothing.
 */
export function configCells(labels: string[], width: number): ConfigCells {
  const avail = width - SERVICE_MARKER
  if (labels.length === 0 || avail <= 0) return { label: 0, value: 0 }

  const measured = labels.reduce((n, l) => Math.max(n, l.length), 0)
  const label = Math.min(measured, Math.max(CONFIG_LABEL_MIN, avail - 1 - CONFIG_VALUE_MIN))
  return { label: Math.max(0, label), value: Math.max(0, avail - label - 1) }
}

/** Separator between two actions on the detail pane's action row. */
export const ACTION_SEP = '   '

/**
 * The window of actions that fits one row, always containing the selected one.
 *
 * Actions are dropped from the right like footer hints, but the selection is not allowed to fall
 * out of the window — a cursor you cannot see, on a row that runs a command, is the one place in
 * this app where a layout compromise could destroy something.
 */
export function fitActions(labels: string[], selected: number, width: number): {
  labels: string[]
  /** Index of the first visible action, so the caller can map back to the real list. */
  from: number
} {
  if (labels.length === 0) return { labels: [], from: 0 }
  const sel = Math.min(Math.max(0, selected), labels.length - 1)

  let from = 0
  let to = labels.length
  const cost = () => SERVICE_MARKER + labels.slice(from, to).join(ACTION_SEP).length

  while (to - from > 1 && cost() > width) {
    if (to - 1 > sel) to--
    else from++
  }
  return { labels: labels.slice(from, to), from }
}

/** The visible window of an action row, plus what it had to leave outside. */
export interface ActionRowFit {
  labels: string[]
  /** Index of the first visible action, so the caller can map back to the real list. */
  from: number
  /** There are actions before / after the window. */
  less: boolean
  more: boolean
}

/** `‹`/`›` plus the space that separates one from a verb. */
const MORE_MARK = 2

/**
 * The same window as `fitActions`, with room kept for the marks that say it IS a window.
 *
 * A row of verbs that silently ends is a row that has answered the question: a stopped server
 * offers four starts, three of them fit, and nothing on screen suggests pressing `→` — so the
 * docker start might as well not exist. The marks cost two columns each and are taken out of the
 * row BEFORE it is fitted, because a mark drawn past the edge is the overflow this file exists to
 * prevent.
 */
export function fitActionRow(labels: string[], selected: number, width: number): ActionRowFit {
  const first = fitActions(labels, selected, width)
  const hidden = (fit: { labels: string[]; from: number }) =>
    ({ less: fit.from > 0, more: fit.from + fit.labels.length < labels.length })

  const marks = hidden(first)
  const cost = (marks.less ? MORE_MARK : 0) + (marks.more ? MORE_MARK : 0)
  if (cost === 0) return { ...first, ...marks }

  // Re-fitted against the narrower row, which can hide one more verb than the first pass did — so
  // the marks are recomputed from the window that will actually be drawn.
  const second = fitActions(labels, selected, Math.max(0, width - cost))
  return { ...second, ...hidden(second) }
}

/**
 * Which verb a column of the action row names, as an index into the FULL list.
 *
 * It walks the row exactly as `ActionRow` draws it — the reserved cursor cell, the `‹ ` mark when
 * the window has verbs behind it, then the labels with `ACTION_SEP` between them — and returns
 * `fit.from + i`, because the window is a slice and the caller acts on the real list.
 *
 * The separator belongs to NEITHER verb: three columns of air between `Restart` and `Stop` is a
 * pointer's margin for error, and a click there had better do nothing rather than stop a server the
 * user was aiming past. The `‹`/`›` marks are inert for the same reason the footer never advertises
 * a key that does nothing: they say the row is a window, and `←`/`→` are what move it.
 */
export function actionAtColumn(fit: ActionRowFit, x: number): number | null {
  let left = SERVICE_MARKER + (fit.less ? MORE_MARK : 0)
  if (x < left) return null

  for (let i = 0; i < fit.labels.length; i++) {
    if (i > 0) {
      left += ACTION_SEP.length
      if (x < left) return null
    }
    left += fit.labels[i]!.length
    if (x < left) return fit.from + i
  }
  return null
}

// ---------------------------------------------------------------------------
// key hints, per focused pane
// ---------------------------------------------------------------------------

/** What the selected service currently permits — a hint for a key that does nothing is a bug. */
export interface HintContext {
  /**
   * The selection has any verbs at all.
   *
   * Normally it does — a service is either startable or stoppable. It does NOT when this box
   * cannot run the thing: a central on a machine without docker is down, unstartable, and `enter`
   * on it opens an empty action row, so the hint that names that key would be the lie this whole
   * function exists to prevent.
   */
  canAct: boolean
  /** The selection is up, so it can be stopped and restarted. */
  canStop: boolean
  /** The selection is up and publishes a dashboard the host can open. */
  canOpen: boolean
  /**
   * A streamed task owns the detail region and the keyboard.
   *
   * Optional because it is a state of the SHELL rather than of the selection — every other field
   * here is a fact about the service under the cursor. Absent means no task, which is the case on
   * every frame that is not watching a build.
   */
  task?: boolean
  /**
   * How many panes the layout actually drew.
   *
   * A short terminal keeps the services pane and nothing else, and `tab` there cycles a list of
   * one — so the hint that names it is advertising a key that does nothing, the exact bug this
   * whole function exists to prevent. The count comes from the layout rather than from the pane
   * set because the layout is the only thing that knows what survived the height.
   */
  panes: number
  /**
   * The cockpit is showing ONE pane (a narrow terminal). `esc` then walks back to the first pane
   * from the config pane, so the config pane's footer names it.
   */
  narrow?: boolean
}

/**
 * The keys that work in the focused pane, most-important-first.
 *
 * `footerHints` drops from the right, so quit and the screen keys lead: a user who cannot see how
 * to leave is stuck inside an alternate screen that hides their shell. Everything past them is
 * conditional on the pane, which is the whole point — the footer is the only documentation this
 * screen has, and a hint for a key that does nothing here teaches the wrong thing twice.
 */
export function cockpitHints(focus: PaneId, s: ControlStrings, ctx: HintContext): string[] {
  // A task's output pane answers for the whole screen while it is up: the services underneath it are
  // not selectable, nothing can be started or stopped, and the tab keys stand down with the rest of
  // the global keys. So the row names exactly the three keys that work — read it, and put the facts
  // back — rather than a focus that is currently unreachable.
  if (ctx.task) return [s.keyTaskClose, s.keyScroll, s.logFollow]

  // With one pane on screen `tab` has nowhere to go, so it is not named. Everything else on the
  // row is conditional on the pane already; this is the same rule applied to the pane count.
  const pane = ctx.panes > 1 ? [s.keyPane] : []

  switch (focus) {
    case 'actions':
      // `←→` belong to the action row here, so `←→ screens` is the one hint on this screen that
      // would be false — it is not said, and the way back out of the row leads instead.
      // A narrow terminal can show the detail pane of a service with no verbs at all; then the row
      // has nothing to move over or run, and only the way back and the pane key are true.
      if (!ctx.canAct) return [s.keyBack, ...pane]
      return [s.keyBack, s.keyActionMove, s.keyRun, ...pane]
    case 'config':
      return [s.keyQuit, s.keyTabs, ...pane, ...(ctx.narrow ? [s.keyBack] : []), s.keyMove, s.keySelect, s.keyRefresh]
    default:
      return [
        s.keyQuit,
        s.keyTabs,
        ...pane,
        s.keyMove,
        ...(ctx.canAct ? [s.keyActions] : []),
        ...(ctx.canStop ? [s.keyStop, s.keyRestart] : []),
        ...(ctx.canOpen ? [s.keyOpen] : []),
        s.keyRefresh,
      ]
  }
}

export const HINT_SEP = '  ·  '

/**
 * Joins key hints, dropping from the RIGHT until they fit.
 *
 * Callers order hints most-important-first: on a narrow terminal you would rather lose "r refresh"
 * than "q quit", and a user who cannot see how to leave the app is stuck in the alternate screen.
 */
export function footerHints(hints: string[], width: number): string {
  const kept = hints.filter(h => h.length > 0)
  while (kept.length > 0 && kept.join(HINT_SEP).length > width) kept.pop()
  // Even a single hint can exceed a very narrow terminal; truncating is still better than wrapping.
  if (kept.length === 0) return truncate(hints[0] ?? '', width)
  return kept.join(HINT_SEP)
}
