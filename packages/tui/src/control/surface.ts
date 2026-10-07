/**
 * surface.ts — PURE layout arithmetic for the LINEAR screens and for the questions.
 *
 * `chrome.ts` measures the persistent chrome and the cockpit's panes. This measures everything
 * else: the section headers, the menus, the text fields and the scroll markers that Setup, Logs,
 * Help, the cheat sheet and Contribute are built out of, plus the three question primitives the
 * cockpit renders into its overlay seam.
 *
 * It is a separate module rather than more of `chrome.ts` because the two answer different
 * questions — one divides a screen between panes, the other divides a pane between rows — and
 * because the cockpit's geometry is the one file in this tree that must not acquire a reason to
 * change every time a form does.
 *
 * Same rules as `chrome.ts`: plain strings in, numbers and strings out, no Ink, no color. Every
 * threshold here is derived from measured text, because the words are translated and the
 * Portuguese ones are longer.
 */

import { truncate } from '../components/Primitives'
// The log viewer's source selector is the same primitive as the cockpit's action row — a horizontal
// list of cells that must keep the selected one visible — so it reuses the arithmetic rather than
// growing a second, subtly different copy of it. `chrome.ts` knows nothing of this module, so the
// dependency runs one way only.
import { ACTION_SEP, fitActions, SERVICE_MARKER } from './chrome.ts'
import type { ControlService, LogSource } from './types'

// ---------------------------------------------------------------------------
// section headers
// ---------------------------------------------------------------------------

/**
 * A section header, in the two colors it is drawn in: the title, and the rule that carries it to
 * the right edge.
 *
 * Split rather than pre-joined for the same reason `paneTop` is: the title is dim bold and the rule
 * is the border color, and a component cannot color half a string it was handed whole.
 */
export interface SectionHead {
  title: string
  /** The leading space and the rule; empty when the row is too narrow to carry one. */
  rule: string
}

/** One space between a title and its rule, so the two do not read as one word. */
const SECTION_GAP = 1
/** Below this the rule is a dash or two, which reads as a typo rather than as a section. */
const RULE_MIN = 2

/**
 * A titled rule that spans the row, echoing a pane's top border without spending a box on it.
 *
 * The linear screens are one pane each — the shell frames them — so their internal structure has to
 * come from somewhere else. A title alone floating over its rows was what made these screens read
 * as a wall of text; carrying it to the right edge is the same gesture the cockpit's panes make,
 * which is what makes the two halves of the app look related.
 *
 * The guarantee: `title` and `rule` together are EXACTLY `width` whenever a rule is drawn, so a
 * header can never wrap the row it heads.
 */
export function sectionHead(title: string, width: number): SectionHead {
  if (width <= 0) return { title: '', rule: '' }
  const shown = truncate(title, width)
  const room = width - shown.length - SECTION_GAP
  if (room < RULE_MIN) return { title: shown, rule: '' }
  return { title: shown, rule: ' ' + '─'.repeat(room) }
}

/** Two runs sharing one row need at least this much air between them to read as two things. */
const ROW_GAP = 2

/**
 * Whether a right-hand run still fits beside a left-hand one.
 *
 * The answer is a boolean rather than a truncation because everything drawn this way is a STATUS —
 * a follow state, a scroll position — that the row can simply do without. `● follow…` is not a
 * shorter way of saying the same thing; it is a row that has stopped answering.
 */
export function fitsBeside(left: string, right: string, width: number): boolean {
  return left.length + right.length + ROW_GAP <= width
}

// ---------------------------------------------------------------------------
// menus
// ---------------------------------------------------------------------------

/** `❯ ` — reserved on every row, so a menu does not shift sideways as the cursor moves. */
export const MENU_MARKER = 2
/** `N. ` — the digit accelerator, drawn only while the list is short enough to number. */
export const MENU_NUMBER = 3
/** Columns between a label and its hint. */
const HINT_GAP = 2
/**
 * A hint below this is a stub ("recommended — sto…") that answers nothing, so the label takes the
 * row instead and the hint is dropped whole. It is the same judgement `fitValue` makes: a shorter
 * TRUE thing beats a prefix of a longer one.
 */
const HINT_MIN = 12

/** Cell widths inside a menu row; `0` means the cell is not drawn. */
export interface MenuCells {
  label: number
  hint: number
}

