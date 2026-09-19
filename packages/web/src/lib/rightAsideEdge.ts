/**
 * rightAsideEdge.ts — the artifacts aside's live LEFT EDGE, in viewport pixels, shared between
 * `SessionsPage` (which measures it) and `App.tsx` (which reads it so the Filtros panel never
 * crosses it) — see `filtrosPanelBounds` in `sessionsFiltersPanel.ts` for the arithmetic this feeds.
 *
 * The same bridge `artifactsStore.ts` already is for the panel's open flag and count, kept
 * SEPARATE from it on purpose: that store's `emit` is gated on reference-equal state so an
 * unrelated field never re-renders a consumer that only reads `open`, and this one updates on every
 * drag pixel — folding a continuously-moving number into that store would make every geometry
 * update also re-check (and, incorrectly, possibly skip) the open/count/dismissed fields it has
 * nothing to do with.
 *
 * `null` means "no aside on screen right now" — closed, or a route with no `SessionsPage` mounted
 * at all — and the caller falls back to the viewport's own right edge, exactly as
 * `resolveArtifactLayout` already treats a closed panel as "the aside is not there."
 */

import { useSyncExternalStore } from 'react'

let edge: number | null = null
const listeners = new Set<() => void>()

/** The current value. For a one-time read; most callers should subscribe via the hook below. */
export function getRightAsideEdge(): number | null {
  return edge
}

export function setRightAsideEdge(next: number | null): void {
  if (next === edge) return
  edge = next
  for (const l of listeners) l()
}

export function useRightAsideEdge(): number | null {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => edge,
    () => null,
  )
}

/** For tests: forget everything. */
export function resetRightAsideEdge(): void {
  edge = null
  for (const l of listeners) l()
}

/**
 * THE RESTING LEFT EDGE — the "which box to read" decision `SessionsPage.tsx`'s measuring effect
 * defers to. A plain `getBoundingClientRect().left` answers "where is this box on screen right
 * now", which is the wrong question for an aside that opens by sliding in on `transform` alone
 * (overlay layout, below `SPLIT_MIN_WIDTH`): `transform` never touches the LAYOUT box
 * `ResizeObserver` watches, so a rect read while the aside still sits translated off-screen
 * (`translateX(100%)`, its mount-time value before the open animation has even started) sticks
 * there for the life of the component — `ResizeObserver` has nothing to fire on, because the box's
 * content/border dimensions never change, only its paint-time position. `filtrosPanelBounds` then
 * reads that stale off-screen edge as "plenty of room" and the Filtros panel overlaps the aside's
 * own tabs (review's Critical finding, re-review 2).
 *
 * `restingLeftEdge` discounts the box's own X translation, so the answer is the position the box
 * will SETTLE at — correct at the very first frame (still off-screen), correct mid-slide, and
 * correct once the animation is done, because `visualLeft` and the translation move together by
 * construction (both come from the same transform) and their difference is the untransformed
 * layout position throughout.
 */
export function transformTranslateX(computedTransform: string): number {
  const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(computedTransform)
  if (matrix3d?.[1] !== undefined) {
    const parts = matrix3d[1].split(',').map(s => Number(s.trim()))
    const tx = parts.length === 16 ? parts[12] : undefined
    return typeof tx === 'number' && Number.isFinite(tx) ? tx : 0
  }
  const matrix = /^matrix\(([^)]+)\)$/.exec(computedTransform)
  if (matrix?.[1] !== undefined) {
    const parts = matrix[1].split(',').map(s => Number(s.trim()))
    const tx = parts.length === 6 ? parts[4] : undefined
    return typeof tx === 'number' && Number.isFinite(tx) ? tx : 0
  }
  // 'none', or a shape this codebase never produces for this box (skew/rotate) — no translation to
  // discount, so the visual and resting positions already agree.
  return 0
}

/**
 * `visualLeft` is a live `getBoundingClientRect().left`; `computedTransform` is the SAME element's
 * `getComputedStyle(...).transform` read at the same moment — the browser resolves any
 * `translateX(...)` (percentage included) into this matrix form, mid-transition or not, so the two
 * inputs never disagree about which instant they describe.
 */
export function restingLeftEdge(visualLeft: number, computedTransform: string): number {
  return visualLeft - transformTranslateX(computedTransform)
}
