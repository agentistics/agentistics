/**
 * tabStripEdge.ts — PURE: whether a horizontally-scrolling tab strip has more content hidden past
 * either edge, from the three numbers a scroll container already exposes (`scrollLeft`,
 * `clientWidth`, `scrollWidth`). Used by the mobile panel switcher's single-row tab strip
 * (`SessionsPage.tsx`'s `rightSwitcherMobile`) to draw a subtle edge fade only where it is true —
 * a fade drawn unconditionally on both edges lies at the strip's own ends, where there is nothing
 * left to reveal.
 *
 * `EPSILON` absorbs sub-pixel scroll positions (a fractional `scrollLeft` a browser can report at
 * some zoom levels) so a strip that is, for all practical purposes, fully scrolled does not keep
 * claiming there is "one more pixel" to see.
 */

const EPSILON = 1

export interface ScrollExtent {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}

export interface EdgeFade {
  /** There is hidden content to the LEFT of the visible window — scroll back to see it. */
  left: boolean
  /** There is hidden content to the RIGHT of the visible window — scroll forward to see it. */
  right: boolean
}

/**
 * `scrollWidth <= clientWidth` means nothing overflows at all (every tab already fits), so neither
 * edge ever fades regardless of `scrollLeft` — the sole guard against a fade appearing on a strip
 * that never scrolls in the first place.
 */
export function tabStripEdgeFade({ scrollLeft, clientWidth, scrollWidth }: ScrollExtent): EdgeFade {
  if (scrollWidth <= clientWidth + EPSILON) return { left: false, right: false }
  return {
    left: scrollLeft > EPSILON,
    right: scrollLeft + clientWidth < scrollWidth - EPSILON,
  }
}

/**
 * The CSS `mask-image` for a strip showing this `EdgeFade` — a soft alpha ramp over whichever edges
 * currently hide more content, `null` when neither does (the common case: everything fits, or the
 * strip is scrolled exactly to one bare end with nothing to fade there either).
 *
 * A MASK, not an overlay `div` painted with a background color: an overlay has to know the strip's
 * own background to blend into it invisibly, and this row's background varies by theme and by where
 * the strip is mounted. A mask fades the strip's own pixels to transparent instead, so it is correct
 * over any background without asking what that background is.
 */
export function tabStripFadeMask(edges: EdgeFade, fadePx = 20): string | null {
  if (!edges.left && !edges.right) return null
  const start = edges.left ? `transparent 0, black ${fadePx}px` : 'black 0'
  const end = edges.right ? `black calc(100% - ${fadePx}px), transparent 100%` : 'black 100%'
  return `linear-gradient(to right, ${start}, ${end})`
}