/**
 * Fits a menu row: the marker, an optional digit, the label and its hint.
 *
 * The label column is measured across the whole menu at once — a row that measures itself is a
 * column that wobbles as the cursor moves — and capped so a narrow terminal still leaves the hint
 * something to say. Without hints the label may use everything, which is what a yes/no or a list of
 * bare commands wants.
 */
export function menuCells(
  labels: string[],
  opts: { numbered: boolean; hints: boolean; width: number },
): MenuCells {
  const avail = opts.width - MENU_MARKER - (opts.numbered ? MENU_NUMBER : 0)
  if (labels.length === 0 || avail <= 0) return { label: 0, hint: 0 }

  const longest = labels.reduce((n, l) => Math.max(n, l.length), 0)
  if (!opts.hints) return { label: avail, hint: 0 }

  const label = Math.max(1, Math.min(longest, avail - HINT_MIN))
  const hint = Math.max(0, avail - label - HINT_GAP)
  // A hint cell that survived the arithmetic but cannot hold a word is worth less than the columns
  // it takes from the label, so it is given back rather than rendered as an ellipsis.
  return hint >= HINT_MIN ? { label, hint } : { label: avail, hint: 0 }
}

// ---------------------------------------------------------------------------
// text prompts
// ---------------------------------------------------------------------------

/** ` › ` — the gutter between a question and the answer being typed. */
const FIELD_GUTTER = 3
/** The block cursor's column. */
const CURSOR = 1
/**
 * What a field needs to be usable.
 *
 * The three questions this app asks are a URL, a member token and an org name; the first two are
 * long and are usually pasted. A field narrower than this shows the last few characters of what was
 * pasted and nothing else, which is indistinguishable from a field that did not receive the paste.
 */
const FIELD_MIN = 16

export interface PromptLayout {
  /** The question, wrapped. One row when the field shares it, several when the field is below. */
  head: string[]
  /** True when the field sits on the question's row. */
  inline: boolean
  /** Columns the value itself may use. */
  room: number
}

/**
 * Decides whether a text field shares the question's row or gets one of its own.
 *
 * The connect questions are sentences — "Central endpoint URL (e.g. http://host:48080)" is
 * forty-four columns before the user types anything — and the cockpit asks them inside the right
 * column of a split screen. Kept on one row there, the question eats the field and the answer
 * becomes invisible as it is typed. Stacking is not a fallback for a tiny terminal; at 80 columns
 * it is the normal case.
 */
export function promptLayout(label: string, suffix: string, width: number): PromptLayout {
  if (width <= 0) return { head: [], inline: false, room: 0 }

  const inlineRoom = width - label.length - suffix.length - FIELD_GUTTER - CURSOR
  if (inlineRoom >= FIELD_MIN) return { head: [label], inline: true, room: inlineRoom }

  // Stacked: the question owns its rows whole — including the default in parentheses, which is part
  // of the sentence — and the field gets the width under it. The gutter loses its leading space
  // there, because at the start of a row `› ` is already clearly a prompt.
  return {
    head: wrapText(label + suffix, width),
    inline: false,
    room: Math.max(1, width - (FIELD_GUTTER - 1) - CURSOR),
  }
}

// ---------------------------------------------------------------------------
// prose
// ---------------------------------------------------------------------------

/**
 * Greedy word wrap.
 *
 * The prose on these screens is real sentences — the CI section alone is three of them, and every
 * question in the app is one — so truncating to the width would silently delete most of what was
 * said. Wrapping is measured BEFORE windowing so a scroll position counts the rows the user
 * actually sees. A word longer than the line (a URL, typically) is hard-split rather than allowed
 * to overflow, because an overflowing row shears every row below it.
 */
export function wrapText(s: string, width: number): string[] {
  if (width <= 0) return []
  const out: string[] = []
  let line = ''
  for (const word of s.split(/\s+/).filter(Boolean)) {
    let w = word
    while (w.length > width) {
      if (line) { out.push(line); line = '' }
      out.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!line) line = w
    else if (line.length + 1 + w.length <= width) line += ' ' + w
    else { out.push(line); line = w }
  }
  if (line) out.push(line)
  return out.length > 0 ? out : ['']
}

/**
 * Caps wrapped prose at `max` rows, marking the cut.
 *
 * A question drawn into a fixed-height pane cannot be allowed to decide for itself how many rows it
 * takes: Ink does not clip an overflowing child, it composites it, so one sentence too long lands
 * on top of the menu underneath it. The ellipsis is what keeps a silent cut from reading as the end
 * of the sentence.
 */
