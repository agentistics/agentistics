/**
 * columnOrder.ts — dragging a column HEADER to a new place, as pure arithmetic.
 *
 * The "Columns" dropdown (`PickerMenu` `orderable`) is the keyboard- and touch-accessible way to order
 * the columns, and it writes ONE value: the array of shown column ids in the order they are drawn
 * (`boardPrefs.columns` / `boardPrefs.subtaskColumns`). Dragging a header must write exactly that same
 * array — never a second representation — so the two always agree and every existing preference keeps
 * working. `moveColumn` is the whole of it: take the array the table is drawing, move one id onto
 * another's place, hand back the array to store.
 *
 * A drag carries its table in its type (`columnDragType(scope)`): a header dragged out of the delivery
 * table is not offered a drop on the subtask grid beside it, which orders a different list.
 */
import { reorderByDrag } from '../../lib/dragReorder'

/** The drop result for the stored array: `drag` lands where `drop` is. Total — see `reorderByDrag`. */
export function moveColumn<T extends string>(shown: readonly T[], drag: T, drop: T): T[] {
  return reorderByDrag(shown, drag, drop)
}

const PREFIX = 'application/x-agentask-column.'

/** The DataTransfer type a column drag of this table carries (lower-case: browsers lower-case types). */
export function columnDragType(scope: string): string {
  return `${PREFIX}${scope.toLowerCase()}`
}

/** Is a drag that carries `types` a column of THIS table? (A drag of text or of another table is not.) */
export function isColumnDrag(types: readonly string[] | DOMStringList, scope: string): boolean {
  const want = columnDragType(scope)
  return Array.from(types).includes(want)
}
