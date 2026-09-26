/**
 * sessionUserGroups.ts — user-defined session groups ("Saved to later", …) — PURE + persisted.
 *
 * Distinct from `fleetGroups.ts`'s AUTOMATIC grouping (project/task/status), which recomputes on
 * every render from what a session IS. A user group is a NAMED, manually curated set of sessions
 * that stays exactly where the person put it — "eu crio um grupo 'Saved to later' … elas ficam
 * salvas nesse grupo e o grupo só some se eu deletar ele" — regardless of the session's own state.
 * It reflects a decision the person made, not a fact about the work the automatic groupings expose.
 *
 * IDENTITY: keyed by `sessionIdentityKey` (see `sessionIdentity.ts`) — the same key `pinnedSessions.ts`
 * uses, and for the same reason: a reopen mints a new managed id for the same conversation, and a
 * group a person built must survive that exactly as a pin does (with the same known gap for
 * `conversationBlind` harnesses — see that module's header).
 *
 * PERSISTENCE: the server, through `sharedPref.ts` — a group is a fact about the WORK ("I started
 * this, I'm not doing it now, I don't want to have to go find it again"), not about the screen it
 * was made on. Same shape and same reasoning as `pinnedSessions.ts`.
 *
 * A SESSION BELONGS TO AT MOST ONE USER GROUP. Dropping it into a second group MOVES it out of the
 * first — two "queues" both claiming one session would each read as authoritative, which is worse
 * than the product picking one.
 *
 * DUPLICATE NAMES ARE ALLOWED. Refusing them needs a global lock the person has no reason to expect
 * ("group name already exists" for a name they picked because it was obvious), and nothing else in
 * this feature depends on uniqueness — groups are addressed by id everywhere, never by name.
 */

import { reorderByDrag, stepOrder } from './dragReorder'
import { unpinSession } from './pinnedSessions'
import { createSharedPref } from './sharedPref'

const KEY = 'agentistics-session-groups'

import {
  EMPTY_SESSION_GROUPS,
  planCreateGroup,
  planRenameGroup,
  planDeleteGroup,
  groupOfSession,
  planAddToGroup,
  planRemoveFromGroup,
  planMoveToGroup,
  type SessionUserGroup,
  type SessionUserGroupsValue,
} from '@agentistics/core'

// The pure rules live in `@agentistics/core` (`sessionGroups.ts`) so the server routes behind the MCP
// tools use the SAME ones; they are re-exported here so every existing import keeps working.
export {
  EMPTY_SESSION_GROUPS,
  planCreateGroup,
  planRenameGroup,
  planDeleteGroup,
  groupOfSession,
  planAddToGroup,
  planRemoveFromGroup,
  planMoveToGroup,
}
export type { SessionUserGroup, SessionUserGroupsValue }

/** PURE: reorder the sessions WITHIN one group — by key, never index (see `dragReorder.ts`'s own
 *  header for why an index into a list that can hold unresolvable entries is unsafe). */
export function planReorderInGroup(
  current: SessionUserGroupsValue,
  id: string,
  dragKey: string,
  dropKey: string,
): SessionUserGroupsValue {
  return {
    groups: current.groups.map(g => (g.id === id
      ? { ...g, sessionKeys: reorderByDrag(g.sessionKeys, dragKey, dropKey) }
      : g)),
  }
}

/** Rebuilds `groups` in the order `ids` names, dropping nothing (every id in `ids` is assumed to
 *  already be one of `current.groups`' own — both `reorderByDrag` and `stepOrder` only ever
 *  reorder their input, never add or remove a key, so this never actually loses one; the filter
 *  exists only so the function stays TOTAL rather than trusting that invariant blindly). */
function groupsInOrder(current: SessionUserGroupsValue, ids: readonly string[]): SessionUserGroupsValue {
  const byId = new Map(current.groups.map(g => [g.id, g] as const))
  return { groups: ids.map(id => byId.get(id)).filter((g): g is SessionUserGroup => g !== undefined) }
}

/**
 * PURE: reorder the GROUPS themselves — by id, never index (§F.1, same reasoning as every other
 * reorder in this file and in `pinnedSessions.ts`'s `planPinMoveTo`: a picker only ever holds a
 * key, not a raw array position). Dropping a group onto itself, or a `dropId` this value does not
 * hold, is a no-op via `reorderByDrag`'s own rule.
 */
export function planReorderGroups(
  current: SessionUserGroupsValue,
  dragId: string,
  dropId: string,
): SessionUserGroupsValue {
  return groupsInOrder(current, reorderByDrag(current.groups.map(g => g.id), dragId, dropId))
}

