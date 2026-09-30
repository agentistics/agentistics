/**
 * THE MOBILE BOTTOM BAR'S DRAG ARITHMETIC — pure, so the geometry the finger drives is tested
 * rather than eyeballed on a phone.
 *
 * The bar is `count` equal slots across `width` pixels. A tap lands on a slot through the ordinary
 * click; a DRAG moves the indicator under the finger and, on release, activates the slot the finger
 * is over. Everything below answers one of those two questions, from a position measured in the
 * bar's own coordinates (0 = its left edge).
 */

/** How far a press may travel before it stops being a tap and becomes a drag. Below it the press
 *  is left to the click handler, so a slightly shaky tap still reads as a tap. */
export const DRAG_THRESHOLD_PX = 6

/** The slot under `x`. Outside the bar the nearest end slot answers: a finger that overshoots the
 *  edge still means the last item, not nothing. */
export function slotAt(x: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return 0
  const i = Math.floor((x / width) * count)
  return Math.min(count - 1, Math.max(0, i))
}

/** The indicator's left edge while it follows the finger: centred on `x`, clamped so it never
 *  leaves the bar. `inset` is the gap kept between the indicator and its slot's edges. */
export function followOffset(x: number, width: number, count: number, inset: number): number {
  if (count <= 0 || width <= 0) return 0
  const slot = width / count
  const w = Math.max(0, slot - inset * 2)
  const left = x - w / 2
  return Math.min(width - inset - w, Math.max(inset, left))
}

/** The indicator's left edge at rest on slot `i`. */
export function restOffset(i: number, width: number, count: number, inset: number): number {
  if (count <= 0 || width <= 0) return 0
  return (width / count) * i + inset
}

/** Whether a press that has travelled `dx` horizontally has become a drag. */
export function isDrag(dx: number): boolean {
  return Math.abs(dx) >= DRAG_THRESHOLD_PX
}
