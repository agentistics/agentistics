/**
 * dispatchGuard.ts — the decision behind a ref-backed "are we already mid-dispatch" guard.
 *
 * `groupBusy` (React state) already disables the group-verb modal's confirm button, but state only
 * takes effect once a render has committed — two `click` events dispatched close enough together (a
 * fast double-click, or a stray double dispatch) can both run their handler before that render
 * lands, and both would then fire the verb. A `useRef` closes the window because it is read and
 * written synchronously, in the same tick the first click's handler runs — but the READ-THEN-SET
 * decision itself is worth naming and testing on its own, apart from the ref and the component that
 * holds it.
 *
 * `DispatchGuard` is a plain mutable box rather than the ref object itself so this stays free of
 * React: a `useRef(false)` satisfies the shape, and so does `{ current: false }` in a test.
 */

export interface DispatchGuard {
  current: boolean
}

/**
 * Try to begin a dispatch. Returns `true` exactly the first time this is called while the guard is
 * clear, and flips it on the same call — so a second call before `endDispatch` sees it already set
 * and returns `false` without touching anything.
 */
export function tryBeginDispatch(guard: DispatchGuard): boolean {
  if (guard.current) return false
  guard.current = true
  return true
}

/** Clears the guard, so the next `tryBeginDispatch` can begin. */
export function endDispatch(guard: DispatchGuard): void {
  guard.current = false
}
