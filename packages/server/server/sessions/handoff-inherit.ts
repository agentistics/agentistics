/**
 * handoff-inherit.ts — what a leader hand-off's successor inherits from the predecessor.
 *
 * The task/subtask filing, the leader role and away mode are resolved at spawn; the sidebar folder is
 * filed by the spawn-filing planner (`handoffGroupPatch` below is its idempotent backstop). This is
 * the rest of the places a leader is "set up": its PIN, its CHECK-IN agenda, its MUTE, its launch
 * flags (`handoffSpawnDefaults`: model/effort for the same harness), plus the TITLE rule (the successor keeps the predecessor's name) and the generation counter
 * shown in the ⓘ panel instead of the title. All pure; the one write is `inheritHandoffPrefs`, a single
 * mutation inside the preferences write chain (never read-then-write).
 *
 * A pin and an agenda are keyed by `sessionIdentityKey` (conversation id, else managed id) — but the
 * predecessor may have been recorded under either, so both are looked up. Nothing is invented: a
 * predecessor that is not pinned / has no agenda leaves the successor without one.
 */

import { type CanonicalMode, groupOfSession, planAddToGroup, sessionIdentityKey } from '@agentistics/core'
import type { Preferences, PreferencesMutator } from '../preferences'

type Ref = { id: string; conversationId?: string | undefined }

const keysOf = (r: Ref): string[] => [...new Set([sessionIdentityKey(r), r.id])]

/**
 * The patch that files `child` in `parent`'s folder, or `undefined` when there is nothing to change.
 * (Formerly `handoff-group.ts`; the spawn-filing planner files the successor first, so this is
 * normally a no-op and only covers a folder the planner could not resolve.)
 */
export function handoffGroupPatch(prefs: Preferences, parent: Ref, child: Ref): Partial<Preferences> | undefined {
  const value = { groups: (prefs.sessionGroups?.groups ?? []).map(g => ({ ...g, sessionKeys: [...g.sessionKeys] })) }
  const group = groupOfSession(value, sessionIdentityKey(parent))
  if (!group) return undefined
  const childKey = sessionIdentityKey(child)
  if (group.sessionKeys.includes(childKey)) return undefined
  return { sessionGroups: planAddToGroup(value, group.id, childKey) }
}

/**
 * `--name` given on the hand-off wins; the successor keeps the predecessor's name only when the
 * caller did not ask for a new one. The leader-role prefix is applied afterwards by the role logic,
 * so a bare request stays the file's concern alone.
 */
export function handoffTitle(parentLabel: string | undefined, requested: string | undefined): string | undefined {
  return requested?.trim() ? requested : parentLabel
}

/** The ⓘ counter: the predecessor's generation plus one (a leader never handed off is generation 1). */
export function nextHandoffSeq(parentSeq: number | undefined): number {
  return (typeof parentSeq === 'number' && Number.isInteger(parentSeq) && parentSeq >= 1 ? parentSeq : 1) + 1
}

/**
 * The successor joins the pinned set right BEFORE the predecessor (its position). The predecessor is
 * NEVER unpinned here: a pinned session stays pinned even after it ends — only the owner unpins.
 */
export function handoffPinPatch(prefs: Preferences, parent: Ref, child: Ref): Partial<Preferences> | undefined {
  const pinned = prefs.pinnedSessions
  if (!Array.isArray(pinned)) return undefined
  const parentKeys = keysOf(parent)
  const at = pinned.findIndex(k => parentKeys.includes(k))
  if (at < 0) return undefined
  const childKey = sessionIdentityKey(child)
  if (pinned.includes(childKey)) return undefined
  const next = [...pinned]
  next.splice(at, 0, childKey)
  return { pinnedSessions: next }
}

/** The successor gets the predecessor's agenda (interval, pause, checklist, schedule, last round). */
export function handoffCheckinPatch(prefs: Preferences, parent: Ref, child: Ref): Partial<Preferences> | undefined {
  const all = prefs.checkin
  if (!all || typeof all !== 'object') return undefined
  const from = keysOf(parent).find(k => all[k] !== undefined)
  if (!from) return undefined
  const to = sessionIdentityKey(child)
  if (all[to] !== undefined) return undefined
  const { pending: _p, fingerprint: _f, ...kept } = all[from] as Record<string, unknown>
  return { checkin: { ...all, [to]: { ...kept, session: to } } }
}

