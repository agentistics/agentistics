/**
 * pageFit — a screen that FILLS the page (the Live board) says so, and the page frame stops adding
 * things below it.
 *
 * The routed page scrolls inside its panel and ends with the app footer. A screen that sizes itself to
 * the room it is given (the Live Delivery board, owner 06/11: "desktop never scrolls vertically") would
 * otherwise sit above that footer and push the page taller than the panel — a vertical scroll that is
 * the footer's, not the screen's. While at least one such screen is mounted the frame omits the footer.
 *
 * A counter, not a flag: the board can mount in a second place (the shortcut popover is `compact` and
 * never registers, but a window opened from it does) and an unmount must not lift a fit another still holds.
 */
import { useSyncExternalStore } from 'react'

let holders = 0
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

/** Register a screen that fills the page; returns the function that lets go. Idempotent per call site. */
export function holdPageFit(): () => void {
  holders++
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    holders = Math.max(0, holders - 1)
    emit()
  }
}

export const pageFitActive = (): boolean => holders > 0

export function usePageFit(): boolean {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    pageFitActive,
    () => false,
  )
}

/**
 * PURE: the height a board may take inside its scroller. Both rects come from the SAME coordinate
 * space, so the page's own zoom never enters; `reserve` is the scroller content's bottom padding.
 * Floors, and takes a pixel off, so rounding can never be the thing that makes the page scroll.
 */
export function fitHeight(o: { scrollerBottom: number; boardTop: number; reserve: number; min: number }): number {
  return Math.max(o.min, Math.floor(o.scrollerBottom - o.boardTop - o.reserve) - 1)
}
