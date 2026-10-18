/**
 * PURE: how a folder's sessions are laid out — what is running first, what ended behind one
 * collapsible row, and BOTH blocks ordered by the aside's chosen sort ("Ordenar sessões por" plus
 * "Inverter a ordem"). A folder used to list its members in stored order, which ignored the sort and
 * buried the few live sessions among dozens of ended ones.
 */
import { sortSessions, type SessionOrder } from '@agentistics/tui/control/session-order'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

export interface FolderRows {
  live: ControlSession[]
  ended: ControlSession[]
}

export function splitFolderRows(
  rows: readonly ControlSession[],
  isActive: (s: ControlSession) => boolean,
  order: SessionOrder,
  /** False while the person never picked a sort: the folder keeps its own (drag) order. */
  applySort = true,
): FolderRows {
  const arrange = (l: ControlSession[]) => (applySort ? sortSessions(l, order) : l)
  return {
    live: arrange(rows.filter(isActive)),
    ended: arrange(rows.filter(r => !isActive(r))),
  }
}

/**
 * PURE: should the "Ended" block open by itself during a search? Only when an ended row actually
 * MATCHES — a dimmed folder opened by hand lists everything it holds (`showAll`), and its
 * non-matching ended rows must not be auto-expanded just because a search is active.
 */
export function endedAutoOpen(
  searching: boolean,
  ended: readonly ControlSession[],
  matching: readonly ControlSession[],
): boolean {
  if (!searching) return false
  const ids = new Set(matching.map(r => r.id))
  return ended.some(r => ids.has(r.id))
}


/** A folder is busy only when someone is working, waiting or asking for approval. */
export function isFolderSessionActive(row: Pick<ControlSession, 'state'>): boolean {
  return row.state === 'working' || row.state === 'waiting' || row.state === 'waiting-approval'
}

/**
 * Activity belongs to the whole visible subtree, before search/filters narrow its rows.
 * A parent with only an active child stays in place; a hidden child cannot keep an empty visible
 * folder looking busy. The set changes with the fleet, without rewriting any folder membership.
 */
export function activeFolderIds(entries: readonly {
  group: { id: string; parentId?: string; hidden?: boolean }
  rows: readonly Pick<ControlSession, 'state'>[]
}[]): ReadonlySet<string> {
  const byId = new Map(entries.map(entry => [entry.group.id, entry]))
  const active = new Set<string>()
  for (const entry of entries) {
    if (!entry.rows.some(isFolderSessionActive)) continue
    const path = new Set<string>()
    let current: typeof entry | undefined = entry
    while (current && !path.has(current.group.id)) {
      if (current.group.hidden) break
      path.add(current.group.id)
      current = current.group.parentId ? byId.get(current.group.parentId) : undefined
    }
    // Hidden parents conceal their children, too.
    if (current?.group.hidden) continue
    for (const id of path) active.add(id)
  }
  return active
}
