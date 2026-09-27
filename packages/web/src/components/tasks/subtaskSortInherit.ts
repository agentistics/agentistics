/**
 * subtaskSortInherit.ts — which order a task row's inline SUBTASK GRID (`TaskTable.tsx`'s
 * `SubtaskRows`) actually sorts by, when the MAIN table can also drive it.
 *
 * Before this, the two were unrelated: sorting the main table by "Cost" left every expanded task's
 * subtask grid exactly as it was (creation order, or whatever that one grid's own header had been
 * clicked to). Reported as "a tabela de subtarefas ordena sozinha". The fix is inheritance, not a
 * second copy of the main sort: clicking a MAIN header re-sorts every task AND, when the column
 * genuinely means the same thing on a subtask (status, sessions, prompts/rounds, cost, tokens,
 * start/started, delivered/done date), re-sorts every expanded grid by it too. A main column with no
 * subtask equivalent (priority, due date, manual hand order, attempts, comments, subtask count,
 * progress, harnesses) leaves every grid in its own order — there is nothing to translate it to.
 *
 * **This module owns exactly one question: which sort is in force for ONE grid, right now** —
 * inherited from the main table, overridden by a click on that grid's OWN header, or cleared back to
 * inheritance. It mirrors `columnSort.ts`'s three-layer shape (the kanban's per-status order over the
 * board's own default) applied to a different pair of types: `inheritedSubtaskSort` is the
 * translation, `effectiveSubtaskSort` is "override, else inherited" (`columnSort.ts`'s
 * `effectiveSort`), and `pickSubtaskSort` is a header click (`columnSort.ts`'s `pickColumnSort`) —
 * cycling from the EFFECTIVE current order (so a grid already following the main table's sort
 * continues the cycle rather than restarting at ascending) and dropping the override outright the
 * moment it would only repeat what inheritance already gives, the same de-duplication
 * `withColumnSort` applies to the kanban's own overrides.
 *
 * The override is stored exactly where `TaskTable.tsx`'s `subSort` already lives — a plain
 * `Record<taskId, SubtaskSortSpec | null>` component-state map, `null` meaning "no override, follow
 * whatever the main table's sort translates to" (it used to mean "creation order" outright; that
 * reading is now folded into `inheritedSubtaskSort` returning `null` for an unmapped column). No new
 * store: this module decides values, `TaskTable.tsx` keeps holding them exactly as it did.
 */

import { cycleSort, type SortKey, type SortSpec, type SubtaskSortKey, type SubtaskSortSpec } from '@agentistics/core'

/**
 * Main table columns that genuinely correspond to a subtask column — the value means the same thing
 * on both grids. A key absent here has no subtask equivalent (`manual`, `priority`, `due`, `created`,
 * `updated`, `attempts`, `comments`, `subtasks`, `progress`, `harnesses`), so sorting the main table
 * by it leaves every subtask grid in its own order. `delivered` maps to `completed` — the two fields
 * are `Task.deliveredAt`/`Subtask.deliveredAt`, the same fact one level apart.
 */
export const MAIN_TO_SUBTASK_SORT_KEY: Partial<Record<SortKey, SubtaskSortKey>> = {
  title: 'title',
  status: 'status',
  started: 'started',
  delivered: 'completed',
  sessions: 'sessions',
  rounds: 'rounds',
  cost: 'cost',
  tokens: 'tokens',
}

/** The main table's sort, translated to the subtask grid's own vocabulary — `null` when the main
 *  key has no subtask equivalent, in which case a grid with no override of its own keeps its
 *  original (creation) order. */
export function inheritedSubtaskSort(main: SortSpec): SubtaskSortSpec | null {
  const key = MAIN_TO_SUBTASK_SORT_KEY[main.key]
  return key ? { key, dir: main.dir } : null
}

/** The order ONE task's subtask grid actually draws in: an explicit override set on THAT grid's own
 *  header, or — absent one — whatever the main table's sort translates to (`inheritedSubtaskSort`,
 *  possibly `null` itself). */
export function effectiveSubtaskSort(
  main: SortSpec, override: SubtaskSortSpec | null,
): SubtaskSortSpec | null {
  return override ?? inheritedSubtaskSort(main)
}

const sameSpec = (a: SubtaskSortSpec | null, b: SubtaskSortSpec | null): boolean =>
  a === b || (a !== null && b !== null && a.key === b.key && a.dir === b.dir)

/**
 * A click on one subtask header: the new OVERRIDE for that grid (never the effective sort — a grid
 * with no override keeps reading `null` as "follow the main table" for as long as that remains true).
 *
 * Cycles from the grid's current EFFECTIVE order (`none → asc → desc → none`, `@agentistics/core`'s
 * `cycleSort`) rather than from the raw override, so a grid already sorted by inheritance continues
 * that cycle instead of restarting at ascending on the first click. Landing back on exactly what
 * inheritance already gives is stored as `null` — an override that only repeats the inherited order
 * is not a statement worth keeping, the same rule `columnSort.ts`'s `withColumnSort` applies to the
 * kanban's own per-status overrides.
 */
export function pickSubtaskSort(
  main: SortSpec, override: SubtaskSortSpec | null, key: SubtaskSortKey,
): SubtaskSortSpec | null {
  const current = effectiveSubtaskSort(main, override)
  const next = cycleSort(current, key)
  const inherited = inheritedSubtaskSort(main)
  return next !== null && inherited !== null && sameSpec(next, inherited) ? null : next
}
