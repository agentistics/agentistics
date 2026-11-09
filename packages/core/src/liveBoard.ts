/**
 * liveBoard — PURE. The two rules the Live Delivery line ("Esteira de entregas ao vivo") applies to the
 * pieces it draws, written ONCE so the screen and the MCP tool (`agentistics_live_delivery`) can never
 * answer differently:
 *
 *   1. WHICH cards are shown — the tab (Em andamento · Na fila · Publicado · Tudo) and Publicado's period.
 *   2. In WHICH ORDER a column lists them — by priority (highest first), by time in the stage, or newest.
 *
 * Nothing here knows about fleets, sessions or React: it reads only `stage`, `priority`, `stageSinceMs`
 * and `key` off a delivery, so the browser's `LiveCard.d` and the server's `LiveDelivery` both satisfy it.
 */

import { PRIORITY_ORDER, DEFAULT_PRIORITY, type TaskPriorityId } from './taskSort'

/** Every column of the line, left to right. */
export type LiveBoardStage = 'queue' | 'blocked' | 'running' | 'qa' | 'adjust' | 'leader' | 'merge' | 'ci' | 'completed' | 'published'

/**
 * THE TABS (filtros v2, owner 08/11). The main choice of the bar, with a count each:
 *   - `active`    "Em andamento": only what has somebody working or waiting (a live agent), past the queue.
 *   - `queue`     "Na fila".
 *   - `published` "Publicado", inside its own `LivePeriod`.
 *   - `all`       "Tudo": every piece in its real column (old ones marked), Publicado inside its period.
 * The counts are `liveTabCounts` over the SAME cards the columns are drawn from, so a tab can never say a
 * number its columns do not hold (a test proves it).
 */
