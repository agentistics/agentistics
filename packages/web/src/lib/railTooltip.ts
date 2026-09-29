/**
 * railTooltip.ts — PURE: whether the right rail's tooltip may stay open.
 *
 * The tooltip opens on `mouseenter`/`focus` and closes on the matching leave/blur. A DRAG breaks
 * both halves: the browser fires no `mouseleave` while an HTML5 drag is in flight, and once the drop
 * MOVES the panel into the bottom bar its rail button unmounts, so no leave event ever arrives —
 * the tooltip stayed on screen, pinned to a rect that no longer exists, with no pointer anywhere
 * near it (owner, 2026-09-29). So: nothing is shown while a drag is in flight, and a tooltip whose
 * icon is no longer in the rail is gone.
 */
export function railTooltipShown<T extends string>(
  named: { id: T } | null,
  visibleIds: readonly T[],
  dragging: boolean,
): boolean {
  if (named === null || dragging) return false
  return visibleIds.includes(named.id)
}
