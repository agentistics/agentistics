/**
 * placeDetail — PURE: where the calendar's detail popover goes so it is ALWAYS fully on screen
 * (CALENDARIO.POPUP-VISIVEL, owner 2026-11-17: it opened partly off-screen depending on resolution).
 *
 * The old rule clamped `top` against `vh - 380`, a guess at the popover's height — but it can be
 * 560 tall, so on any ordinary window a click in the lower half put its foot below the fold. Here the
 * height is the MEASURED one: it opens beside the click (right, flipped to the left at the right
 * edge), top near the click, shifted up by exactly what it overflows, never above / left of the
 * margin. `h` is capped to the viewport first, so a popover taller than the window scrolls inside
 * itself rather than hanging out of it.
 */
export interface Placed { left: number; top: number; width: number; maxHeight: number; flipped: boolean }

export const DETAIL_MARGIN = 8
/** The popover's own CSS cap. */
export const DETAIL_MAX_H = 560

export function placeDetail(
  anchor: { x: number; y: number } | null,
  size: { w: number; h: number },
  vw: number, vh: number,
): Placed {
  const m = DETAIL_MARGIN
  const width = Math.min(size.w, Math.max(0, vw - 2 * m))
  const maxHeight = Math.max(0, vh - 2 * m)
  const h = Math.min(size.h, maxHeight)
  const ax = anchor?.x ?? vw / 2
  const ay = anchor?.y ?? 120
  let left = ax + 14
  let flipped = false
  if (left + width > vw - m) { left = ax - 14 - width; flipped = true }
  left = Math.max(m, Math.min(left, vw - width - m))
  let top = ay - 30
  if (top + h > vh - m) top = vh - m - h
  top = Math.max(m, top)
  return { left, top, width, maxHeight, flipped }
}
