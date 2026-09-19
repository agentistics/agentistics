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
 * Stored per BROWSER (`localStorage`), never sent to the server — same reasoning `boardPrefs.ts`
 * gives for the task board's own arrangement: this is a per-viewer convenience the fleet has no
 * business knowing about. Every accessor is guarded, because a private window or blocked storage
 * must not stop the banner from working — it would just stop remembering the dismissal.
 */

const KEY = 'agentistics-fell-dismissed-v1'

/** The dismissed group, as the exact set of ids it covered — order does not matter. */
export function readDismissedFell(): string[] | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every(id => typeof id === 'string') ? parsed : null
  } catch {
    return null
  }
}

export function writeDismissedFell(ids: readonly string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]))
  } catch {
    /* per-viewer convenience only — a browser that cannot store it just asks again next time */
  }
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
