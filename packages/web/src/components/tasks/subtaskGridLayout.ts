/**
 * subtaskGridLayout.ts — PURE: the widths of the SUBTASK grid, which is its own table and never
 * borrows the delivery table's columns.
 *
 * It used to have two layouts. In `inline` mode an expanded delivery's subtasks were drawn as rows
 * of the delivery table itself, and that table is `table-layout: fixed` with a `<colgroup>` sized by
 * the DELIVERY columns — so a subtask cell's own `width` was ignored by the browser, every subtask
 * column sat under whatever delivery column happened to be above it ("Subtarefas" under "Tarefa",
 * "Sessões" under "Progresso"), and dragging a subtask header border saved a width nothing read.
 * The grid is now ALWAYS one cell of the delivery table holding its own table, sized here.
 *
 * The table is given its EXACT width (`total`), never `width: 100%`: with every column fixed, a
 * table wider than their sum hands the surplus to all of them in proportion, so a dragged border
 * moved by a fraction of the drag and a saved width never rendered as the number saved. The
 * surrounding box scrolls sideways when the grid is wider than the row.
 */
import { MAX_COL_WIDTH, resolveWidths } from './columnWidths'
import { SUBTASK_COLUMNS, type SubtaskColumnId } from './subtaskColumnDefs'

/** The saved-width key of the always-shown name column ("Subtarefas"). Not a `SubtaskColumnId`:
 *  it is never in the "Columns" picker, but it resizes like every other column. */
export const SUBTASK_TITLE_ID = 'title'
export const SUBTASK_TITLE_WIDTH = 280
/** The leading cell: the gear menu plus the thread button beside it (measured: 51px + 20px padding,
 *  plus room for a comment count). */
export const SUBTASK_LEAD_WIDTH = 84

export interface SubtaskGridWidths {
  lead: number
  title: number
  /** One entry per SHOWN subtask column. */
  cols: Record<string, number>
  /** lead + title + every shown column + `trailing` — the table's own width. */
  total: number
}

/**
 * @param shown the shown subtask columns, in order.
 * @param saved the person's saved widths (`boardPrefs.subtaskColumnWidths`), keyed by column id plus
 *   `SUBTASK_TITLE_ID`.
 * @param dragging the width being dragged right now, laid over the saved one.
 * @param opts.trailing a fixed column after the grid (the standalone page's actions column), 0 if none.
 * @param opts.lead the leading cell's width, `SUBTASK_LEAD_WIDTH` unless the surface draws it narrower.
 */
export function subtaskGridWidths(
  shown: readonly SubtaskColumnId[],
  saved: Readonly<Record<string, number>>,
  dragging: { id: string; w: number } | null = null,
  opts: { trailing?: number; lead?: number } = {},
): SubtaskGridWidths {
  const lead = opts.lead ?? SUBTASK_LEAD_WIDTH
  const trailing = opts.trailing ?? 0
  const defs = [
    { id: SUBTASK_TITLE_ID, width: SUBTASK_TITLE_WIDTH },
    ...shown.map(id => SUBTASK_COLUMNS.find(c => c.id === id)!).filter(Boolean),
  ]
  const w = resolveWidths(defs, saved)
  if (dragging && dragging.id in w) w[dragging.id] = Math.min(MAX_COL_WIDTH, dragging.w)
  const title = w[SUBTASK_TITLE_ID]!
  const cols: Record<string, number> = {}
  for (const id of shown) if (w[id] !== undefined) cols[id] = w[id]!
  const total = lead + title + Object.values(cols).reduce((n, v) => n + v, 0) + trailing
  return { lead, title, cols, total }
}
