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

/**
 * THE THREE-PIECE BAR'S GEOMETRY — a left pill (`left` slots), a standalone round centre button and
 * a right pill (`right` slots), the two pills separated by `spacer` pixels (the circle sits in it).
 * Slot order is left pill, centre, right pill, which is the order of the items.
 */
export interface BarSlot { left: number; width: number; kind: 'left' | 'centre' | 'right' }

export function barSlots(width: number, spacer: number, left: number, right: number, outer = 0, inner = 0): BarSlot[] {
  if (width <= 0) return []
  const pill = Math.max(0, (width - spacer) / 2)
  const usable = Math.max(0, pill - outer - inner)
  const out: BarSlot[] = []
  for (let i = 0; i < left; i++) out.push({ left: outer + (usable / left) * i, width: usable / left, kind: 'left' })
  out.push({ left: pill, width: spacer, kind: 'centre' })
  for (let i = 0; i < right; i++) out.push({ left: pill + spacer + inner + (usable / right) * i, width: usable / right, kind: 'right' })
  return out
}

/** The slot under `x`: inside a pill its own slot, in the gap between them the centre button. */
export function barSlotAt(x: number, slots: BarSlot[]): number {
  if (slots.length === 0) return 0
  const centre = slots.findIndex(s => s.kind === 'centre')
  const c = slots[centre]!
  // The circle is wider than the gap: it answers a little beyond it, so a thumb on its edge lands.
  const reach = 14
  if (x >= c.left - reach && x <= c.left + c.width + reach) return centre
  const i = slots.findIndex(s => s.kind !== 'centre' && x >= s.left && x < s.left + s.width)
  if (i >= 0) return i
  return x < c.left ? 0 : slots.length - 1
}

/** The indicator's left edge while it follows the finger inside the pill the finger is over. */
export function barFollow(x: number, slots: BarSlot[], inset: number): number {
  const at = slots[barSlotAt(x, slots)]
  if (!at || at.kind === 'centre') return 0
  const side = slots.filter(s => s.kind === at.kind)
  const w = Math.max(0, at.width - inset * 2)
  const lo = side[0]!.left + inset
  const hi = side[side.length - 1]!.left + side[side.length - 1]!.width - inset - w
  return Math.min(hi, Math.max(lo, x - w / 2))
}
