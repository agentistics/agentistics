/**
 * sessionGroups.ts — the PURE rules of user-defined session groups, shared by every surface.
 *
 * A group is a named, manually curated set of sessions ("Saved to later"). The rules live here, in
 * `@agentistics/core`, because THREE things write them and they must agree: the web aside (drag and
 * drop, the row menu), and the server's `/api/session-groups` routes behind the MCP tools that let an
 * assistant file the sessions it starts. Two implementations of "a session belongs to at most one
 * group" would drift the first time one of them is edited.
 *
 * IDENTITY: a member is a session IDENTITY KEY (`conversationId ?? id`), never a managed id — a
 * reopen mints a new managed id for the same conversation and a group a person built must survive
 * it, exactly as a pin does.
 *
 * A SESSION BELONGS TO AT MOST ONE GROUP. Adding it to a second MOVES it out of the first.
 * DUPLICATE NAMES ARE ALLOWED: groups are addressed by id, and refusing a duplicate would need a
 * global lock for a name somebody picked because it was obvious.
 */

export interface SessionUserGroup {
  id: string
  name: string
  /** Member session identity keys, in this group's own display order. */
  sessionKeys: string[]
}

export interface SessionUserGroupsValue {
  /** Display order of the groups themselves — creation order; there is no reorder-the-groups
   *  gesture (only reordering the SESSIONS within one), so this is simply append-only. */
  groups: SessionUserGroup[]
}

export const EMPTY_SESSION_GROUPS: SessionUserGroupsValue = { groups: [] }

/** `crypto.randomUUID` is available in every browser this app targets; the fallback only guards a
 *  non-secure context (plain http, not https/localhost) where it is undefined. */
function makeGroupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * PURE: create a new, empty group named `name`, appended last.
 *
 * A blank (after trim) name is refused — an unnamed group is a button with nothing to click — and
 * the value comes back unchanged with `id: null` so the caller knows nothing happened.
 */
export function planCreateGroup(
  current: SessionUserGroupsValue,
  name: string,
): { next: SessionUserGroupsValue; id: string | null } {
  const trimmed = name.trim()
  if (trimmed === '') return { next: current, id: null }
  const id = makeGroupId()
  return { next: { groups: [...current.groups, { id, name: trimmed, sessionKeys: [] }] }, id }
}

/** PURE: rename a group. A blank name is refused (unchanged); a missing id is a no-op. */
export function planRenameGroup(
  current: SessionUserGroupsValue,
  id: string,
  name: string,
): SessionUserGroupsValue {
  const trimmed = name.trim()
  if (trimmed === '') return current
  return { groups: current.groups.map(g => (g.id === id ? { ...g, name: trimmed } : g)) }
}

/**
 * PURE: delete a group. NEVER touches a session — the group stops existing, its sessions are
 * untouched and simply fall back into the automatic sections, exactly the guarantee the owner
 * asked for ("as sessões não são apagadas, só saem do grupo").
 */
export function planDeleteGroup(current: SessionUserGroupsValue, id: string): SessionUserGroupsValue {
  return { groups: current.groups.filter(g => g.id !== id) }
}

/** PURE: which group (if any) currently holds this session key. */
export function groupOfSession(
  current: SessionUserGroupsValue,
  key: string,
): SessionUserGroup | undefined {
  return current.groups.find(g => g.sessionKeys.includes(key))
}

/**
 * PURE: put `key` into group `id`, at the end of its list — removing it from every OTHER group
 * first, so membership stays exclusive. Dropping a key already in `id` is a no-op that leaves its
 * position unchanged (see `planReorderInGroup` to actually reposition it). An unknown `id` is a
 * no-op: there is nothing to add it to.
 */
