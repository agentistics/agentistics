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
 *
 * NESTING: a group may hold at most one level of children, via `parentId`. Two rules keep the tree
 * from growing a second level: a group already carrying a `parentId` cannot itself become a parent
 * (`canNestGroup`'s `target_is_nested`), and a group that already has children cannot be tucked
 * inside another one (`source_has_children`) — either would leave a session two folders deep, which
 * `groupOfSession`/the aside would then have to walk to find. Deleting a parent PROMOTES its
 * children back to the top level rather than deleting them or their sessions (`planDeleteGroup`).
 * A legacy document with no `parentId` on any group reads exactly as before — every group top-level.
 */

export interface SessionUserGroup {
  id: string
  name: string
  /** Member session identity keys, in this group's own display order. */
  sessionKeys: string[]
  /** The group this one is nested inside, if any. Absent (or on a legacy document, always absent)
   *  means top-level. See the module header for the one-level-deep rule. */
  parentId?: string
  /**
   * The person HID this folder from the sessions list. Its sessions are not deleted and stay in it;
   * the folder (and everything inside it) is simply not drawn until it is shown again, from the
   * list's arrange panel. Absent reads as shown, so every existing document is unchanged. Stored on
   * the group, server-side, so a folder hidden on the desktop is hidden on the phone too.
   */
  hidden?: boolean
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

/**
 * PURE: hide or show a folder. Any folder can be hidden — the Nay folder included, which always
 * exists and so could otherwise never leave the list. A missing id, or a folder already in the
 * asked-for state, returns `current` itself (no write). Showing DELETES the key rather than writing
 * `false`, so a shown folder reads exactly like one that was never hidden.
 */
export function planSetGroupHidden(
  current: SessionUserGroupsValue,
  id: string,
  hidden: boolean,
): SessionUserGroupsValue {
  const target = current.groups.find(g => g.id === id)
  if (!target || (target.hidden === true) === hidden) return current
  return {
    groups: current.groups.map(g => {
      if (g.id !== id) return g
      if (hidden) return { ...g, hidden: true }
      const { hidden: _drop, ...rest } = g
      return rest
    }),
  }
}

/**
 * PURE: is this folder off the list — hidden itself, or nested inside a hidden parent? A child is
 * drawn under its parent, so hiding the parent takes the child with it.
 */
export function groupConcealed(current: SessionUserGroupsValue, id: string): boolean {
  const g = current.groups.find(x => x.id === id)
  if (!g) return false
  if (g.hidden) return true
  const parent = g.parentId ? current.groups.find(x => x.id === g.parentId) : undefined
  return parent?.hidden === true
}

/** PURE: the folders the person hid, in list order — what the arrange panel offers to show again. */
export function hiddenGroups(current: SessionUserGroupsValue): SessionUserGroup[] {
  return current.groups.filter(g => g.hidden === true)
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
 *
 * A child of the deleted group is PROMOTED to the top level, its own sessions untouched — the
 * safe reading of "delete a folder that has a folder inside it": nothing else in this file ever
 * deletes a group as a side effect of another write, and a child silently disappearing with its
 * parent would be exactly that.
 */
export function planDeleteGroup(current: SessionUserGroupsValue, id: string, cascade = false): SessionUserGroupsValue {
  // `cascade` deletes the sub-folders together. Their sessions are still untouched: a group only
  // holds keys, so removing the group is what sends them back to "no folder".
  if (cascade) return { groups: current.groups.filter(g => g.id !== id && g.parentId !== id) }
  return {
    groups: current.groups
      .filter(g => g.id !== id)
      .map(g => (g.parentId === id ? withoutParent(g) : g)),
  }
}

/** Drop `parentId` cleanly rather than setting it to `undefined` — keeps a promoted group
 *  indistinguishable from one that was never nested, for callers that check `'parentId' in g`. */
function withoutParent(g: SessionUserGroup): SessionUserGroup {
  const { parentId: _parentId, ...rest } = g
  return rest
}

/** Why a nest attempt was refused — see the module header for the one-level rule these enforce. */
export type NestRefusal = 'self' | 'no_such_group' | 'source_has_children' | 'target_is_nested'

/**
 * PURE: may `childId` become a child of `parentId` right now? Both must already exist and be
 * distinct; the target must itself be top-level (nesting under a child would make a grandchild);
 * and the group being moved must not already be a parent of some other group (turning it into a
 * child would strand ITS children a level too deep, since a child cannot have children).
 */
export function canNestGroup(
  current: SessionUserGroupsValue,
  childId: string,
  parentId: string,
): { ok: true } | { ok: false; code: NestRefusal } {
  if (childId === parentId) return { ok: false, code: 'self' }
  const child = current.groups.find(g => g.id === childId)
  const parent = current.groups.find(g => g.id === parentId)
  if (!child || !parent) return { ok: false, code: 'no_such_group' }
  if (parent.parentId !== undefined) return { ok: false, code: 'target_is_nested' }
  if (current.groups.some(g => g.parentId === childId)) return { ok: false, code: 'source_has_children' }
  return { ok: true }
}

/**
 * PURE: move `childId` to be the FIRST group whose `parentId` is `parentId` — the default a person
 * expects right after filing something into a folder, not wherever it happened to sit before.
 * Every other group's relative order is untouched, including the OTHER siblings, which keep the
 * order they already had. Total: a missing `childId` is a no-op.
 */
function moveToFrontAmongSiblings(
  groups: readonly SessionUserGroup[],
  childId: string,
  parentId: string,
): SessionUserGroup[] {
  const child = groups.find(g => g.id === childId)
  if (!child) return [...groups]
  const rest = groups.filter(g => g.id !== childId)
  const firstSiblingIdx = rest.findIndex(g => g.parentId === parentId)
  if (firstSiblingIdx !== -1) return [...rest.slice(0, firstSiblingIdx), child, ...rest.slice(firstSiblingIdx)]
  // No sibling yet — the first-ever child of this parent. Insert it right after the parent itself
  // (so it reads as freshly filed under that heading) rather than at the array's tail, which on a
  // machine with many folders could land it visually far from the parent it was just moved into.
  const parentIdx = rest.findIndex(g => g.id === parentId)
  if (parentIdx === -1) return [...rest, child]
  return [...rest.slice(0, parentIdx + 1), child, ...rest.slice(parentIdx + 1)]
}

/**
 * PURE: nest `childId` under `parentId`, or — passing `null` — move it back to the top level
 * ("Tirar da pasta"). Un-nesting is always allowed and a no-op for an unknown id or one already at
 * the top level, exactly like every other planner here; nesting is refused per `canNestGroup`,
 * and the refusal is returned rather than applied, so the caller can show it as a warning instead
 * of guessing what the owner meant. A group that IS nested becomes the FIRST child of its new
 * parent — see `moveToFrontAmongSiblings`.
 */
export function planNestGroup(
  current: SessionUserGroupsValue,
  childId: string,
  parentId: string | null,
): { ok: true; next: SessionUserGroupsValue } | { ok: false; code: NestRefusal } {
  if (parentId === null) {
    return { ok: true, next: { groups: current.groups.map(g => (g.id === childId ? withoutParent(g) : g)) } }
  }
  const check = canNestGroup(current, childId, parentId)
  if (!check.ok) return check
  const nested = current.groups.map(g => (g.id === childId ? { ...g, parentId } : g))
  return { ok: true, next: { groups: moveToFrontAmongSiblings(nested, childId, parentId) } }
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
  | { type: 'delete'; group: string; cascade?: boolean }
  | { type: 'add'; group: string; key: string }
  | { type: 'remove'; key: string }
  /** `parent: null` moves `group` back to the top level ("Tirar da pasta"); a ref nests it under
   *  whatever group that ref names. Both sides resolve by id or name, like every other op here. */
  | { type: 'nest'; group: string; parent: string | null }

export type GroupOpResult =
  | { ok: true; groups: SessionUserGroupsValue; pins: string[]; id?: string; changed: boolean }
  | { ok: false; code: 'blank_name' | 'no_such_group' | 'ambiguous_group' | NestRefusal; matches?: string[] }

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
      return same(planDeleteGroup(groups, g.group.id, op.cascade === true), [...pins], { id: g.group.id })
    }
    case 'add': {
      const g = resolveGroupRef(groups, op.group)
      if (!g.ok) return { ok: false, code: g.code, matches: g.matches }
      const moved = planMoveToGroup(pins, groups, op.key, g.group.id)
      return same(moved.groups, moved.pins, { id: g.group.id })
    }
    case 'remove':
      return same(planRemoveFromGroup(groups, op.key), [...pins])
    case 'nest': {
      const g = resolveGroupRef(groups, op.group)
      if (!g.ok) return { ok: false, code: g.code, matches: g.matches }
      if (op.parent === null) {
        const planned = planNestGroup(groups, g.group.id, null)
        // Un-nesting never fails (see `planNestGroup`'s own header) — the branch only exists so
        // TypeScript sees the `ok: true` shape without an unreachable `if (!planned.ok)`.
        return planned.ok ? same(planned.next, [...pins], { id: g.group.id }) : { ok: false, code: planned.code }
      }
      const p = resolveGroupRef(groups, op.parent)
      if (!p.ok) return { ok: false, code: p.code, matches: p.matches }
      const planned = planNestGroup(groups, g.group.id, p.group.id)
      if (!planned.ok) return { ok: false, code: planned.code }
      return same(planned.next, [...pins], { id: g.group.id })
    }
  }
}
