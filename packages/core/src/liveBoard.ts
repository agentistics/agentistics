/**
 * liveBoard — PURE. The two rules the Live Delivery line ("Esteira de entregas ao vivo") applies to the
 * pieces it draws, written ONCE so the screen and the MCP tool (`agentistics_live_delivery`) can never
 * answer differently:
 *
 *   1. WHICH cards are shown — two independent switches, one per group of columns.
 *   2. In WHICH ORDER a column lists them — by priority (highest first), by time in the stage, or newest.
 *
 * Nothing here knows about fleets, sessions or React: it reads only `stage`, `priority`, `stageSinceMs`
 * and `key` off a delivery, so the browser's `LiveCard.d` and the server's `LiveDelivery` both satisfy it.
 */

import { PRIORITY_ORDER, DEFAULT_PRIORITY, type TaskPriorityId } from './taskSort'

/** Every column of the line, left to right. */
export type LiveBoardStage = 'queue' | 'blocked' | 'running' | 'qa' | 'adjust' | 'leader' | 'merge' | 'ci' | 'published'

/**
 * The two switches of the filter bar. They are the owner's words, 07/11:
 *   - `onlyActive` ("apenas ativas"): the cards in the columns AFTER the queue — Bloqueado onward,
 *     Revisão do líder, PR / merge, CI and Publicado included.
 *   - `showQueue` ("exibir itens na fila"): the cards of the Na fila column.
 * Both on is the default and shows everything. A piece still in planning (no pre-dispatch) is not a
 * card at all, so no combination of these can hide something that was ever in the flow by accident.
 */
export interface LiveFlowFilter { onlyActive: boolean; showQueue: boolean }
export const LIVE_FLOW_DEFAULTS: LiveFlowFilter = { onlyActive: true, showQueue: true }

/** PURE: does this stage's group survive the two switches? */
export function stageVisible(stage: LiveBoardStage, f: LiveFlowFilter): boolean {
  return stage === 'queue' ? f.showQueue : f.onlyActive
}

export type LiveSortId = 'priority' | 'time-in-stage' | 'recent'
export const LIVE_SORTS: readonly LiveSortId[] = ['priority', 'time-in-stage', 'recent']
export const LIVE_SORT_DEFAULT: LiveSortId = 'priority'

/** The slice of a delivery the order reads. */
export interface LiveSortable { key: string; priority?: string | null; stageSinceMs: number | null }

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
export function liveComparator(sort: LiveSortId): (a: LiveSortable, b: LiveSortable) => number {
  switch (sort) {
    case 'time-in-stage': return (a, b) => longestInStage(a, b) || a.key.localeCompare(b.key)
    case 'recent': return (a, b) => (b.stageSinceMs ?? -Infinity) - (a.stageSinceMs ?? -Infinity) || a.key.localeCompare(b.key)
    default: return (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || longestInStage(a, b) || a.key.localeCompare(b.key)
  }
}

/** PURE: a stored/typed sort id → a known one (anything else is the default). */
export function parseLiveSort(raw: unknown): LiveSortId {
  return (LIVE_SORTS as readonly unknown[]).includes(raw) ? raw as LiveSortId : LIVE_SORT_DEFAULT
}
