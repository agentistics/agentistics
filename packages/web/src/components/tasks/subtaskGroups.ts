/**
 * subtaskGroups.ts — pure reads over a delivery's own subtask list for the group-forming gestures
 * (§F.1 of docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md): a "grupo de subtasks" is a
 * real hierarchy level, not a label two subtasks share.
 *
 * `isGroupSubtask`/`isGroupMember`/`groupMembers` mirror the server's own readings
 * (`task-model.ts`) exactly — kept as a separate copy rather than imported, since `packages/web`
 * cannot import server modules (they pull in Node/Bun-only APIs `@agentistics/core`'s import
 * boundary exists to keep out of the browser bundle). Every function here is total and holds no
 * network call: the SERVER is still the only place a group write can actually be refused
 * (`checkParentGroup`, `task-attach.ts`) — the candidate lists below only decide what a PICKER
 * OFFERS, so the common case does not have to hit a refusal it could have avoided by construction.
 */

import type { Subtask } from '../../lib/tasks'

/** Is this subtask a GROUP (§F.1)? Mirrors the server's `isGroupSubtask` (`task-model.ts`). */
export function isGroupSubtask(s: Pick<Subtask, 'isGroup'>): boolean {
  return s.isGroup === true
}

/** Is this subtask a MEMBER of a group (§F.1)? Mirrors the server's `isGroupMember`. */
export function isGroupMember(s: Pick<Subtask, 'parentGroupId'>): boolean {
  return Boolean(s.parentGroupId)
}

/** Every member of a group, in the order they were created. Mirrors the server's `groupMembers`. */
export function groupMembers(groupId: string, subtasks: readonly Subtask[]): Subtask[] {
  return subtasks.filter(s => s.parentGroupId === groupId)
}

/** The group a MEMBER belongs to, or `undefined` when the reference is stale (a group deleted out
 *  from under it — the same "unknown" answer `subtaskRollupOf` gives for a bucket the server no
 *  longer reports). Used to render "part of group: <title>" without a second fetch. */
export function groupOf(
  subtask: Pick<Subtask, 'parentGroupId'>,
  subtasks: readonly Subtask[],
): Subtask | undefined {
  if (!subtask.parentGroupId) return undefined
  return subtasks.find(s => s.id === subtask.parentGroupId)
}

/**
 * Candidates for "Criar grupo com…", offered from `subtaskId`'s own row: every OTHER subtask of the
 * same delivery that is neither a group nor already a member of one — the row itself is excluded
 * too, since a subtask cannot form a group with itself. `subtasks` is assumed already scoped to one
 * delivery (the same assumption every caller of this module already makes — `SubtaskTable`'s own
 * `p.subtasks`, `TaskDetail.subtasks`), so no `taskId` filter is repeated here; the server still
 * enforces the same-task rule independently (`checkParentGroup`).
 */
export function createGroupCandidates(
  subtaskId: string,
  subtasks: readonly Subtask[],
): Subtask[] {
  return subtasks.filter(s => s.id !== subtaskId && !isGroupSubtask(s) && !isGroupMember(s))
}

/**
 * Candidates for "Entrar em grupo existente…" — every GROUP of the same delivery. A group can never
 * itself be a member (`checkParentGroup` refuses `isGroup: true` outright), so the initiating row's
 * own id needs no exclusion here the way `createGroupCandidates` excludes it.
 */
export function joinGroupCandidates(subtasks: readonly Subtask[]): Subtask[] {
  return subtasks.filter(isGroupSubtask)
}