export function planAddToGroup(
  current: SessionUserGroupsValue,
  id: string,
  key: string,
): SessionUserGroupsValue {
  if (!current.groups.some(g => g.id === id)) return current
  return {
    groups: current.groups.map(g => {
      if (g.id === id) return g.sessionKeys.includes(key) ? g : { ...g, sessionKeys: [...g.sessionKeys, key] }
      return g.sessionKeys.includes(key) ? { ...g, sessionKeys: g.sessionKeys.filter(k => k !== key) } : g
    }),
  }
}

/** PURE: take `key` out of whichever group holds it. A no-op when it is in none. */
export function planRemoveFromGroup(current: SessionUserGroupsValue, key: string): SessionUserGroupsValue {
  return { groups: current.groups.map(g => (g.sessionKeys.includes(key)
    ? { ...g, sessionKeys: g.sessionKeys.filter(k => k !== key) }
    : g)) }
}

/**
 * PURE: drop a session into a group — the one gesture allowed to downgrade a PIN. A pinned row
 * wears the stronger "always in sight, outside every arrangement" promise; the owner's own ask
 * was "eu devo poder arrastar sessões fixadas também … daí elas são desfixadas mas passam a ser
 * salvas no grupo" — one gesture, both writes, not "unpin it yourself first, then drag it again".
 * A key that was never pinned leaves `pins` untouched (`filter` of an absent value is a no-op),
 * and moving a key that is already in some OTHER group is exactly `planAddToGroup`'s existing
 * exclusive-membership rule — this only adds the pin half on top of it.
 */
export function planMoveToGroup(
  pins: readonly string[],
  current: SessionUserGroupsValue,
  key: string,
  groupId: string,
): { pins: string[]; groups: SessionUserGroupsValue } {
  return {
    groups: planAddToGroup(current, groupId, key),
    pins: pins.filter(p => p !== key),
  }
}

/** The ONE key a session survives a reopen under: its conversation when the harness reports one,
 *  its managed id otherwise (see `packages/web/src/lib/sessionIdentity.ts` for the known gap). */
export function sessionIdentityKey(row: { id: string; conversationId?: string | undefined }): string {
  return row.conversationId ?? row.id
}

// ---------------------------------------------------------------------------------------------
// Addressing, for callers that hold text rather than ids (an MCP tool, the CLI).
// ---------------------------------------------------------------------------------------------

export type GroupRefResult =
  | { ok: true; group: SessionUserGroup }
  | { ok: false; code: 'no_such_group' | 'ambiguous_group'; matches: string[] }

/**
 * Resolve a group named by an id OR by its name (case-insensitive, trimmed). An id wins over a name,
 * and a name shared by two groups is REFUSED rather than guessed: duplicates are allowed, so the
 * caller must be told to use the id instead of quietly filing into the wrong one.
 */
export function resolveGroupRef(current: SessionUserGroupsValue, ref: string): GroupRefResult {
  const needle = ref.trim()
  if (needle === '') return { ok: false, code: 'no_such_group', matches: [] }
  const byId = current.groups.find(g => g.id === needle)
  if (byId) return { ok: true, group: byId }
  const lower = needle.toLowerCase()
  const byName = current.groups.filter(g => g.name.trim().toLowerCase() === lower)
  if (byName.length === 1) return { ok: true, group: byName[0]! }
  if (byName.length > 1) return { ok: false, code: 'ambiguous_group', matches: byName.map(g => g.id) }
  return { ok: false, code: 'no_such_group', matches: [] }
}

/** A row as far as session addressing goes. Structural, so this file imports nothing from the TUI. */
export interface GroupableSession {
  id: string
  conversationId?: string | undefined
  title?: string
}

export type SessionRefResult<T extends GroupableSession> =
  | { ok: true; session: T }
  | { ok: false; code: 'no_such_session' | 'ambiguous_session'; matches: string[] }

/**
 * Resolve a session named by its managed id, its conversation id, its exact title, or a unique
 * prefix of either id — in that order, and refusing on ambiguity at every tier. The verbs this
 * feeds file real work under a group; being lucky is not acceptable.
 */