export type LiveTab = 'active' | 'queue' | 'published' | 'all'
export const LIVE_TABS: readonly LiveTab[] = ['active', 'queue', 'published', 'all']
export const LIVE_TAB_DEFAULT: LiveTab = 'active'
export type LivePeriod = '24h' | '7d' | '30d' | 'all'
export const LIVE_PERIODS: readonly LivePeriod[] = ['24h', '7d', '30d', 'all']
export const LIVE_PERIOD_DEFAULT: LivePeriod = '24h'
const PERIOD_MS: Record<LivePeriod, number> = { '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000, '30d': 30 * 24 * 3600_000, all: Infinity }

export const parseLiveTab = (raw: unknown): LiveTab => (LIVE_TABS as readonly unknown[]).includes(raw) ? raw as LiveTab : LIVE_TAB_DEFAULT
export const parseLivePeriod = (raw: unknown): LivePeriod => (LIVE_PERIODS as readonly unknown[]).includes(raw) ? raw as LivePeriod : LIVE_PERIOD_DEFAULT

/** The slice of a piece the tabs read. */
export interface LiveTabbable {
  stage: LiveBoardStage
  deliveredAtMs?: number | null
  /** A legacy review nobody is on (marked "antiga"); never "in progress". */
  old?: boolean
  /** Somebody is working or waiting on it right now. */
  liveState?: 'working' | 'waiting' | 'needs-you' | 'down' | 'none'
}

/** PURE: is a published piece inside the period? An undated one is only in "all" (nobody can say when). */
export function inPublishedPeriod(deliveredAtMs: number | null | undefined, period: LivePeriod, nowMs: number): boolean {
  if (period === 'all') return true
  return typeof deliveredAtMs === 'number' && nowMs - deliveredAtMs <= PERIOD_MS[period]
}

/** PURE: somebody is on it (working, waiting, or asking a person). */
export const hasSomeoneOn = (c: LiveTabbable): boolean => c.liveState === 'working' || c.liveState === 'waiting' || c.liveState === 'needs-you'

/** PURE: does a piece belong to the tab (a published one also has to be inside the period)? */
export function liveTabMatches(tab: LiveTab, c: LiveTabbable, period: LivePeriod, nowMs: number): boolean {
  if (c.stage === 'published' && !inPublishedPeriod(c.deliveredAtMs, period, nowMs)) return false
  switch (tab) {
    case 'active': return c.stage !== 'queue' && c.stage !== 'published' && c.stage !== 'completed' && !c.old && hasSomeoneOn(c)
    case 'queue': return c.stage === 'queue'
    case 'published': return c.stage === 'published'
    default: return true
  }
}

export function liveTabCounts(cards: readonly LiveTabbable[], period: LivePeriod, nowMs: number): Record<LiveTab, number> {
  const out = { active: 0, queue: 0, published: 0, all: 0 } as Record<LiveTab, number>
  for (const t of LIVE_TABS) out[t] = cards.filter(c => liveTabMatches(t, c, period, nowMs)).length
  return out
}

export type LiveSortId = 'priority' | 'time-in-stage' | 'recent'
export const LIVE_SORTS: readonly LiveSortId[] = ['priority', 'time-in-stage', 'recent']
export const LIVE_SORT_DEFAULT: LiveSortId = 'priority'

/** The slice of a delivery the order reads. */
export interface LiveSortable { key: string; priority?: string | null; stageSinceMs: number | null; old?: boolean; stage?: string; deliveredAtMs?: number | null }

/**
 * PURE: 0 = urgent … last = low. Absent, a legacy `none` and an unknown word rank as `low`, exactly as
 * the board's own priority sort does (`taskSort.ts`) — a typo must not promote a card above triaged work.
 */
export function priorityRank(p: string | null | undefined): number {
  const i = PRIORITY_ORDER.indexOf((p ?? DEFAULT_PRIORITY) as TaskPriorityId)
  return i === -1 ? PRIORITY_ORDER.length - 1 : i
}

/** Oldest in the stage first; a card with no stamp sorts last (nobody can say how long it has waited). */
const longestInStage = (a: LiveSortable, b: LiveSortable): number =>
  (a.stageSinceMs ?? Infinity) - (b.stageSinceMs ?? Infinity)

/**
 * PURE: the comparator of a sort. Every one is TOTAL (ends on the key) so nothing reshuffles between polls.
 *   - `priority`      highest priority first; a tie goes to the card that has been in the stage LONGER.
 *   - `time-in-stage` longest in the stage first.
 *   - `recent`        entered the stage most recently first.
 */
/** Inside Publicado the default order is the most recently PUBLISHED first; 0 when it is not two published pieces (or a tie). */
const publishedFirst = (a: LiveSortable, b: LiveSortable): number =>
  a.stage === 'published' && b.stage === 'published' ? (b.deliveredAtMs ?? 0) - (a.deliveredAtMs ?? 0) : 0

export function liveComparator(sort: LiveSortId): (a: LiveSortable, b: LiveSortable) => number {
  const inner = ((): ((a: LiveSortable, b: LiveSortable) => number) => {
    switch (sort) {
      case 'time-in-stage': return (a, b) => longestInStage(a, b) || a.key.localeCompare(b.key)
      case 'recent': return (a, b) => (b.stageSinceMs ?? -Infinity) - (a.stageSinceMs ?? -Infinity) || a.key.localeCompare(b.key)
      default: return (a, b) => publishedFirst(a, b) || priorityRank(a.priority) - priorityRank(b.priority) || longestInStage(a, b) || a.key.localeCompare(b.key)
    }
  })()
  // Whatever the sort, inside a column the current cards come before the "antiga" ones: an old legacy review is old BY
  // DEFINITION, so "longest in the stage" would otherwise bury every live card under them.
  return (a, b) => Number(a.old === true) - Number(b.old === true) || inner(a, b)
}

/** PURE: a stored/typed sort id → a known one (anything else is the default). */
export function parseLiveSort(raw: unknown): LiveSortId {
  return (LIVE_SORTS as readonly unknown[]).includes(raw) ? raw as LiveSortId : LIVE_SORT_DEFAULT
}

/** What the cap cut, in the shape both the server's view and the screen read (structural: core never imports the server's reply). */
export interface LiveCutFacts {
  /** Pieces the per-kind cap cut, per task. */
  cutByTask?: Record<string, { title: string; history: number; oldReviews: number }>
  /** The kept history's oldest publication (null when none). */
  oldestKeptMs: number | null
  /** The board-wide cut counts, used when no filter narrows the answer. */
  wholeHistory: number
  wholeOld: number
}

/**
 * PURE: how many pieces the cap left out of THIS answer. Without a filter it is the board's own cut; under a task
 * (`match`), a `stage` or a stalled-only filter only the cut pieces that match count — a task that lost nothing says
 * nothing. History is `published`, old reviews are `leader`. Stalled-only matches none (cut pieces are old, no live agent).
 */
export function liveCapOmitted(o: { facts: LiveCutFacts; tab: LiveTab; period: LivePeriod; nowMs: number; match?: (taskId: string, title: string) => boolean; stage?: string; stalledOnly?: boolean }): number {
  const { facts: f } = o
  const filtered = Boolean(o.match || (o.stage && o.stage !== 'all') || o.stalledOnly)
  const cut = (kind: 'history' | 'oldReviews', stage: string, whole: number): number => {
    if (!filtered) return whole
    if (o.stalledOnly || (o.stage && o.stage !== 'all' && o.stage !== stage)) return 0
    return Object.entries(f.cutByTask ?? {}).reduce((n, [id, c]) => n + (!o.match || o.match(id, c.title) ? c[kind] : 0), 0)
  }
  const history = cut('history', 'published', f.wholeHistory)
  const historyMatters = history > 0 && (o.tab === 'published' || o.tab === 'all')
    && (o.period === 'all' || (f.oldestKeptMs !== null && inPublishedPeriod(f.oldestKeptMs, o.period, o.nowMs)))
  return (historyMatters ? history : 0) + (o.tab === 'all' ? cut('oldReviews', 'leader', f.wholeOld) : 0)
}
