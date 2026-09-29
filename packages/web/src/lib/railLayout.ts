/**
 * railLayout.ts — PURE: what the collapsed sessions rail draws, in order.
 *
 * The rail used to draw every session as the same harness mark (owner, 2026-09-29: "na barra
 * lateral tá exibindo tudo como ícone"), so the two arrangements a person makes in the open aside —
 * PINNING and FOLDERS — vanished the moment it was collapsed. It now follows the aside's own order
 * and rules:
 *
 *  1. PINNED sessions first, each carrying a pin mark. Resolved against the WHOLE fleet, never the
 *     filtered rows, for the reason `resolvePinnedRows` records: a pinned session that finished must
 *     not disappear because "active only" is on.
 *  2. One FOLDER icon per top-level folder that holds anything, its nested folders folded into it.
 *     Also resolved against the whole fleet, as the aside resolves groups. A pinned session shows
 *     once, in the pinned band — the aside's rule.
 *  3. The remaining sessions — the filtered, ordered rows the caller passes — minus anything already
 *     drawn above.
 *
 * A folder with nothing in it draws nothing: an icon that opens onto an empty list is a dead
 * control.
 */

import type { SessionUserGroup } from './sessionUserGroups'

export interface RailRowLike {
  id: string
  state: string
}

export interface RailFolderCounts {
  /** Folders nested inside this one. */
  folders: number
  /** Sessions waiting on a person (`waiting`, `waiting-approval`). */
  waiting: number
  /** Sessions running and not waiting on anybody. */
  active: number
  /** Sessions not running at all. */
  ended: number
}

export interface RailFolderSection<T> {
  id: string
  name: string
  rows: T[]
}

export type RailItem<T> =
  | { kind: 'session'; row: T; pinned: boolean }
  | {
    kind: 'folder'
    id: string
    name: string
    /** The folder's own sessions first, then one section per nested folder that holds any. */
    sections: RailFolderSection<T>[]
    counts: RailFolderCounts
  }

const WAITING = new Set(['waiting', 'waiting-approval'])
const RUNNING = new Set(['working', 'waiting', 'waiting-approval', 'unknown'])

export function railFolderCounts(rows: readonly RailRowLike[], nestedFolders: number): RailFolderCounts {
  let waiting = 0, active = 0, ended = 0
  for (const r of rows) {
    if (WAITING.has(r.state)) waiting++
    else if (RUNNING.has(r.state)) active++
    else ended++
  }
  return { folders: nestedFolders, waiting, active, ended }
}

export function railLayout<T extends RailRowLike>(o: {
  /** The filtered, ordered rows the rail used to draw. */
  rows: readonly T[]
  /** The WHOLE fleet — pins and folders resolve against this. */
  allRows: readonly T[]
  pinnedKeys: readonly string[]
  groups: readonly SessionUserGroup[]
  keyOf: (row: T) => string
}): RailItem<T>[] {
  const byKey = new Map<string, T>()
  for (const r of o.allRows) byKey.set(o.keyOf(r), r)
  const drawn = new Set<string>()
  const items: RailItem<T>[] = []

  for (const k of o.pinnedKeys) {
    const row = byKey.get(k)
    if (!row || drawn.has(k)) continue
    drawn.add(k)
    items.push({ kind: 'session', row, pinned: true })
  }

  const rowsOf = (g: SessionUserGroup): T[] => g.sessionKeys
    .filter(k => !drawn.has(k))
    .map(k => byKey.get(k))
    .filter((r): r is T => r !== undefined)

  // Every grouped key is withheld from the loose rows below, whether or not its folder drew here.
  const grouped = new Set(o.groups.flatMap(g => g.sessionKeys))

  for (const top of o.groups.filter(g => g.parentId === undefined)) {
    const own = rowsOf(top)
    const nested = o.groups
      .filter(g => g.parentId === top.id)
      .map(g => ({ id: g.id, name: g.name, rows: rowsOf(g) }))
      .filter(s => s.rows.length > 0)
    const all = [...own, ...nested.flatMap(s => s.rows)]
    if (all.length === 0) continue
    items.push({
      kind: 'folder', id: top.id, name: top.name,
      sections: [...(own.length > 0 ? [{ id: top.id, name: top.name, rows: own }] : []), ...nested],
      counts: railFolderCounts(all, o.groups.filter(g => g.parentId === top.id).length),
    })
  }

  for (const r of o.rows) {
    const k = o.keyOf(r)
    if (drawn.has(k) || grouped.has(k)) continue
    drawn.add(k)
    items.push({ kind: 'session', row: r, pinned: false })
  }
  return items
}
