/**
 * THE DRAWER'S MOTION, as pure functions — `components/Drawer.tsx` only wires them to the DOM.
 *
 * A drawer has four phases, not two: `closed` (unmounted), `entering` (mounted at its off-screen
 * position for one frame, so the browser has a starting point to transition FROM), `open`, and
 * `leaving` (still mounted, sliding out). Unmounting on `open = false` is the "pop-out" the owner
 * refused: the panel vanished instead of going back where it came from. It is unmounted only when
 * the closing transition has ENDED (or its timer fired — a `transitionend` that never arrives, on a
 * tab in the background, must not leave an invisible panel eating taps).
 *
 * `prefers-reduced-motion` keeps the fade and drops the slide: the panel still appears and leaves,
 * it just does not travel.
 */

export type DrawerPhase = 'closed' | 'entering' | 'open' | 'leaving'

export type DrawerSide = 'left' | 'right'

/** Opening: 240 ms on a decelerating curve. Closing is shorter and accelerates out. */
export const DRAWER_OPEN_MS = 240
export const DRAWER_CLOSE_MS = 200
export const DRAWER_OPEN_EASE = 'cubic-bezier(.2,.8,.2,1)'
export const DRAWER_CLOSE_EASE = 'ease-in'

/** The next phase when the `open` prop changes. */
export function drawerPhaseFor(phase: DrawerPhase, open: boolean): DrawerPhase {
  if (open) return phase === 'open' ? 'open' : 'entering'
  return phase === 'closed' ? 'closed' : 'leaving'
}

/** The phase after the frame that follows mounting (`entering` → `open`). */
export function drawerAfterFrame(phase: DrawerPhase): DrawerPhase {
  return phase === 'entering' ? 'open' : phase
}

/** The phase after the closing transition ended (`leaving` → `closed`). Anything else is untouched:
 *  a `transitionend` from a re-open in the middle of a close must not unmount an open panel. */
export function drawerAfterTransition(phase: DrawerPhase): DrawerPhase {
  return phase === 'leaving' ? 'closed' : phase
}

export const drawerMounted = (phase: DrawerPhase): boolean => phase !== 'closed'

/** Whether the panel is at rest on screen (as opposed to off-screen, entering or leaving). */
export const drawerShown = (phase: DrawerPhase): boolean => phase === 'open'

export interface DrawerFrame {
  /** The panel's transform; `undefined` when there is none to apply. */
  transform: string | undefined
  /** The panel's opacity (reduced motion only — a slide needs no fade on the panel itself). */
  panelOpacity: number
  /** The backdrop's opacity. */
  backdropOpacity: number
  /** The CSS transition, or `'none'` while a finger is dragging the panel. */
  transition: string
}

/**
 * Where the panel and the backdrop are for a phase.
 *
 * `dragPx` is how far a finger has pulled the panel towards its own edge (always <= 0 in the
 * panel's outward direction is normalised by the caller: a positive number means "this many pixels
 * closed"). While a drag is live there is no transition — the panel follows the finger exactly —
 * and the backdrop fades in proportion, so letting go mid-way looks like the same gesture.
 */
export function drawerFrame(
  { phase, side, reducedMotion, dragPx = 0, width = 0 }: {
    phase: DrawerPhase; side: DrawerSide; reducedMotion: boolean; dragPx?: number; width?: number
  },
): DrawerFrame {
  const shown = drawerShown(phase)
  const closing = phase === 'leaving'
  const ms = closing ? DRAWER_CLOSE_MS : DRAWER_OPEN_MS
  const ease = closing ? DRAWER_CLOSE_EASE : DRAWER_OPEN_EASE
  const dragging = shown && dragPx > 0
  const progress = dragging && width > 0 ? Math.max(0, 1 - dragPx / width) : (shown ? 1 : 0)
  if (reducedMotion) {
    return {
      transform: undefined,
      panelOpacity: progress,
      backdropOpacity: progress,
      transition: dragging ? 'none' : `opacity ${ms}ms linear`,
    }
  }
  const off = side === 'left' ? '-100%' : '100%'
  const sign = side === 'left' ? -1 : 1
  const transform = shown
    ? (dragging ? `translateX(${sign * dragPx}px)` : 'translateX(0)')
    : `translateX(${off})`
  return {
    transform,
    panelOpacity: 1,
    backdropOpacity: progress,
    transition: dragging ? 'none' : `transform ${ms}ms ${ease}, opacity ${ms}ms ${ease}`,
  }
}

/**
 * How far a swipe has CLOSED the panel, in pixels, from the finger's horizontal travel `dx`
 * (positive = rightwards). A left drawer closes leftwards, a right one rightwards; travel the other
 * way is clamped to zero — the panel does not stretch past its open position.
 */
export function swipeClosePx(dx: number, side: DrawerSide): number {
  return Math.max(0, side === 'left' ? -dx : dx)
}

/** Letting go past a third of the panel's width closes it; anything less snaps back. */
export function swipeCloses(closedPx: number, width: number): boolean {
  return width > 0 && closedPx > width / 3
}

/**
 * A touch that moved mostly vertically is a SCROLL of the panel's own content, not a swipe — it
 * must never move the panel. Decided once, after the first few pixels of travel.
 */
export function swipeIsHorizontal(dx: number, dy: number): boolean | null {
  if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return null
  return Math.abs(dx) > Math.abs(dy)
}

export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}