export function clampLines(lines: string[], max: number, width: number): string[] {
  if (max <= 0) return []
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  kept[kept.length - 1] = truncate(kept[kept.length - 1]! + '…', width)
  return kept
}

// ---------------------------------------------------------------------------
// the log viewer's source selector
// ---------------------------------------------------------------------------

/** One log the viewer can read: what to ask the host for, and what to call it on screen. */
export interface LogSourceOption {
  source: LogSource
  /** Already-localized — the SAME label the cockpit's services list prints. */
  label: string
}

/**
 * The logs this machine has, derived from the services the host reported.
 *
 * This used to be `['local', 'central', 'machine'] as const` written into the component, and the
 * selector rendered those internal ids verbatim: `1 local  2 central  3 machine`. Two of those are
 * one thing — `local` and `machine` are the native process and the container of the SAME logical
 * service — which is the exact distinction the logical-service model deleted, leaking back through
 * a constant that kept compiling while the model changed under it. It is the same class of bug
 * CLAUDE.md forbids for a hardcoded harness list, and it fails the same way: silently, and only in
 * what the user reads.
 *
 * So: one entry per LOGICAL service, under the service's own already-localized name. The host
 * resolves which runtime that means (`logRuntime`: the one that is up, or the file the last one
 * left behind), so the screen never learns that a container's log is a `docker logs` call.
 *
 * THE ONE EXCEPTION is a service running under more than one runtime at once — the conflict. Those
 * really ARE two different logs, and a selector that offered one of them would be picking, on the
 * user's behalf, which half of a conflict they get to read. That service expands into its running
 * runtimes, each named `<service> (native|docker)`. Derived from the status, so it appears and
 * disappears with the conflict itself.
 */
export function logSources(services: readonly ControlService[]): LogSourceOption[] {
  const out: LogSourceOption[] = []
  for (const service of services) {
    if (service.running.length > 1) {
      for (const id of service.running) {
        const runtime = service.runtimes.find(r => r.id === id)
        // The runtime WORD, not the runtime id: `native`/`docker` are what the row, the badge and
        // the stop verbs already say, and the ids are the host's vocabulary.
        out.push({ source: id, label: `${service.label} (${runtime?.kind ?? id})` })
      }
      continue
    }
    out.push({ source: service.id, label: service.label })
  }
  return out
}

/** Air between the word naming the selector and the first cell of it. */
const SOURCE_GAP = 2

export interface SourceRowFit {
  /** The naming word, or empty when the row could not afford it. */
  label: string
  /** The cells that fit, always containing the selected one. */
  labels: string[]
  /** Index of the first visible cell, so the caller can map back to the real list. */
  from: number
}

/**
 * Fits the source selector, which is the one row the log screen cannot be used without.
 *
 * It used to be a row of `<Text>` inside a flex Box with no budget at all, so Yoga shrank each
 * child in turn and the row came out as `SOURC  1 loca  2 centra  3 machine` — words chopped at
 * arbitrary points by the layout engine, which is exactly the failure every other `fit*` in this
 * tree exists to prevent. Worse, the shrunken row then WRAPPED, and the screen's row budget had
 * counted it as one, so a line of log went missing under the fold.
 *
 * The naming word is what gives way first: `SOURCE` is a caption for three cells that already say
 * what they are, and losing it costs nothing a reader needs. Only when the cells alone still do not
 * fit does the list start dropping them, and then never the selected one — the same contract
 * `fitActions` gives the cockpit's verbs, and the same function enforcing it.
 */
export function sourceRowFit(label: string, cells: string[], selected: number, width: number): SourceRowFit {
  const withLabel = fitActions(cells, selected, width - (label ? label.length + SOURCE_GAP : 0))
  if (label && withLabel.labels.length === cells.length) return { label, ...withLabel }
  return { label: '', ...fitActions(cells, selected, width) }
}

/** What the log screen may draw at this height. `body` is never zero while there is a row at all. */
export interface LogRows {
  /** The selector — which log this is, and the digits that switch it. */
  source: boolean
  /** The rule under the selector. Decoration, and the first thing to go. */
  divider: boolean
  body: number
}

