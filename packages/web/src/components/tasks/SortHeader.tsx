/**
 * SortHeader — the column title that sorts, drawn ONCE for every list on the board.
 *
 * The table's headers, the subtask grids, the repository's Tasks tab and the central's board all
 * order their rows when a title is clicked, and they must look and answer the same way: a real
 * `<button>` inside the `<th>` (so it is reachable and operable from the keyboard), `aria-sort` on
 * the `th` saying which column is in force, and an arrow on that one column only. A column that
 * cannot be sorted gets NO button — a title that looks clickable and does nothing is worse than a
 * plain one.
 *
 * The ORDERING lives in `@agentistics/core` (`taskSort.ts` / `subtaskSort.ts`); this file draws the
 * affordance and decides nothing about what a click means beyond handing the key back.
 */

import type { CSSProperties, ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { ariaSortOf, type SortDir } from '@agentistics/core'
import { useState } from 'react'
import { microLabel } from './board'
import { columnDragType, isColumnDrag } from './columnOrder'

/** The button inside a header — also the kanban column's sort trigger, so they cannot drift. */
export function SortButton({ label, dir, onClick, title, mobile, align = 'left', expanded }: {
  label: ReactNode
  /** The direction in force on THIS column, or `null` when the list is ordered by another one. */
  dir: SortDir | null
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  title?: string
  mobile: boolean
  align?: 'left' | 'right'
  /** For a button that opens a menu rather than cycling directly (the kanban). */
  expanded?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      aria-expanded={expanded}
      style={{
        ...microLabel, fontWeight: 600, background: 'none', border: 'none',
        cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 3,
        flexDirection: align === 'right' ? 'row-reverse' : 'row',
        minHeight: mobile ? 44 : undefined, minWidth: mobile ? 44 : undefined, fontFamily: 'inherit',
        color: dir ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
      }}
    >
      {label}
      {dir && (dir === 'asc' ? <ArrowUp size={11} aria-hidden /> : <ArrowDown size={11} aria-hidden />)}
    </button>
  )
}

/** A `<th>` for one column: sortable when it names a key, plain text when it does not. */
export function SortTh<K extends string>({ label, sortKey, current, onSort, style, mobile, title, align, handle, dataCol, reorder }: {
  label: ReactNode
  /** Absent = the column is not sortable, and carries no affordance. */
  sortKey?: K
  current: { key: K; dir: SortDir } | null
  onSort: (key: K) => void
  style?: CSSProperties
  mobile: boolean
  /** The tooltip, already in the reader's language ("Sort by Cost"). */
  title?: string
  align?: 'left' | 'right'
  /** A resize handle drawn on the header's trailing border. */
  handle?: ReactNode
  /** Marks the header so a double-click can measure the whole column. */
  dataCol?: string
  /**
   * Let this header be DRAGGED to reorder the table's columns. `scope` names the table (a drag from
   * another table is not accepted), `id` is this column, `onMove(dragId, dropId)` writes the new order —
   * the SAME array the "Columns" dropdown writes. The dropdown stays the keyboard/touch way: HTML5 drag
   * does not exist on a touch screen, and this adds nothing a keyboard needs.
   */
  reorder?: { scope: string; id: string; onMove: (dragId: string, dropId: string) => void }
}) {
  const [dragging, setDragging] = useState(false)
  const [over, setOver] = useState(false)
  const a = align ?? (style?.textAlign === 'right' ? 'right' : 'left')
  return (
    <th
      // `whiteSpace: 'nowrap'` by default — a header that wraps ("CONCLUÍDO EM" onto two lines) is
      // never worth breaking a column over; the table already scrolls inside its own container
      // (`overflow-x: auto`) rather than the page. Every caller may still override it explicitly.
      style={{
        whiteSpace: 'nowrap', ...(handle ? { position: 'relative', overflow: 'hidden', textOverflow: 'ellipsis' } : {}), ...style,
        ...(dragging ? { opacity: 0.45 } : {}),
        // The drop target is marked on its LEADING edge: the dragged column lands before it.
        ...(over ? { boxShadow: 'inset 3px 0 0 var(--anthropic-orange)' } : {}),
      }}
      {...(dataCol ? { 'data-col': dataCol } : {})}
      {...(reorder ? {
        draggable: true,
        'data-col-draggable': reorder.id,
        onDragStart: (e: React.DragEvent) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(columnDragType(reorder.scope), reorder.id)
          setDragging(true)
        },
        onDragEnd: () => { setDragging(false); setOver(false) },
        onDragOver: (e: React.DragEvent) => {
          if (!isColumnDrag(e.dataTransfer.types, reorder.scope)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (!over) setOver(true)
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: React.DragEvent) => {
          setOver(false)
          if (!isColumnDrag(e.dataTransfer.types, reorder.scope)) return
          e.preventDefault()
          const dragId = e.dataTransfer.getData(columnDragType(reorder.scope))
          if (dragId && dragId !== reorder.id) reorder.onMove(dragId, reorder.id)
        },
      } : {})}
      aria-sort={sortKey ? ariaSortOf(current, sortKey) : undefined}
    >
      {sortKey
        ? (
          <SortButton
            label={label}
            dir={current && current.key === sortKey ? current.dir : null}
            onClick={() => onSort(sortKey)}
            title={title}
            mobile={mobile}
            align={a}
          />
        )
        : label}
      {handle}
    </th>
  )
}
