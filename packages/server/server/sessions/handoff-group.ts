/**
 * handoff-group.ts — a leader hand-off's child joins the PARENT's sidebar folder (session group).
 *
 * The hand-off already inherits the parent's task/subtask filing (`spawnSession`); the folder is the
 * third place the parent is filed and it was left behind, so the new leader sat unfiled beside the
 * one it replaced. Groups are keyed by `sessionIdentityKey` (conversation id, else managed id), so
 * the join is `planAddToGroup` on the parent's own group — exclusive membership and the rest of the
 * rules stay in `@agentistics/core`. A parent in no folder leaves the child in none: nothing is
 * invented. Written inside the preferences write chain (`updatePreferences`), never read-then-write.
 */

import { groupOfSession, planAddToGroup, sessionIdentityKey } from '@agentistics/core'
import type { Preferences, PreferencesMutator } from '../preferences'

type Ref = { id: string; conversationId?: string | undefined }

/** The patch that files `child` in `parent`'s folder, or `undefined` when there is nothing to change. */
export function handoffGroupPatch(prefs: Preferences, parent: Ref, child: Ref): Partial<Preferences> | undefined {
  const value = { groups: (prefs.sessionGroups?.groups ?? []).map(g => ({ ...g, sessionKeys: [...g.sessionKeys] })) }
  const group = groupOfSession(value, sessionIdentityKey(parent))
  if (!group) return undefined
  const childKey = sessionIdentityKey(child)
  if (group.sessionKeys.includes(childKey)) return undefined
  return { sessionGroups: planAddToGroup(value, group.id, childKey) }
}

/** Apply it. Returns whether the child was filed. Never throws: a folder is a convenience, not the spawn. */
export async function fileHandoffInParentGroup(
  parent: Ref,
  child: Ref,
  update: (mutate: PreferencesMutator) => Promise<unknown>,
): Promise<boolean> {
  let filed = false
  try {
    await update(cur => {
      const patch = handoffGroupPatch(cur, parent, child)
      filed = patch !== undefined
      return patch
    })
  } catch { return false }
  return filed
}
