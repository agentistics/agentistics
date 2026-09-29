/**
 * subtaskGridLayout.ts — whether an expanded delivery's subtasks fit in the MAIN table's own rows,
 * or need their own nested one.
 *
 * `TaskTable.tsx` draws an expanded delivery's subtasks as rows of the SAME `<table>` as the main
 * rows: a sub-header row, then one row per subtask (`SubtaskRows`), then a "+ Add subtask" row. Its
 * main row always carries exactly `cols.length + 2` cells — a leading cell, the title, then one per
 * shown column (`COLUMNS.filter(shown)`) — and the "Columns" picker has no floor on how few of those
 * a reader may hide.
 *
 * The subtask rows draw a leading action-menu cell, the title, then one cell per shown SUBTASK
 * column (`SubtaskColumnId` — status/started/completed/duration/sessions/model/cost/tokens, itself
 * now picked/hidden/reordered by its own "Columns" picker, t-63b7d3b2b0 #1) plus a filler cell that
 * closes the row out to `cols.length + 2`. That arithmetic only has a filler to grow when
 * `cols.length >= subtaskColsCount` (`filler = cols.length - subtaskColsCount`, clamped at 0) — hide
 * enough of the MAIN table's own columns and the subtask row's fixed cells alone already overshoot
 * `cols.length + 2`, so the subtask rows end up WIDER than the main rows in the same table and every
 * column in every row below them misaligns.
 *
 * `subtaskGridLayout` is the one place that decides which of the table's two layouts a delivery's
 * subtasks get, so the arithmetic behind it is tested independently of the JSX that reads it:
 *
 * - **`inline`** (`colsCount >= subtaskColsCount`): the sub-header row and `SubtaskRows` are drawn as
 *   rows of the outer table, closed out by `filler` cells.
 * - **`nested`** (fewer): the whole subtask block for that delivery is ONE row of the outer table —
 *   a leading cell plus a single cell spanning the rest, holding its OWN table with the subtask
 *   grid's own shown columns, scrolling horizontally inside itself rather than ever widening the
 *   outer one. That inner table is sized as though the outer table held exactly `subtaskColsCount`
 *   columns, which is what makes its own filler come out to zero.
 */

export type SubtaskGridMode = 'inline' | 'nested'

export interface SubtaskGridLayout {
  mode: SubtaskGridMode
  /**
   * The filler cell's `colSpan`, for the `inline` mode only — 0 means no filler cell at all. Always
   * 0 in `nested` mode: the nested table is sized to `subtaskColsCount` internally, which needs
   * none.
   */
  filler: number
}

/**
 * @param colsCount the MAIN table's own shown column count (`cols.length` in `TaskTable.tsx`).
 * @param subtaskColsCount how many columns the SUBTASK grid currently shows (its own "Columns"
 *   picker's selection) — the threshold moves with it, since hiding subtask columns is exactly what
 *   lets a narrower main table stay `inline`.
 */
export function subtaskGridLayout(colsCount: number, subtaskColsCount: number): SubtaskGridLayout {
  if (colsCount >= subtaskColsCount) {
    return { mode: 'inline', filler: Math.max(0, colsCount - subtaskColsCount) }
  }
  return { mode: 'nested', filler: 0 }
}