export function resolveSessionForGroup<T extends GroupableSession>(rows: readonly T[], ref: string): SessionRefResult<T> {
  const needle = ref.trim()
  if (needle === '') return { ok: false, code: 'no_such_session', matches: [] }
  const tier = (pick: (r: T) => boolean): SessionRefResult<T> | null => {
    const hits = rows.filter(pick)
    if (hits.length === 1) return { ok: true, session: hits[0]! }
    if (hits.length > 1) return { ok: false, code: 'ambiguous_session', matches: hits.map(r => r.id) }
    return null
  }
  const lower = needle.toLowerCase()
  return tier(r => r.id === needle)
    ?? tier(r => r.conversationId === needle)
    ?? tier(r => (r.title ?? '').trim().toLowerCase() === lower)
    ?? tier(r => r.id.startsWith(needle))
    ?? tier(r => (r.conversationId ?? '').startsWith(needle))
    ?? { ok: false, code: 'no_such_session', matches: [] }
}

// ---------------------------------------------------------------------------------------------
// One operation, as a pure plan over the two stores it can touch (the groups and the pins).
// ---------------------------------------------------------------------------------------------

export type GroupOp =
  | { type: 'create'; name: string; keys?: readonly string[] }
  | { type: 'rename'; group: string; name: string }
  | { type: 'delete'; group: string }
  | { type: 'add'; group: string; key: string }
  | { type: 'remove'; key: string }

export type GroupOpResult =
  | { ok: true; groups: SessionUserGroupsValue; pins: string[]; id?: string; changed: boolean }
  | { ok: false; code: 'blank_name' | 'no_such_group' | 'ambiguous_group'; matches?: string[] }

/**
 * Apply one operation. The single place the rules combine, so the server route and any other caller
 * cannot disagree: adding a session to a group MOVES it out of any other and UNPINS it (a pinned row
 * is outside every arrangement, which would hide it from the very group it was filed under).
 * Pure: it returns the next state and never writes.
 */
export function planGroupOp(
  groups: SessionUserGroupsValue,
  pins: readonly string[],
  op: GroupOp,
): GroupOpResult {
  const same = (next: SessionUserGroupsValue, nextPins: string[], extra: { id?: string } = {}): GroupOpResult => ({
    ok: true, groups: next, pins: nextPins, ...extra,
    changed: next !== groups || nextPins.length !== pins.length,
  })
  switch (op.type) {
    case 'create': {
      const made = planCreateGroup(groups, op.name)
      if (made.id === null) return { ok: false, code: 'blank_name' }
      let next = made.next
      let nextPins = [...pins]
      for (const key of op.keys ?? []) {
        const moved = planMoveToGroup(nextPins, next, key, made.id)
        next = moved.groups
        nextPins = moved.pins
      }
      return same(next, nextPins, { id: made.id })
    }
    case 'rename': {
      const g = resolveGroupRef(groups, op.group)
      if (!g.ok) return { ok: false, code: g.code, matches: g.matches }
      if (op.name.trim() === '') return { ok: false, code: 'blank_name' }
      return same(planRenameGroup(groups, g.group.id, op.name), [...pins], { id: g.group.id })
    }
    case 'delete': {
      const g = resolveGroupRef(groups, op.group)
      if (!g.ok) return { ok: false, code: g.code, matches: g.matches }
      return same(planDeleteGroup(groups, g.group.id), [...pins], { id: g.group.id })
    }
    case 'add': {
      const g = resolveGroupRef(groups, op.group)
      if (!g.ok) return { ok: false, code: g.code, matches: g.matches }
      const moved = planMoveToGroup(pins, groups, op.key, g.group.id)
      return same(moved.groups, moved.pins, { id: g.group.id })
    }
    case 'remove':
      return same(planRemoveFromGroup(groups, op.key), [...pins])
  }
}
