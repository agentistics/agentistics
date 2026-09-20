/**
 * subtaskActionsPlan.ts — which sections `SubtaskActionsMenu` may offer, computed once and read by
 * the render instead of re-derived inline.
 *
 * The point is the same one `subtaskGroups.ts` already makes for the group candidates it wraps: an
 * action that is refused server-side must never be OFFERED and then refused — "Fire session"
 * showing on a row with no draft, or "Join existing group…" showing on a delivery with no group to
 * join, would be a control that always errors, which is worse than no control at all. Every field
 * here is a closed, exhaustive answer to "can this row do X right now", so the component only ever
 * renders what this plan already decided rather than re-checking the same conditions in JSX.
 */

import { createGroupCandidates, isGroupMember, isGroupSubtask, joinGroupCandidates } from './subtaskGroups'
import type { Subtask } from '../../lib/tasks'

/** The staged-session dispatch section — `null` when there is nothing to offer at all. */
export type StagedActionsPlan = null | 'compose' | 'fire-or-edit'

/** The group section — the four shapes a subtask row can be in (§F.1). */
export type GroupActionsPlan =
  | { kind: 'loose'; canCreate: boolean; canJoin: boolean }
  | { kind: 'group' }
  | { kind: 'member' }

export interface SubtaskActionsPlan {
  /**
   * Session dispatch. `null` when this is a group MEMBER (can never hold a session of its own,
   * `task-attach.ts`'s `subtask_in_group`) or when the calling surface has no staged-session
   * plumbing at all (`TaskTable.tsx`'s inline subitem rows today — see its own `SubtaskActionsMenu`
   * call site). `'compose'` when there is no draft yet; `'fire-or-edit'` once one exists — a row is
   * never offered both "stage a session" and "fire" at once, because a draft either exists or does
   * not.
   */
  staged: StagedActionsPlan
  /** The group section. */
  group: GroupActionsPlan
  /** Removing the subtask (or, for a group, dissolving it) is always offered — the one action every
   *  row keeps regardless of its state. Kept as an explicit field, not a bare `true` inlined at the
   *  call site, so a future rule that DOES need to withhold it has somewhere to land. */
  canRemove: true
}

export function planSubtaskActions(
  subtask: Pick<Subtask, 'id' | 'isGroup' | 'parentGroupId'>,
  /** The delivery's OTHER subtasks — the same pool `createGroupCandidates`/`joinGroupCandidates`
   *  already read. */
  siblings: readonly Subtask[],
  o: { hasStagedDraft: boolean; stagedWired: boolean },
): SubtaskActionsPlan {
  const isGroup = isGroupSubtask(subtask)
  const isMember = isGroupMember(subtask)

  const group: GroupActionsPlan = isGroup
    ? { kind: 'group' }
    : isMember
      ? { kind: 'member' }
      : {
        kind: 'loose',
        canCreate: createGroupCandidates(subtask.id, siblings).length > 0,
        canJoin: joinGroupCandidates(siblings).length > 0,
      }

  return {
    // A group MEMBER can never hold a session of its own — refused server-side (`subtask_in_group`)
    // — so it is never offered a draft to compose, edit or fire, regardless of `stagedWired`.
    staged: (!o.stagedWired || isMember) ? null : (o.hasStagedDraft ? 'fire-or-edit' : 'compose'),
    group,
    canRemove: true,
  }
}
