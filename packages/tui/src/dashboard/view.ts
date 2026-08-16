/**
 * view.ts — PURE navigation and row arithmetic for the metrics dashboard.
 *
 * The dashboard is ONE screen of the control center now — `agentop tui` is an alias for `agentop`,
 * and the standalone app that used to draw these screens under its own chrome is gone. Everything
 * the screens have to agree about lives here, against plain values, so no screen holds a rule of
 * its own: a second implementation of one screen is the bug `task-reopen.ts` exists to have fixed
 * once, and six screens is six chances to make it.
 *
 * The height arithmetic is why that matters. Full-screen, the old app had the whole terminal and its
 * screens simply drew what they had; inside a pane there is the terminal MINUS the chrome, the frame
 * and the screen strip, and Ink does not clip an overflowing child — it composites it, so a screen
 * one row too tall reads as a corrupted frame rather than as a cramped one. Every screen therefore
 * gets a budget it can actually spend, and each `*Plan` below states the order in which its parts
 * give way.
 */

import type { AppData, HarnessId } from '@agentistics/core'
import type { NavKey } from '../control/nav'
import type { ControlService } from '../control/types'
import { sourceRowFit, type SourceRowFit } from '../control/surface.ts'
import { modelRows, projectRows, sessionHarness, sessionRows } from '../selectors'
import type { TuiStrings } from '../i18n'

/**
 * The dashboard's five screens.
 *
 * `history` is what the standalone app called `sessions`, and the rename is the whole of the fix for
 * a collision the merge created: the control center ALREADY has a `sessions` tab, and it is a
 * different thing entirely — the fleet running right now, which can be attached to, approved and
 * killed. This one is the recorded past: conversations that have finished, and what each of them
 * cost. Two names for two things, in one application, rather than the same word twice.
 *
 * It is also the word the machine already uses for exactly this material: `history` is what the
 * archive setting preserves (`archiveMode`, the config pane's `history` row), and what it preserves
 * is precisely the rows this screen lists.
 */
export type DashboardScreenId = 'overview' | 'projects' | 'history' | 'costs' | 'harnesses' | 'hardware'

export const DASHBOARD_SCREENS: readonly DashboardScreenId[] = [
  'overview',
  'projects',
  'history',
  'costs',
  'harnesses',
  'hardware',
] as const

/**
 * Which screen a key selects, or `null` when the key is not ours.
 *
 * THE KEYS ARE CHOSEN BY WHAT THE SHELL ALREADY OWNS, and that is the only interesting thing about
 * this function. The control center answers `←`/`→` and `[`/`]` for its TABS, `q`, `r` and `m`
 * globally; a key answered here as well would do two things at once, and only one of them could be
 * named by the footer. So:
 *
 *  - the DIGITS are free — the control center gave them up when the numbered bottom strip went away
 *    (`nav.ts`), and they belong to whatever list draws them. This screen draws them, on the strip,
 *    which is what makes them safe to press;
 *  - `tab` / `shift+tab` are free on any screen with no panes of its own, and they are what the
 *    standalone dashboard has always used to cycle screens. Keeping them is what stops the merge
 *    costing an existing user their muscle memory;
 *  - the ARROWS are deliberately NOT taken. Claiming them would mean the shell's `←→ screens` stops
 *    working here and `[`/`]` becomes the only way out of the tab — a trade the sessions cockpit
 *    makes because its arrows drive a list, and one this screen has no reason to make.
 */
export function resolveDashboardScreen(
  key: NavKey,
  current: DashboardScreenId,
): DashboardScreenId | null {
  if (key.input.length === 1) {
    const n = Number(key.input)
    if (Number.isInteger(n) && n >= 1 && n <= DASHBOARD_SCREENS.length) {
      return DASHBOARD_SCREENS[n - 1]!
    }
  }
  if (key.tab) {
    const i = DASHBOARD_SCREENS.indexOf(current)
    const step = key.shift ? DASHBOARD_SCREENS.length - 1 : 1
    return DASHBOARD_SCREENS[(i + step) % DASHBOARD_SCREENS.length]!
  }
  return null
}

/** The screen names, in strip order. */
export function screenLabels(s: TuiStrings): Record<DashboardScreenId, string> {
  return {
    overview: s.overview,
    projects: s.projects,
    history: s.history,
    costs: s.costs,
    harnesses: s.harnesses,
    hardware: s.hardware,
  }
}

