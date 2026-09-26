/**
 * idleReviewRequest.ts — closes the race between navigating to `/sessions` and `SessionsPage`'s own
 * listener existing yet.
 *
 * `NotificationBell` reaches the idle-sessions modal by `navigate('/sessions')` then dispatching
 * `agentistics:open-idle-sessions` — the same handoff the update-modal notification already uses.
 * `navigate()` only SCHEDULES the route change (React re-renders on a later tick), so a click from
 * any other page could dispatch the event before `SessionsPage` has mounted and attached its
 * listener — the modal never opens, and nothing on screen says why.
 *
 * `requestIdleReview()` sets a MODULE-LEVEL flag before dispatching (never only the event), and
 * `SessionsPage` reads it once on mount via `takeIdleReviewRequest()` in addition to listening for
 * the event live — so a request survives being fired before anyone was there to hear it. The flag is
 * consumed on read (`take`, not `peek`): a stale flag reopening the modal on some unrelated later
 * mount would be worse than the race this exists to fix.
 */

let pending = false

/** The bell's own call: arm the flag, then raise the event for whichever page is already mounted. */
export function requestIdleReview(): void {
  pending = true
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('agentistics:open-idle-sessions'))
}

/** Read-and-clear. `true` at most once per `requestIdleReview()` call. */
export function takeIdleReviewRequest(): boolean {
  const was = pending
  pending = false
  return was
}
