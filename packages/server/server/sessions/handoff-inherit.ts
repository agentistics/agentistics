/**
 * handoff-inherit.ts — what a leader hand-off's successor inherits from the predecessor.
 *
 * The task/subtask filing, the leader role and away mode are resolved at spawn; the sidebar folder is
 * filed by the spawn-filing planner (`handoffGroupPatch` below is its idempotent backstop). This is
 * the rest of the places a leader is "set up": its PIN and its CHECK-IN agenda, plus the TITLE rule (the successor keeps the predecessor's name) and the generation counter
 * shown in the ⓘ panel instead of the title. All pure; the one write is `inheritHandoffPrefs`, a single
 * mutation inside the preferences write chain (never read-then-write).
 *
 * A pin and an agenda are keyed by `sessionIdentityKey` (conversation id, else managed id) — but the
 * predecessor may have been recorded under either, so both are looked up. Nothing is invented: a
 * predecessor that is not pinned / has no agenda leaves the successor without one.
 */

import { groupOfSession, planAddToGroup, sessionIdentityKey } from '@agentistics/core'
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

/** The successor keeps the predecessor's name; the caller's label is only a fallback. */
export function handoffTitle(parentLabel: string | undefined, requested: string | undefined): string | undefined {
  return parentLabel?.trim() ? parentLabel : requested
}

/** The ⓘ counter: the predecessor's generation plus one (a leader never handed off is generation 1). */
export function nextHandoffSeq(parentSeq: number | undefined): number {
  return (typeof parentSeq === 'number' && Number.isInteger(parentSeq) && parentSeq >= 1 ? parentSeq : 1) + 1
}

/** The successor takes the predecessor's place in the pinned set (same position). */
export function handoffPinPatch(prefs: Preferences, parent: Ref, child: Ref): Partial<Preferences> | undefined {
  const pinned = prefs.pinnedSessions
  if (!Array.isArray(pinned)) return undefined
  const parentKeys = keysOf(parent)
  const at = pinned.findIndex(k => parentKeys.includes(k))
  if (at < 0) return undefined
  const childKey = sessionIdentityKey(child)
  if (pinned.includes(childKey)) return undefined
  const next = [...pinned]
  next[at] = childKey
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

/** Every inherited preference in ONE patch (folder, pin, check-in), or `undefined` when none applies. */
export function handoffInheritPatch(prefs: Preferences, parent: Ref, child: Ref): Partial<Preferences> | undefined {
  let working = prefs
  let out: Partial<Preferences> | undefined
  for (const step of [handoffGroupPatch, handoffPinPatch, handoffCheckinPatch]) {
    const patch = step(working, parent, child)
    if (!patch) continue
    out = { ...out, ...patch }
    working = { ...working, ...patch }
  }
  return out
}

/** Apply it. Never throws: these are conveniences, not the spawn. Returns whether anything changed. */
export async function inheritHandoffPrefs(
  parent: Ref,
  child: Ref,
  update: (mutate: PreferencesMutator) => Promise<unknown>,
): Promise<boolean> {
  let changed = false
  try {
    await update(cur => {
      const patch = handoffInheritPatch(cur, parent, child)
      changed = patch !== undefined
      return patch
    })
  } catch { return false }
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