/**
 * The strip's cells: the digit that reaches each screen, then its name.
 *
 * The number is drawn rather than merely documented for the same reason the log viewer numbers its
 * sources — a shortcut nobody can see is a shortcut nobody uses, and one that is visible is one the
 * footer does not have to spend a hint on.
 */
export function stripCells(s: TuiStrings): string[] {
  const labels = screenLabels(s)
  return DASHBOARD_SCREENS.map((id, i) => `${i + 1} ${labels[id]}`)
}

/**
 * The strip, fitted to the width it will be drawn at — the SAME widget the log viewer's source
 * selector is, through the same function.
 *
 * It is a plain function rather than a value threaded down because two callers need it: whatever
 * draws the row, and whatever resolves a click on it (`sourceAtColumn`). Two calls of one pure
 * function cannot disagree; a second measurement of the same row would agree until the day one of
 * them changed, and the failure mode is a click that opens the screen beside the one under the
 * pointer.
 */
export function stripFit(s: TuiStrings, screen: DashboardScreenId, width: number): SourceRowFit {
  const at = Math.max(0, DASHBOARD_SCREENS.indexOf(screen))
  return sourceRowFit(s.viewLabel, stripCells(s), at, width)
}

// ---------------------------------------------------------------------------
// where the data comes from
// ---------------------------------------------------------------------------

/**
 * What the dashboard can read right now — decided from what the HOST already reported.
 *
 * The standalone `agentop tui` used to START A SERVER for itself when none was listening, which was
 * right for a command whose whole job was to show metrics. This app is the screen that STARTS AND
 * STOPS that server, and a tab inside it that quietly started one would contradict the button two
 * screens away — so it starts nothing, reads `ControlStatus.services`, and when there is nothing to
 * read it says so in a sentence that names the way to fix it. That is the ONE behaviour the alias
 * does not carry over, and it is deliberate: an empty dashboard rendered as zeros would be the
 * confident-0 this codebase refuses everywhere else.
 */
export type DashboardSource =
  | { kind: 'api'; apiBase: string }
  /** The host has not answered yet — not the same thing as "there is nothing". */
  | { kind: 'loading' }
  /** The service is confidently down. There is a start one screen away, and we name it. */
  | { kind: 'down' }
  /** Detection failed, or it is up and publishes no address we could read. Never reported as down. */
  | { kind: 'unknown' }

export function dashboardSource(services: readonly ControlService[] | undefined): DashboardSource {
  if (!services) return { kind: 'loading' }
  const svc = services.find(s => s.id === 'agentistics')
  if (!svc) return { kind: 'unknown' }
  if (svc.state === 'down') return { kind: 'down' }
  if (svc.state !== 'up') return { kind: 'unknown' }
  // The api port is the one that answers `/api/data`. `webUrl` is the SPA and is a different port on
  // the native runtime, so it is not a fallback — asking it for `/api/data` works only by accident of
  // the two ports sharing one handler, and naming it here would hide the day they stop.
  const apiBase = svc.active?.apiUrl
  return apiBase ? { kind: 'api', apiBase } : { kind: 'unknown' }
}

// ---------------------------------------------------------------------------
// row budgets
// ---------------------------------------------------------------------------

/** A `Section` costs its blank separator plus its title before it draws anything. */
const SECTION_CHROME = 2
/** `Kpi` is a value over its label. */
const KPI_ROWS = 2
/** The activity section: its chrome plus the one row the sparkline is. */
const ACTIVITY_ROWS = SECTION_CHROME + 1
/** `Empty` renders a blank and a sentence. */
const EMPTY_ROWS = 2
/** A table spends a row on its header before the first result. */
const TABLE_HEADER = 1
/** The share panel never ranks more than five models. */
export const SHARE_MAX = 5

export interface OverviewPlan {
  /** The headline numbers. Dropped only when there is no room for a single one. */
  kpis: boolean
  /** The 30-day sparkline. */
  activity: boolean
  /** How many harness bars are drawn. `0` means the section holds no bars. */
  bars: number
  /**
   * Draw the harness section's EMPTY state — there is no harness to rank.
   *
   * Its own flag rather than something the screen infers from `bars === 0`, because the two are
   * genuinely different: no bars can also mean the section was trimmed away for want of rows, and
   * an empty state drawn in that case is two rows spent saying nothing on the screen that had none
   * to spare. "Nothing is tracked" costs rows like anything else.
   */
  empty: boolean
}

