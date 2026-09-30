/**
 * nay.ts — PURE: what makes a session a NAY conversation, and how it is filed.
 *
 * A Nay conversation is an ordinary managed session whose cwd is Nay's own directory
 * (`~/.agentistics/nay-chat`, `NAY_CHAT_DIR` on the server). The cwd is a fact the registry already
 * records for every session, so no new field is needed and nothing can disagree about it — see
 * docs/superpowers/specs/2026-09-29-nay-as-sessions-design.md.
 *
 * FILING: every Nay conversation lives under the user group "Nay", in one of two sub-folders —
 * "Ativas" while it is open, "Inativas" once it has ended. The server re-applies that on every fleet
 * read (`planNayPlacement`), so a conversation that ends moves on its own and the folders are
 * created the first time they are needed.
 */

import {
  planCreateGroup, planMoveToGroup, planNestGroup, groupOfSession, sessionIdentityKey,
  type GroupOpResult, type SessionUserGroupsValue,
} from './sessionGroups'

/** The user group every Nay conversation is filed under. */
export const NAY_GROUP_NAME = 'Nay'
/** Its two sub-folders: a conversation that is open lives in the first, an ended one in the second. */
export const NAY_ACTIVE_FOLDER = 'Ativas'
export const NAY_INACTIVE_FOLDER = 'Inativas'

/** The directory, relative to the home directory. */
export const NAY_DIR_SUFFIX = '/.agentistics/nay-chat'

/** True for a session running in Nay's own directory. Separator- and trailing-slash-tolerant. */
export function isNayCwd(cwd: string | undefined | null): boolean {
  if (!cwd) return false
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return norm.endsWith(NAY_DIR_SUFFIX)
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export interface NayFolders {
  groups: SessionUserGroupsValue
  parentId: string
  activeId: string
  inactiveId: string
}

/**
 * PURE: make sure the "Nay" folder exists at the top level with "Ativas" and "Inativas" nested
 * inside it, creating whatever is missing. Idempotent: a value that already holds all three comes
 * back as the SAME object, so a caller can tell "nothing to write" by identity.
 *
 * Found by NAME, because that is how a person would have made them by hand; the parent must be a
 * top-level group (a folder nested elsewhere cannot hold children) and a child must be nested under
 * THAT parent. The first match wins when names repeat — duplicates are allowed in this store.
 */
export function ensureNayFolders(current: SessionUserGroupsValue): NayFolders {
  let groups = current
  let parent = groups.groups.find(g => g.parentId === undefined && sameName(g.name, NAY_GROUP_NAME))
  if (!parent) {
    const made = planCreateGroup(groups, NAY_GROUP_NAME)
    groups = made.next
    parent = groups.groups.find(g => g.id === made.id)!
  }
  const parentId = parent.id
  const child = (name: string): string => {
    const found = groups.groups.find(g => g.parentId === parentId && sameName(g.name, name))
    if (found) return found.id
    const made = planCreateGroup(groups, name)
    const nested = planNestGroup(made.next, made.id!, parentId)
    // A freshly created, empty, top-level group can always be nested under a top-level parent.
    groups = nested.ok ? nested.next : made.next
    return made.id!
  }
  // Inativas first, then Ativas: each new child is placed FIRST among its siblings, so creating them
  // in this order reads "Ativas, Inativas" under the parent.
  const inactiveId = child(NAY_INACTIVE_FOLDER)
  const activeId = child(NAY_ACTIVE_FOLDER)
  return { groups, parentId, activeId, inactiveId }
}

/** A Nay conversation as far as filing goes: its identity key, and whether it is open right now. */
export interface NayPlacementRow { key: string; running: boolean }

/**
 * PURE: the Nay rows of a fleet, as filing wants them — one per conversation, running when ANY row
 * of it runs (a reopen leaves the retired predecessor beside the live row). Rows the fleet only
 * LISTS — `closed` conversations read from the store and `unknown` (external) processes — are left
 * alone: agentop hosts neither, and the old per-message chat left many of those in the same folder.
 * `running` is the caller's own predicate, so this file stays free of the fleet's state table.
 */
export function nayPlacementRows<R extends { id: string; conversationId?: string | undefined; cwd?: string | undefined; state: string }>(
  rows: readonly R[],
  running: (r: R) => boolean,
): NayPlacementRow[] {
  const byKey = new Map<string, boolean>()
  for (const r of rows) {
    if (!isNayCwd(r.cwd) || r.state === 'closed' || r.state === 'unknown') continue
    const key = sessionIdentityKey(r)
    byKey.set(key, (byKey.get(key) ?? false) || running(r))
  }
  return [...byKey].map(([key, run]) => ({ key, running: run }))
}

/**
 * PURE: file every Nay conversation into the folder its state calls for — "Ativas" while it runs,
 * "Inativas" once it has ended — creating the folders first when they are missing. Filing is a MOVE
 * (`planMoveToGroup`: out of any other group, and unpinned), never a copy.
 *
 * `changed` is false when nothing had to move and no folder had to be created, and then the value is
 * returned untouched: this runs on every fleet read, and a write per poll would be a write storm.
 * A conversation that is in NO Nay row passed in is never touched.
 */
export function planNayPlacement(
  groups: SessionUserGroupsValue,
  pins: readonly string[],
  rows: readonly NayPlacementRow[],
): { groups: SessionUserGroupsValue; pins: string[]; changed: boolean } & Omit<NayFolders, 'groups'> {
  const folders = ensureNayFolders(groups)
  let next = folders.groups
  let nextPins = [...pins]
  for (const row of rows) {
    const target = row.running ? folders.activeId : folders.inactiveId
    if (groupOfSession(next, row.key)?.id === target && !nextPins.includes(row.key)) continue
    const moved = planMoveToGroup(nextPins, next, row.key, target)
    next = moved.groups
    nextPins = moved.pins
  }
  const changed = next !== groups || nextPins.length !== pins.length
  return { groups: next, pins: nextPins, changed, parentId: folders.parentId, activeId: folders.activeId, inactiveId: folders.inactiveId }
}

/**
 * File a new Nay session under "Nay › Ativas" — creating the folders the first time. Pure: the plan
 * over the stored groups and pins, never a write.
 */
export function planNayFiling(groups: SessionUserGroupsValue, pins: readonly string[], key: string): GroupOpResult {
  const plan = planNayPlacement(groups, pins, [{ key, running: true }])
  return { ok: true, groups: plan.groups, pins: plan.pins, id: plan.activeId, changed: plan.changed }
}