/** PURE: step one group one place earlier/later — the "Mover para cima"/"Mover para baixo" menu
 *  entries, for a phone or a keyboard, which cannot drag a header onto another header. A step past
 *  either end is a no-op, exactly like `stepOrder` itself. */
export function planStepGroup(
  current: SessionUserGroupsValue,
  id: string,
  by: 1 | -1,
): SessionUserGroupsValue {
  return groupsInOrder(current, stepOrder(current.groups.map(g => g.id), id, by))
}

/**
 * PURE: which of a group's keys resolve to a row right now, in the group's own order.
 *
 * Same rule as `resolvePinnedRows`, deliberately: an unresolvable key (the row is not merely
 * ended — it is fully gone from the fleet list this call was given) is HIDDEN from view, never
 * invented, but its key is left untouched in storage. The group is the person's own record of
 * intent ("I'm getting to this"), and a stale poll or a machine that has not reported that session
 * in a while must not silently drop it from the list they built — the same guarantee pinning makes.
 */
export function resolveGroupRows<T>(
  group: SessionUserGroup,
  rows: readonly T[],
  keyOf: (row: T) => string,
): T[] {
  return group.sessionKeys
    .map(k => rows.find(r => keyOf(r) === k))
    .filter((r): r is T => r !== undefined)
}

function isSessionUserGroup(v: unknown): v is SessionUserGroup {
  if (!v || typeof v !== 'object') return false
  const g = v as Record<string, unknown>
  return typeof g.id === 'string' && typeof g.name === 'string'
    && Array.isArray(g.sessionKeys) && g.sessionKeys.every(k => typeof k === 'string')
}

const store = createSharedPref<SessionUserGroupsValue>({
  key: KEY,
  prefKey: 'sessionGroups',
  fallback: EMPTY_SESSION_GROUPS,
  parse: raw => {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { groups?: unknown }).groups)) return null
    return { groups: (raw as { groups: unknown[] }).groups.filter(isSessionUserGroup) }
  },
})

export function getSessionGroups(): SessionUserGroupsValue {
  return store.get()
}

export function subscribeSessionGroups(fn: () => void): () => void {
  return store.subscribe(fn)
}

/** Stable reference for `useSyncExternalStore`'s server snapshot (a fresh object each call loops). */
export function sessionGroupsServerSnapshot(): SessionUserGroupsValue {
  return store.serverSnapshot()
}

/** Create a group and persist it. Returns its id, or `null` when the name was blank. */
export function createSessionGroup(name: string): string | null {
  const { next, id } = planCreateGroup(store.get(), name)
  if (id) store.set(next)
  return id
}

export function renameSessionGroup(id: string, name: string): void {
  store.set(planRenameGroup(store.get(), id, name))
}

export function deleteSessionGroup(id: string): void {
  store.set(planDeleteGroup(store.get(), id))
}

export function addSessionToGroup(id: string, key: string): void {
  store.set(planAddToGroup(store.get(), id, key))
}

/**
 * Move a session into a group, unpinning it if it was pinned — pinning and grouping are two
 * independent stores, and this is the one place both are written for a single gesture.
 *
 * The GROUP write lands first and the PIN write second. If the tab dies (or a write throws)
 * between them, the session is left PINNED — visible, exactly where it was — and already carries
 * its group membership, so the very next time it is unpinned (through the ordinary pin toggle,
 * whenever that happens) it surfaces in the group with no further action: the same "unpinning
 * brings it back here on its own" guarantee `groupRowsResolved` already gives a session that is
 * both pinned and grouped. The reverse order has no such recovery: an unpin that lands without a
 * matching group write drops the session into the plain Active/Inactive bands with no trace it
 * was ever meant for a group, and nothing left to retry.
 */
export function moveSessionToGroup(id: string, key: string): void {
  store.set(planAddToGroup(store.get(), id, key))
  unpinSession(key)
}

export function removeSessionFromGroup(key: string): void {
  store.set(planRemoveFromGroup(store.get(), key))
}

export function reorderSessionInGroup(id: string, dragKey: string, dropKey: string): void {
  store.set(planReorderInGroup(store.get(), id, dragKey, dropKey))
}

/** Reorder the groups themselves (drag one group's header onto another's). */
export function reorderSessionGroups(dragId: string, dropId: string): void {
  store.set(planReorderGroups(store.get(), dragId, dropId))
}

/** Step one group up/down — the menu's "Mover para cima"/"Mover para baixo". */
export function stepSessionGroup(id: string, by: 1 | -1): void {
  store.set(planStepGroup(store.get(), id, by))
}