/**
 * Divides the Overview between its three parts.
 *
 * THE ORDER THINGS GIVE WAY, and it is the one thing here worth arguing about:
 *
 *  1. the KPI ROW stays. It is the answer — what this cost, how many tokens, how many sessions —
 *     and `fitKpis` already drops them from the right as the terminal narrows;
 *  2. the ACTIVITY sparkline goes next. It spends three rows to draw one line, and it is the part
 *     of this screen that says the least per row;
 *  3. the HARNESS bars are trimmed last, and never below one: the breakdown is the substance, and a
 *     section reduced to its heading says nothing the heading did not.
 */
export function overviewPlan(height: number, harnesses: number): OverviewPlan {
  const none = { kpis: false, activity: false, bars: 0, empty: false }
  if (height < KPI_ROWS) return none

  const rest = height - KPI_ROWS
  // With no harness at all the section still draws its empty state, which costs rows of its own.
  const want = harnesses > 0 ? harnesses : EMPTY_ROWS
  const section = SECTION_CHROME + want
  const whole = { kpis: true, bars: harnesses, empty: harnesses === 0 }

  if (rest >= ACTIVITY_ROWS + section) return { ...whole, activity: true }
  if (rest >= section) return { ...whole, activity: false }
  const bars = rest - SECTION_CHROME
  if (harnesses > 0 && bars >= 1) return { kpis: true, activity: false, bars, empty: false }
  return { kpis: true, activity: false, bars: 0, empty: false }
}

export interface CostsPlan {
  /** Model rows under the table header — one page of them once `pager` is set. */
  table: number
  /** Bars in the share panel. `0` means it is not drawn. */
  share: number
  /** Whether the pager line is drawn, and therefore whether its row was paid for. */
  pager: boolean
}

/**
 * Divides the Costs screen between its table and its share panel.
 *
 * The TABLE is the screen: it is every model, priced and ranked, while the share panel re-states the
 * top five as bars. So the panel is what gives way, whole — a share panel showing one of five bars is
 * a proportion the reader cannot use.
 *
 * The pager is decided LAST and only once a model would be held back. Its page is `PAGE_SIZE` at
 * most, like every other list, but it is also bounded by whatever the share panel leaves — the share
 * panel is a view OF the table's top rows, so a page that pushed it off screen would be paging one
 * half of the screen by destroying the other.
 */
export function costsPlan(height: number, models: number): CostsPlan {
  const whole = costsLayout(height, models)
  // A pager over a table with no rows at all is a row spent saying nothing can be shown; at that
  // height the header is the only thing left, and it still says what the columns are.
  if (whole.table <= 0 || models <= whole.table) return { ...whole, pager: false }
  const paged = costsLayout(height - PAGER_ROW, models)
  return { ...paged, table: Math.min(PAGE_SIZE, paged.table), pager: true }
}

/** The table/share split at a given height, pager already paid for by the caller. */
function costsLayout(height: number, models: number): { table: number; share: number } {
  // At one row there is only the table's own header, which still says what the columns are. Asking
  // for a result row as well is one row of overflow — and `Math.max(1, …)` is exactly the shape of
  // that bug: it hands out a row that does not exist.
  if (height <= TABLE_HEADER || models <= 0) return { table: 0, share: 0 }
  const wantShare = Math.min(models, SHARE_MAX)
  const shareCost = SECTION_CHROME + wantShare

  if (height >= TABLE_HEADER + 1 + shareCost) {
    return { table: Math.min(models, height - TABLE_HEADER - shareCost), share: wantShare }
  }
  return { table: Math.min(models, height - TABLE_HEADER), share: 0 }
}

/** Result rows a plain table may draw at this height — its header is not free. */
export function listRows(height: number): number {
  return Math.max(1, height - TABLE_HEADER)
}

// ---------------------------------------------------------------------------
// paging
// ---------------------------------------------------------------------------

/**
 * Rows a page of a list holds.
 *
 * The three list screens used to slice to whatever the terminal afforded and stop there, with no way
 * to reach anything below the fold: on a 25-row terminal that answered "you have 25 sessions" to a
 * machine holding hundreds — a confident wrong number, in the one place a person goes to find out.
 *
 * It is a FIXED 15 rather than "whatever fits" because the pager states a place, and a place whose
 * page count changes when you resize the window is not one. The height still bounds it downward: Ink
 * COMPOSITES what does not fit rather than clipping it, so a page taller than the body paints over
 * whatever is below.
 */
export const PAGE_SIZE = 15

/** The pager line costs a row wherever it is drawn. */
const PAGER_ROW = 1

