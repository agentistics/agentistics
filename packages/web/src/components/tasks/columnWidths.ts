/**
 * columnWidths — PURE: how wide each column of the Agentask table is.
 *
 * A column has a DEFAULT width (`ColumnDef.width`) and, once a person drags a header border, a
 * saved one. The saved record lives in `boardPrefs` (per person, like every other arrangement), is
 * keyed by column id, and holds only what was changed — so a default that changes in a later build
 * still reaches everyone who never touched that column.
 */

export const MIN_COL_WIDTH = 56
export const MAX_COL_WIDTH = 640

/** Clamp a dragged or measured width to a range a column can sensibly have. */
export function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return MIN_COL_WIDTH
  return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(w)))
}

/** Saved widths over the defaults. An unknown id or a non-number saved value is ignored. */
export function resolveWidths(
  columns: ReadonlyArray<{ id: string; width: number }>,
  saved: Readonly<Record<string, number>>,
  /** Computed defaults (`columnDefaultWidth.ts`) — used only for a column nobody resized. */
  defaults: Readonly<Record<string, number>> = {},
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of columns) {
    const s = saved[c.id]
    out[c.id] = typeof s === 'number' && Number.isFinite(s) ? clampWidth(s) : (defaults[c.id] ?? c.width)
  }
  return out
}

/** Double-click: wide enough for the widest measured cell (header included), plus a hair. */
export function fitContentWidth(measures: ReadonlyArray<number>): number {
  const widest = measures.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0)
  return clampWidth(widest + 2)
}

/** Does the person have any custom width — i.e. is the "restore" button worth showing? */
export function hasCustomWidths(saved: Readonly<Record<string, number>>): boolean {
  return Object.keys(saved).length > 0
}

/** Drag: the new width from where the pointer started. */
export function dragWidth(startWidth: number, startX: number, x: number, rtl = false): number {
  return clampWidth(startWidth + (rtl ? startX - x : x - startX))
}

/** The sum the table needs, so a scroller can be wider than the screen instead of squeezing. */
export function tableMinWidth(lead: number, title: number, widths: Record<string, number>, ids: string[]): number {
  return lead + title + ids.reduce((n, id) => n + (widths[id] ?? 0), 0)
}

/**
 * DOM: the width a cell's CONTENT needs, padding included, ignoring the resize handle.
 *
 * `scrollWidth` cannot answer this — it is never below the cell's own width, so a fit could only
 * ever grow a column. A Range over the content reports what the content actually occupies.
 */
export function contentWidthOf(cell: HTMLElement): number {
  const cs = getComputedStyle(cell)
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  let left = Infinity
  let right = -Infinity
  for (const child of Array.from(cell.childNodes)) {
    if (child instanceof HTMLElement && child.hasAttribute('data-col-resize')) continue
    const r = document.createRange()
    r.selectNode(child)
    const b = r.getBoundingClientRect()
    if (b.width === 0 && b.height === 0) continue
    left = Math.min(left, b.left)
    right = Math.max(right, b.right)
  }
  return right > left ? right - left + pad : pad
}