/** A predecessor whose notifications were muted hands over a muted successor. */
export function handoffMutePatch(prefs: Preferences, parent: Ref, child: Ref): Partial<Preferences> | undefined {
  const muted = prefs.mutedSessions
  if (!Array.isArray(muted) || !keysOf(parent).some(k => muted.includes(k))) return undefined
  const childKey = sessionIdentityKey(child)
  if (muted.includes(childKey)) return undefined
  return { mutedSessions: [...muted, childKey] }
}

/**
 * The launch flags a successor inherits when the hand-off did not name them: the predecessor's model
 * and effort, but only for the SAME harness (a model id means nothing to another CLI). A flag that
 * was given always wins; an effort is inherited only alongside the model it was chosen for.
 */
export function handoffSpawnDefaults(
  parent: { harness?: string; model?: string | undefined; effort?: string | undefined; mode?: CanonicalMode | undefined } | undefined,
  harness: string,
  given: { model?: string | undefined; effort?: string | undefined; mode?: CanonicalMode | undefined },
): { model?: string; effort?: string; mode?: CanonicalMode } {
  const out: { model?: string; effort?: string; mode?: CanonicalMode } = {}
  // Canonical approval modes can cross harnesses; unsupported modes are refused by the spawn planner.
  const mode = given.mode ?? parent?.mode
  if (mode) out.mode = mode
  if (given.model) out.model = given.model
  if (given.effort) out.effort = given.effort
  if (!parent || parent.harness !== harness) return out
  if (!given.model && parent.model) out.model = parent.model
  // An effort belongs to the model it was chosen for: carry it only when the EFFECTIVE model is the predecessor's
  // (inherited, or passed explicitly as the same one) or no model is involved at all.
  const sameModel = out.model === undefined ? !parent.model : out.model === parent.model
  if (!given.effort && parent.effort && sameModel) out.effort = parent.effort
  return out
}

/** Every inherited preference in ONE patch (folder, pin, check-in, mute), or `undefined` when none applies. */
export function handoffInheritPatch(prefs: Preferences, parent: Ref, child: Ref, folderId?: string): Partial<Preferences> | undefined {
  let working = prefs
  let out: Partial<Preferences> | undefined
  const groupPatch = (current: Preferences, _parent: Ref, next: Ref): Partial<Preferences> | undefined => {
    if (!folderId) return handoffGroupPatch(current, parent, next)
    const value = current.sessionGroups ?? { groups: [] }
    if (value.groups.some(g => g.id === folderId && g.sessionKeys.includes(sessionIdentityKey(next)))) return undefined
    return { sessionGroups: planAddToGroup(value, folderId, sessionIdentityKey(next)) }
  }
  for (const step of [groupPatch, handoffPinPatch, handoffCheckinPatch, handoffMutePatch]) {
    const patch = step(working, parent, child)
    if (!patch) continue
    out = { ...out, ...patch }
    working = { ...working, ...patch }
  }
  return out
}

/** Apply it atomically. Write failures propagate to spawn configuration reporting/retry. */
export async function inheritHandoffPrefs(
  parent: Ref,
  child: Ref,
  update: (mutate: PreferencesMutator) => Promise<unknown>,
  folderId?: string,
): Promise<boolean> {
  let changed = false
  await update(cur => {
    const patch = handoffInheritPatch(cur, parent, child, folderId)
    changed = patch !== undefined
    return patch
  })
  return changed
}

/**
 * Before the predecessor is filed away (`fileInFolder` is a MOVE: it unpins): when it handed off to a
 * successor that does not hold a pin yet, give the successor the predecessor's slot so the pin is
 * never silently dropped. No successor, no pin, or the successor already pinned = nothing changes.
 * Never throws.
 */
export async function passPinToSuccessor(
  predecessor: Ref,
  successor: Ref | undefined,
  update: (mutate: PreferencesMutator) => Promise<unknown>,
): Promise<boolean> {
  if (!successor) return false
  let changed = false
  try {
    await update(cur => {
      const patch = handoffPinPatch(cur, predecessor, successor)
      changed = patch !== undefined
      return patch
    })
  } catch { return false }
  return changed
}

/** Preserve a managed-id agenda when a harness first links its conversation. */
export async function rekeyCheckinSession(
  managedId: string, conversationId: string,
  update: (mutate: PreferencesMutator) => Promise<unknown>,
): Promise<void> {
  if (!managedId || !conversationId || managedId === conversationId) return
  await update(cur => {
    const all = cur.checkin
    if (!all || all[managedId] === undefined) return undefined
    const next = { ...all }
    // The managed agenda is authoritative: a poll may already have seeded conversation defaults.
    next[conversationId] = { ...all[managedId] as Record<string, unknown>, session: conversationId }
    delete next[managedId]
    return { checkin: next }
  })
}
