/**
 * subtaskColumnDefs — which columns the SUBTASKS grid shows, in the same shape `board.ts`'s
 * `ColumnId`/`COLUMNS` give the delivery table (t-63b7d3b2b0 #1).
 *
 * A SEPARATE id space from `ColumnId`, deliberately: the subtask grid and the delivery table show
 * different facts (a subtask has no priority or claim; a delivery has no per-row Model), so
 * colliding on one union would force either table onto the other's set the moment either one grows
 * a column the other does not have. `title` is not a member here for the same reason it is not one
 * of `ColumnId` on the delivery table: the row's own name is the one column that can never be
 * hidden, so it is drawn outside the picker entirely, by every caller, exactly as `TaskTable.tsx`
 * already draws its own title column outside `COLUMNS`.
 */

export type SubtaskColumnId =
  | 'status' | 'started' | 'completed' | 'duration' | 'sessions' | 'model' | 'cost' | 'tokens'

export interface SubtaskColumnDef {
  id: SubtaskColumnId
  /** Right-aligned, tabular. */
  numeric?: boolean
  width: number
}

/** Left to right, the order a fresh board shows them in — unchanged from the table's own previous
 *  fixed sequence, with `model` (a new column, t-63b7d3b2b0 #3) placed beside `sessions`, the other
 *  column that reads the raw session list rather than the server's rollup. */
export const SUBTASK_COLUMNS: SubtaskColumnDef[] = [
  { id: 'status', width: 100 },
  { id: 'started', width: 118 },
  { id: 'completed', width: 118 },
  { id: 'duration', numeric: true, width: 80 },
  { id: 'sessions', width: 190 },
  { id: 'model', width: 140 },
  { id: 'cost', numeric: true, width: 88 },
  { id: 'tokens', numeric: true, width: 84 },
]

/** Every column shown, in the fixed order above — a fresh board must not lose the columns it had
 *  before this picker existed. */
export const DEFAULT_SUBTASK_COLUMNS: SubtaskColumnId[] = SUBTASK_COLUMNS.map(c => c.id)
