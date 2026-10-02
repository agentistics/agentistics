/**
 * fellDismissal — the "reopen what fell" banner's own dismiss control.
 *
 * Dismissing touches nothing on the server and discards nothing: every fallen row stays reopenable
 * one at a time from its own card (`SessionRowMenu`'s Reopen verb). It only hides the GROUP banner,
 * and only for the exact group that was on screen when the person dismissed it — a SET of ids, never
 * a count and never "forever". The moment the machine reports a DIFFERENT set of fallen ids (one more
 * session fell, or one of these was reopened on its own and the rest are still down), the banner is
 * describing a new fact and is shown again.
 *
 * A CHOICE, so it is stored on the SERVER (`/api/user-prefs`, `fellDismissed`; per ACCOUNT on a
 * central) and a banner dismissed on the desktop stays dismissed on the phone. The browser copy
 * under the old key is the first paint and the one-time migration source; every accessor is
 * guarded, because a private window or blocked storage must not stop the banner from working.
 */

import { createSharedPref } from './sharedPref'

const store = createSharedPref<string[] | null>({
  key: 'agentistics-fell-dismissed-v1', prefKey: 'fellDismissed', fallback: null, adoptLocalWhenAbsent: true,
  parse: raw => (Array.isArray(raw) && raw.every(id => typeof id === 'string') ? raw as string[] : null),
})

/** Fires when the dismissal changes — here or, after a load, on another device. */
export const subscribeDismissedFell = (fn: () => void): (() => void) => store.subscribe(fn)

/** The dismissed group, as the exact set of ids it covered — order does not matter. */
export function readDismissedFell(): string[] | null {
  return store.get()
}

export function writeDismissedFell(ids: readonly string[]): void {
  store.set([...ids])
}

/**
 * Is the CURRENT fallen set exactly the one that was dismissed? — PURE, order-independent.
 *
 * `dismissed === null` (nothing was ever dismissed, or storage threw) always answers `false`: an
 * absent dismissal can never suppress a banner nobody asked to hide. A set of a different SIZE is
 * never the same group, whatever its members — cheaper than building a second set for the common
 * case where nothing has been dismissed yet or the fall changed size.
 */
export function fellGroupDismissed(
  dismissed: readonly string[] | null,
  currentIds: readonly string[],
): boolean {
  if (dismissed === null) return false
  if (dismissed.length !== currentIds.length) return false
  const d = new Set(dismissed)
  return currentIds.every(id => d.has(id))
}