/**
 * Divides the log screen between its selector and its lines.
 *
 * The screen used to draw both header rows unconditionally against a body of `height - 2`, so at a
 * two-row body it rendered three rows into two — and Ink COMPOSITES the overflow rather than
 * clipping it, which here silently dropped the FIRST child. What survived was a rule saying
 * nothing, over a log with no indication of which source it was or that `1`/`2`/`3` switch it.
 *
 * The order of giving way is what the screen cannot be without. One line of log is kept
 * unconditionally — it is the screen — then the selector, because a log nobody can identify is a
 * log about nothing, and the rule last: it separates two things that are already different.
 */
export function logRows(height: number): LogRows {
  if (height <= 0) return { source: false, divider: false, body: 0 }
  const source = height >= 2
  const divider = height >= 4
  return { source, divider, body: height - (source ? 1 : 0) - (divider ? 1 : 0) }
}

/** The row `sourceRowFit` describes, as one string — what the caller budgets a status against. */
export function sourceRowText(fit: SourceRowFit): string {
  return sourceRowHead(fit) + fit.labels.join(ACTION_SEP)
}

/** Everything drawn before the first cell: the naming word, its air, and the reserved marker. */
function sourceRowHead(fit: SourceRowFit): string {
  const head = fit.label ? fit.label + ' '.repeat(SOURCE_GAP) : ''
  return head + ' '.repeat(SERVICE_MARKER)
}

/**
 * Which source a column of the selector names, as an index into the FULL list.
 *
 * Same shape as the cockpit's `actionAtColumn`, and for the same reason: it walks the row through
 * `sourceRowHead`, which is also what `sourceRowText` measures with, so the hit test and the width
 * budget cannot disagree about where the first cell starts. The separator between two cells belongs
 * to neither — three columns of air is a pointer's margin for error.
 */
export function sourceAtColumn(fit: SourceRowFit, x: number): number | null {
  let left = sourceRowHead(fit).length
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
// the linear screens' row budgets
// ---------------------------------------------------------------------------

/** What a read-only screen may draw at this height. `intro`/`footer` false means it is not drawn. */
export interface StaticRows {
  intro: boolean
  body: number
  footer: boolean
}

/**
 * Divides a read-only screen's rows between its intro, its content and its position marker.
 *
 * The screens are drawn inside a `Pane`, and Ink COMPOSITES an overflowing child rather than
 * clipping it: one row too many and the intro's second line and the first content row are painted
 * into the same cells, which is how `Every command…` came out as `very command…` at ten rows. The
 * old arithmetic reserved a content row with `Math.max(1, …)` — handing out a row that did not
 * exist — instead of giving up a piece it could afford to lose.
 *
 * The order of giving way is the order of what the screen is FOR: one content row is kept
 * unconditionally, the position marker next (it is the only clue there is more below), and the
 * intro last, because it is prose that says what the reader can already see. Prose is what a short
 * terminal gives up first, here as on the Setup screen.
 */
export function staticRows(height: number, introHeight: number): StaticRows {
  if (height <= 0) return { intro: false, body: 0, footer: false }
  const footer = height >= 2
  let rest = height - (footer ? 1 : 0)
  const intro = introHeight > 0 && rest - introHeight >= 1
  if (intro) rest -= introHeight
  return { intro, body: rest, footer }
}

/*
 * `SetupRows` / `setupRows` / `setupBodyTop` lived here and are gone with the screen they budgeted.
 *
 * Setup stopped being a linear screen of its own: choosing solo / central / member is a question
 * ABOUT the services on this box, so it is drawn in the cockpit's detail region like every other
 * question and is budgeted by `cockpitLayout`'s `QUESTION_ROWS` instead. A row budget for a screen
 * that no longer exists is documentation of a program that no longer exists — the same reason
 * `cli-i18n.ts` deleted the old launcher's forty strings rather than leaving them in place.
 */

// ---------------------------------------------------------------------------
// scroll position
// ---------------------------------------------------------------------------

/**
 * `12–34 / 210` — where the viewport is, in the rows it is showing.
 *
 * One helper for every screen that scrolls, so the cheat sheet and the log viewer cannot disagree
 * about what a position marker looks like. It states the WINDOW rather than the cursor: on a log
 * the cursor is an implementation detail of scrolling, while "the last twenty of two thousand" is
 * the thing the reader wants to know.
 */
export function windowLabel(offset: number, shown: number, total: number): string {
  if (total <= 0 || shown <= 0) return ''
  const from = Math.min(offset + 1, total)
  const to = Math.min(offset + shown, total)
  return `${from}–${to} / ${total}`
}
