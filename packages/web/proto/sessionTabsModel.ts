/**
 * PROTOTYPE (UI.SESSION-TABS T1) — the open-tabs model the T2 brief moves to `src/lib/sessionTabs.ts`.
 *
 * Open tabs are PER BROWSER (localStorage): which conversations are on this screen is a fact about the
 * screen. PINS are NOT stored here — they are `pinnedSessions.ts`, server-shared, MAX_PINNED 10, the
 * same set the aside's "Fixadas" band reads. A pinned session is always a tab (it leads the strip).
 */

export const MAX_OPEN_TABS = 12

/** Strip order: pins first (in pin order), then open tabs in the order they were opened. */
export function stripOrder(open: readonly string[], pins: readonly string[]): string[] {
  const rest = open.filter(id => !pins.includes(id))
  return [...pins, ...rest]
}

/** Opening a session: already open → unchanged; else appended after the active tab. Past the cap the
 *  oldest UNPINNED, non-active tab is dropped (VS Code's "preview" spirit, never a pinned one). */
export function openTab(open: readonly string[], id: string, active: string | null, pins: readonly string[], max = MAX_OPEN_TABS): string[] {
  if (open.includes(id)) return [...open]
  const at = active !== null ? open.indexOf(active) : -1
  const next = at >= 0 ? [...open.slice(0, at + 1), id, ...open.slice(at + 1)] : [...open, id]
  while (next.filter(x => !pins.includes(x)).length > max) {
    const drop = next.find(x => !pins.includes(x) && x !== id && x !== active)
    if (drop === undefined) break
    next.splice(next.indexOf(drop), 1)
  }
  return next
}

/** Closing: a pinned tab cannot be closed (unpin first). Returns the next open list and which tab to
 *  activate if the closed one was active — the neighbour to the RIGHT, else the LEFT, else none. */
export function closeTab(order: readonly string[], id: string, active: string | null, pins: readonly string[]): { open: string[]; active: string | null } {
  if (pins.includes(id)) return { open: order.filter(x => !pins.includes(x)), active }
  const i = order.indexOf(id)
  const left = order.filter(x => x !== id)
  const open = left.filter(x => !pins.includes(x))
  if (active !== id) return { open, active }
  return { open, active: left[i] ?? left[i - 1] ?? null }
}
