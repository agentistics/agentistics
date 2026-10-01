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
  canNestGroup,
  planNestGroup,
  planSetGroupHidden,
  groupConcealed,
  hiddenGroups,
  type NestRefusal,
  type SessionUserGroup,
  type SessionUserGroupsValue,
} from '@agentistics/core'

// The pure rules live in `@agentistics/core` (`sessionGroups.ts`) so the server routes behind the MCP
// tools use the SAME ones; they are re-exported here so every existing import keeps working.
export {
  planSetGroupHidden,
  groupConcealed,
  hiddenGroups,
  EMPTY_SESSION_GROUPS,
  planCreateGroup,
  planRenameGroup,
  planDeleteGroup,
  groupOfSession,
  planAddToGroup,
  planRemoveFromGroup,
  planMoveToGroup,
  canNestGroup,
  planNestGroup,
}
export type { SessionUserGroup, SessionUserGroupsValue, NestRefusal }

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
 * PURE: the ids `id` reorders AMONG — its top-level siblings if it has no parent, or the other
 * children of the SAME parent if it does. Nesting changes which list a group scrolls through,
 * never whether "reorder" is a meaningful thing to ask of it.
 */
function siblingIdsOf(current: SessionUserGroupsValue, id: string): string[] {
  const parentId = current.groups.find(g => g.id === id)?.parentId
  return current.groups.filter(g => g.parentId === parentId).map(g => g.id)
}

/**
 * PURE: replace the relative order of the ids in `subset` within `order`, leaving every id NOT in
 * `subset` exactly where it sits — the same "never reorder by index into a filtered view" rule
 * `dragReorder.ts`'s own header states, applied here because a folder's children can sit
 * interleaved in the raw array with an unrelated top-level folder (nesting sets `parentId` in
 * place; it never moves anyone). Reordering the raw array by a naive `reorderByDrag` moved a
 * dragged CHILD past whatever raw-array neighbor it happened to have — often a DIFFERENT folder's
 * child — with no visible effect on the rendered list at all, which is the "não moveu" the owner
 * reported. `newSubsetOrder` must be a permutation of `subset`.
 */
function spliceSubsetOrder(order: readonly string[], subset: ReadonlySet<string>, newSubsetOrder: readonly string[]): string[] {
  const queue = [...newSubsetOrder]
  return order.map(id => (subset.has(id) ? (queue.shift() as string) : id))
}

/**
 * PURE: reorder the GROUPS themselves — by id, never index (§F.1, same reasoning as every other
 * reorder in this file and in `pinnedSessions.ts`'s `planPinMoveTo`: a picker only ever holds a
 * key, not a raw array position). Dropping a group onto itself, or a `dropId` this value does not
 * hold, is a no-op via `reorderByDrag`'s own rule. Scoped to SIBLINGS (`siblingIdsOf`): a drag onto
 * a group with a DIFFERENT parent has no shared order to move within. In the UI only TOP-LEVEL
 * folders carry a grip — a nested folder is pinned first under its parent and leaves its parent by
 * being dragged out (`nestSessionGroup(id, null)`), never by being reordered.
 */
export function planReorderGroups(
  current: SessionUserGroupsValue,
  dragId: string,
  dropId: string,
): SessionUserGroupsValue {
  const dragGroup = current.groups.find(g => g.id === dragId)
  const dropGroup = current.groups.find(g => g.id === dropId)
  if (!dragGroup || !dropGroup) return current
  if (dragGroup.parentId !== dropGroup.parentId) return current
  const siblings = siblingIdsOf(current, dragId)
  const reordered = reorderByDrag(siblings, dragId, dropId)
  return groupsInOrder(current, spliceSubsetOrder(current.groups.map(g => g.id), new Set(siblings), reordered))
}

/** PURE: step one group one place earlier/later, among its SIBLINGS (`siblingIdsOf`) — the "Mover
 *  para cima"/"Mover para baixo" menu entries, for a phone or a keyboard, which cannot drag a
 *  header onto another header. A step past either end of ITS OWN sibling list is a no-op, exactly
 *  like `stepOrder` itself; a top-level folder never steps past — or into — a nested one, and a
 *  nested one never steps out of its parent's children this way (see "Tirar da pasta" for that). */
export function planStepGroup(
  current: SessionUserGroupsValue,
  id: string,
  by: 1 | -1,
): SessionUserGroupsValue {
  const siblings = siblingIdsOf(current, id)
  const stepped = stepOrder(siblings, id, by)
  return groupsInOrder(current, spliceSubsetOrder(current.groups.map(g => g.id), new Set(siblings), stepped))
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
    // A legacy document has no `parentId` on any group at all — absent reads as top-level.
    && (g.parentId === undefined || typeof g.parentId === 'string')
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

/** Hide or show a folder in the sessions list — stored on the group, server-side (`planSetGroupHidden`). */
export function setSessionGroupHidden(id: string, hidden: boolean): void {
  const cur = store.get()
  const next = planSetGroupHidden(cur, id, hidden)
  if (next !== cur) store.set(next)
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

/**
 * Nest `id` under `parentId`, or — passing `null` — move it back to the top level ("Tirar da
 * pasta"). Applies and persists the write only on success; a refusal writes nothing and hands the
 * caller the reason (`NestRefusal`) so the UI can show the exact warning the owner asked for
 * ("Não é possível: esta pasta já tem outra pasta dentro.") instead of silently doing nothing.
 */
export function nestSessionGroup(id: string, parentId: string | null): { ok: true } | { ok: false; code: NestRefusal } {
  const planned = planNestGroup(store.get(), id, parentId)
  if (!planned.ok) return planned
  store.set(planned.next)
  return { ok: true }
}

/**
 * PURE: the number a folder's header shows — its OWN sessions PLUS every session in the folders
 * nested inside it (owner, 2026-09-29: a parent holding only subfolders read `0`, "hoje tá 0, tá
 * errado"). It used to count direct sessions only, on the reasoning that nesting a busy folder
 * should not make its parent's number jump; but a folder is a container, and "0" on a container
 * full of work reads as empty. `resolved` is the same per-folder resolution the list draws from,
 * so the number can never count a session the list does not show.
 */
export function folderSessionCount(
  groupId: string,
  resolved: readonly { group: { id: string; parentId?: string }; rows: readonly unknown[] }[],
): number {
  let n = 0
  for (const entry of resolved) {
    if (entry.group.id === groupId || entry.group.parentId === groupId) n += entry.rows.length
  }
  return n
}

/**
 * PURE: what a folder's header says while the list is NARROWED by a filter, a search or "active
 * only" — owner, 2026-09-29: the filters applied to everything outside the folders and not inside
 * them, so searching for "Líder" left every folder showing everything. Folders now show only what
 * matches, and the header says how much of the folder that is (`3/61`), so a folded folder still
 * tells you there are results in it. Not narrowed, it is just the total.
 */
export function folderCountLabel(shown: number, total: number, narrowing: boolean): string {
  return narrowing ? `${shown}/${total}` : String(total)
}

/**
 * PURE: is the list narrowed right now? "Active only" counts: it hides sessions exactly like a
 * filter does, and it is on by default, which is why a folder with nothing matching is DIMMED and
 * never removed — removing it would make a folder like "Finalizadas" vanish on every visit.
 */
export function listNarrowed(o: { activeOnly: boolean; query: string; valueFiltered: number; total: number }): boolean {
  return o.activeOnly || o.query.trim() !== '' || o.valueFiltered < o.total
}