export interface PageWindow {
  /** The page actually in force, clamped into range. */
  page: number
  /** At least 1: an empty list is on page 1 of 1, never page 1 of 0. */
  pages: number
  /** Slice bounds for `rows.slice(from, to)`. */
  from: number
  /** One past the last index, `Math.min`ed against the total — a short last page stays honest. */
  to: number
}

/**
 * Which slice of a list a page names — PURE, and CLAMPED on every call.
 *
 * Clamped rather than corrected in an effect, for the same reason the cockpit's cursor is: a filter
 * that removes rows, or a poll that ends a session, shortens the list under a remembered index, and
 * a stored page would point past the end for exactly one frame — the frame the user presses a key
 * on. The cockpit's own `cardPages` is deliberately NOT this function: its pages are bands of
 * variable height rather than fixed slices, so the two share the idea and nothing else.
 */
export function pageWindow(total: number, size: number, page: number): PageWindow {
  const capacity = Math.max(1, Math.floor(size))
  const count = Math.max(0, Math.floor(total))
  const pages = Math.max(1, Math.ceil(count / capacity))
  const at = clampInt(Math.floor(page), 0, pages - 1)
  const from = at * capacity
  return { page: at, pages, from, to: Math.min(count, from + capacity) }
}

export interface ListPlan {
  /** Rows one page may draw. */
  size: number
  /** Whether the pager line is drawn — and therefore whether it was paid for. */
  pager: boolean
}

/**
 * How a plain list spends its rows: results, and the pager line under them.
 *
 * A list that fits pays for NO pager — a pager saying "page 1 of 1" is a row spent stating that
 * nothing was withheld, on a screen whose rows are the scarce thing. As soon as one row would be
 * held back the line appears, because that is the moment its absence becomes a lie.
 */
export function listPlan(height: number, total: number): ListPlan {
  const whole = Math.max(1, Math.min(PAGE_SIZE, height - TABLE_HEADER))
  if (total <= whole) return { size: whole, pager: false }
  return { size: Math.max(1, Math.min(PAGE_SIZE, height - TABLE_HEADER - PAGER_ROW)), pager: true }
}

/**
 * How many rows the screen behind `id` would list — the total a pager counts against.
 *
 * It exists so the KEYBOARD can clamp: an unbounded page counter takes as many presses to come back
 * as it took to run past the end, and correcting it where the rows are drawn is one frame too late.
 * The screens that page nothing report 0, which reads as a single page and no keys — `overview` and
 * `hardware` draw no list, and `harnesses` cannot have more rows than there are harnesses.
 */
export function pageableTotal(id: DashboardScreenId, data: AppData | null): number {
  if (!data) return 0
  switch (id) {
    case 'history': return sessionRows(data).length
    case 'projects': return projectRows(data).length
    case 'costs': return modelRows(data).length
    default: return 0
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

// ---------------------------------------------------------------------------
// the harness filter
// ---------------------------------------------------------------------------

/**
 * Restricts an AppData to one harness, so every screen can stay filter-unaware.
 *
 * Claude's totals live in the statsCache and every other harness's live in the session list, so
 * filtering has to act on BOTH: selecting a non-Claude harness must blank the cache, or the
 * Claude numbers would survive the filter and be attributed to the selection.
 *
 * It lives here, beside `pageableTotal`, because paging is decided AGAINST THE FILTERED LIST: the
 * page count is the count of what the filter left standing, and a page can never name a row the
 * filter removed.
 */
export function applyHarnessFilter(data: AppData, harness: HarnessId | null): AppData {
  if (!harness) return data
  return {
    ...data,
    harnesses: (data.harnesses ?? []).filter(h => h === harness),
    sessions: (data.sessions ?? []).filter(s => sessionHarness(s) === harness),
  }
}

/**
 * What the dashboard may draw at this height: the screen strip, its rule, and the body.
 *
 * The same three-part question the Logs screen answers, and the same order of giving way — one row
 * of content unconditionally, then the strip, then the rule. The strip outranks the rule because a
 * dashboard that does not say which of five screens you are on, or that the digits reach the other
 * four, is a screen about nothing; the rule only separates two things that already look different.
 */
export interface DashboardRows {
  strip: boolean
  divider: boolean
  body: number
}

export function dashboardRows(height: number): DashboardRows {
  if (height <= 0) return { strip: false, divider: false, body: 0 }
  const strip = height >= 2
  const divider = height >= 4
  return { strip, divider, body: height - (strip ? 1 : 0) - (divider ? 1 : 0) }
}
