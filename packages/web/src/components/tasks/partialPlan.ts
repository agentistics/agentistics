/**
 * partialPlan — what a view may draw while the list is only STEP ONE of the split load (pure).
 *
 * Step one carries the open rows plus the closed ones touched in the last two days; step two adds
 * the rest of the closed history. The person must never see that seam: no row may move, no group may
 * change size, when step two lands. A view can honour that only if what step two adds lands where
 * nothing is drawn after it:
 *
 *  - the table grouped by STATUS, when the closed statuses are the LAST bands — the closed bands
 *    carry their true count (the overview's `statusCounts`) from the first paint and fill in at the
 *    bottom;
 *  - the kanban without swimlanes — a closed column grows downward and moves no other card.
 *
 * In both, the closed rows of step one are NOT drawn either: a recent closed row would sit among
 * older ones that arrive later (the sort interleaves them) and shift.
 *
 * Everything else — the table grouped by TYPE (closed rows interleave into every type band and the
 * band counts change), swimlanes (a lane holding only closed work would appear whole) or a status
 * order that puts a closed band before an open one — is HELD: nothing is drawn until the history
 * has arrived. That costs one cache-hit round trip, which beats a screen that jumps.
 */
import type { TaskListRow } from '../../lib/tasks'

export type PartialPlan =
  /** The list is complete (or the view does not read rows): draw it as is. */
  | 'full'
  /** Draw step one without its closed rows; the closed bands/columns show their true counts. */
  | 'trim-closed'
  /** Draw nothing until step two lands. */
  | 'hold'

export const CLOSED_STATUSES: ReadonlySet<string> = new Set(['done', 'abandoned'])

export interface PartialPlanInput {
  partial: boolean
  view: string
  groupBy: string
  lanes: string
  /** Status ids in the order the table draws its bands. */
  statusOrder: readonly string[]
}

export function planPartial(i: PartialPlanInput): PartialPlan {
  if (!i.partial) return 'full'
  if (i.view === 'overview' || i.view === 'live') return 'full'
  if (i.view === 'board') return i.lanes === 'none' ? 'trim-closed' : 'hold'
  if (i.view === 'table') {
    if (i.groupBy !== 'status') return 'hold'
    return closedStatusesLast(i.statusOrder) ? 'trim-closed' : 'hold'
  }
  return 'hold'
}

/** True when no open status is drawn after a closed one. */
export function closedStatusesLast(order: readonly string[]): boolean {
  let seenClosed = false
  for (const s of order) {
    if (CLOSED_STATUSES.has(s)) seenClosed = true
    else if (seenClosed) return false
  }
  return true
}

/** The rows a plan lets a view draw. `null` = hold (the page shows its loading state). */
export function rowsForPlan(rows: TaskListRow[] | null, plan: PartialPlan): TaskListRow[] | null {
  if (rows === null || plan === 'full') return rows
  if (plan === 'hold') return null
  return rows.filter(r => !CLOSED_STATUSES.has(r.task.status))
}
