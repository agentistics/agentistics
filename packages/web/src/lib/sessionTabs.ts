/**
 * sessionTabs.ts — PURE: the open-tabs model behind the strip at the top of the conversation panel.
 *
 * A tab is a SESSION KEY (`sessionIdentityKey`: the conversation when the harness reports one, the
 * managed id otherwise) — the same key a pin and a user group are filed under, so a reopen keeps
 * the tab whenever the conversation survives it.
 *
 * Which tabs are open is a fact about THIS screen, so it lives per browser (`sessionTabsStore.ts`).
 * PINS are not stored here: they are `pinnedSessions.ts`, server-shared, the same set the aside's
 * "Fixadas" band reads. A pinned session is always a tab and leads the strip.
 */

export const MAX_OPEN_TABS = 12

/** Strip order: pins first (in pin order), then the open tabs in the order they were opened. */
export function stripOrder(open: readonly string[], pins: readonly string[]): string[] {
  const rest = open.filter(id => !pins.includes(id))
  return [...pins, ...rest]
}

/**
 * Opening a session: already open (or pinned, which is always a tab) → unchanged; else inserted
 * right after the active tab. Past the cap the oldest UNPINNED, non-active tab is dropped — never a
 * pinned one.
 */
export function openTab(
  open: readonly string[], id: string, active: string | null, pins: readonly string[], max = MAX_OPEN_TABS,
): string[] {
  if (open.includes(id) || pins.includes(id)) return [...open]
  const at = active !== null ? open.indexOf(active) : -1
  const next = at >= 0 ? [...open.slice(0, at + 1), id, ...open.slice(at + 1)] : [...open, id]
  while (next.filter(x => !pins.includes(x)).length > max) {
    const drop = next.find(x => !pins.includes(x) && x !== id && x !== active)
    if (drop === undefined) break
    next.splice(next.indexOf(drop), 1)
  }
  return next
}

/**
 * Closing: a pinned tab cannot be closed (unpin first). Returns the next open list and which tab to
 * activate if the closed one was active — the neighbour to the RIGHT, else the LEFT, else none.
 * `order` is the strip as drawn (`stripOrder`).
 */
export function closeTab(
  order: readonly string[], id: string, active: string | null, pins: readonly string[],
): { open: string[]; active: string | null } {
  if (pins.includes(id)) return { open: order.filter(x => !pins.includes(x)), active }
  const i = order.indexOf(id)
  const left = order.filter(x => x !== id)
  const open = left.filter(x => !pins.includes(x))
  if (active !== id) return { open, active }
  return { open, active: left[i] ?? left[i - 1] ?? null }
}

/** A reopen minted a new key for the same conversation: the new one takes the old one's PLACE. */
export function replaceTab(open: readonly string[], from: string, to: string): string[] {
  if (from === to || !open.includes(from)) return [...open]
  if (open.includes(to)) return open.filter(x => x !== from)
  return open.map(x => (x === from ? to : x))
}

/**
 * Drop the ids no fleet row resolves. An ENDED row still resolves (it is reopenable), so it stays —
 * the same call `resolvePinnedRows` makes; only a session that has left the fleet outright goes.
 */
export function pruneTabs(open: readonly string[], known: ReadonlySet<string>): string[] {
  return open.filter(id => known.has(id))
}

/** "Fechar outras": every unpinned tab but `keep`. */
export function closeOthers(open: readonly string[], keep: string): string[] {
  return open.filter(x => x === keep)
}

/** "Fechar à direita": the unpinned tabs after `id` in the strip. `order` is the strip as drawn. */
export function closeToRight(order: readonly string[], id: string, pins: readonly string[]): string[] {
  const i = order.indexOf(id)
  if (i === -1) return order.filter(x => !pins.includes(x))
  return order.filter((x, j) => !pins.includes(x) && j <= i)
}

/** "Fechar encerradas": the unpinned tabs whose session is over. */
export function closeEnded(open: readonly string[], isEnded: (id: string) => boolean): string[] {
  return open.filter(id => !isEnded(id))
}

/** The tab `by` places from `active` in the strip, wrapping — for `Ctrl+Alt+→/←`. */
export function stepTab(order: readonly string[], active: string | null, by: 1 | -1): string | null {
  if (order.length === 0) return null
  const i = active === null ? -1 : order.indexOf(active)
  if (i === -1) return order[by === 1 ? 0 : order.length - 1] ?? null
  return order[(i + by + order.length) % order.length] ?? null
}

/** The tab at 1-based position `n` (`Ctrl+Alt+1..9`), or null past the end. */
export function tabAt(order: readonly string[], n: number): string | null {
  return order[n - 1] ?? null
}

/** Parse a stored list; total — anything but an array of strings is `[]`. */
export function parseTabs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const x of raw) if (typeof x === 'string' && x !== '' && !out.includes(x)) out.push(x)
  return out
}

/**
 * One atomic reconcile of the stored tabs against the fleet: an id that now has an identity key
 * (a session that discovered its conversation) becomes that key IN PLACE, duplicates collapse to the
 * first position, and whatever no row resolves goes. `activeKey` is always kept. Done as one step
 * so opening and pruning can never overwrite each other.
 */
export function reconcileTabs(
  open: readonly string[], rows: readonly { id: string; key: string }[], activeKey: string,
): string[] {
  const alias = new Map<string, string>()
  const known = new Set<string>([activeKey])
  for (const r of rows) { known.add(r.key); if (r.id !== r.key) alias.set(r.id, r.key) }
  const out: string[] = []
  for (const raw of open) {
    const k = known.has(raw) ? raw : alias.get(raw) ?? raw
    if (!known.has(k) || out.includes(k)) continue
    out.push(k)
  }
  return out
}

/** Pins that still resolve to a fleet row; before the fleet is known every pin stands. */
export function livePins(pins: readonly string[], known: ReadonlySet<string> | null): string[] {
  return known === null ? [...pins] : pins.filter(p => known.has(p))
}

/**
 * Entering `next` from `prev`: the same session under a new key (its conversation was discovered)
 * takes the old tab's place; any other session opens right after the tab it came from.
 */
export function enterTab(
  open: readonly string[], next: string, prev: { key: string; id: string } | null, nextId: string,
  pins: readonly string[],
): string[] {
  if (prev !== null && prev.key !== next && prev.id === nextId) {
    const from = open.includes(prev.key) ? prev.key : prev.id
    const swapped = replaceTab(open, from, next)
    if (pins.includes(next)) return swapped.filter(x => x !== next)
    return open.includes(from) ? swapped : openTab(open, next, prev.key, pins)
  }
  return openTab(open, next, prev?.key ?? null, pins)
}

/** A tab shortcut belongs to the pane the person is working in, and to no one who already took it. */
export function ownsTabShortcut(pane: string, activePane: string, defaultPrevented: boolean): boolean {
  return pane === activePane && !defaultPrevented
}
