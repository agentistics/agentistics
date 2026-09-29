/**
 * subtaskSortView.ts — the web's half of subtask sorting: what the shared comparator
 * (`@agentistics/core`'s `subtaskSort.ts`) is handed, read off the delivery's own detail.
 *
 * The comparator sorts what it is given and reads no rollup; the numbers a subtask column shows are
 * resolved HERE, through the same helpers the cells use (`subtaskRollupOf`, `costCellFor`,
 * `tokensCellFor`), so a column is ordered by exactly the figure printed in it — never a second
 * reading of the same rollup that could disagree with the cell beside it.
 */

import {
  sortSubtasks, type SubtaskMeasure, type SubtaskSortKey, type SubtaskSortSpec,
} from '@agentistics/core'
import type { Subtask, SubtaskView, TaskSessionRow } from '../../lib/tasks'
import { costCellFor, isUntracked, subtaskRollupOf, tokensCellFor } from './subtaskRollup'
import { isGroupMember } from './subtaskGroups'

/**
 * The measured figures of one subtask, `null` where the cell would draw nothing or "N/A".
 *
 *  - A GROUP MEMBER can never hold a session, so it has no measure at all (`undefined`) — it sorts
 *    with the rows nobody could measure, at the bottom.
 *  - `sessions` is the count of sessions filed on it. A subtask with none has a real zero there (it
 *    was asked and the answer is none), unlike cost, which is empty until a session exists.
 *  - A Copilot-credits cost has no dollar figure to compare against a dollar one, so it counts as
 *    "no answer" rather than being converted by a guessed rate.
 *  - `rounds` follows the exact same `isUntracked` rule cost and tokens already do (`null` until a
 *    session is actually filed, never a stray value the rollup happens to carry from before) — no
 *    subtask grid draws a "rounds" column of its own today, so this key is reached only through
 *    `subtaskSortInherit.ts`'s inheritance from the main table's "Your prompts" column.
 */
export function measureOfSubtask(
  subtask: Subtask,
  views: readonly SubtaskView[],
  sessions: readonly TaskSessionRow[],
): SubtaskMeasure | undefined {
  if (isGroupMember(subtask)) return undefined
  const r = subtaskRollupOf(views, subtask)
  const cost = costCellFor(r)
  const tok = tokensCellFor(r)
  return {
    sessions: sessions.filter(s => s.subtaskId === subtask.id).length,
    rounds: isUntracked(r) ? null : r!.rounds,
    costUSD: cost.kind === 'money' ? cost.usd : null,
    tokens: tok.kind === 'tokens' ? tok.n : null,
  }
}

/**
 * The subtasks in the order a header asked for, ready to hand to `clusterSubtaskRows`.
 *
 * It sorts the FLAT list; the cluster is rebuilt from it by the renderer (a group's header where the
 * sorted list puts it, its members beneath in their sorted order), so a group and its members can
 * never be pulled apart by a sort.
 */
export function orderedSubtasks(
  subtasks: readonly Subtask[],
  spec: SubtaskSortSpec | null,
  ctx: {
    views: readonly SubtaskView[]
    sessions: readonly TaskSessionRow[]
    statusOrder: readonly string[]
  },
): Subtask[] {
  return sortSubtasks(subtasks, spec, {
    statusOrder: ctx.statusOrder,
    measureOf: s => measureOfSubtask(s, ctx.views, ctx.sessions),
  })
}

/** Columns a subtask list can be ordered by, in the order the grids draw them. `rounds` is
 *  deliberately absent — no subtask grid draws a "rounds"/"Your prompts" column of its own, so
 *  there is no header here to click; that key is reached only by inheriting the main table's own
 *  sort (`subtaskSortInherit.ts`). `duration` needs no `measureOf` entry — it is read straight off
 *  the subtask's own `startedAt`/`deliveredAt` by the comparator, not measured through sessions. */
export const SUBTASK_SORT_KEYS: readonly SubtaskSortKey[] =
  ['title', 'status', 'started', 'completed', 'duration', 'sessions', 'cost', 'tokens']
