/**
 * subtaskFiling.ts — which of a delivery's subtasks the `SessionFiling` picker may actually OFFER.
 *
 * §F (docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §F.1) turned a subtask group into
 * a real hierarchy level: a GROUP (`Subtask.isGroup`) is a normal filing target, exactly like a
 * loose subtask, but a group MEMBER (`Subtask.parentGroupId` set) can never hold a session of its
 * own — the server refuses it outright (`task-attach.ts`, `subtask_in_group`, 422). Before this,
 * `SessionFiling.tsx` listed every subtask of a task as an identical, clickable radio row, so a
 * member read exactly like a pickable target: clicking it round-tripped to the server, came back
 * refused, and only THEN told the reader why — a control that is silently inert (or inert-after-a-
 * request) is indistinguishable from a broken one, the same rule CLAUDE.md states for a session
 * verb pressed on a row that cannot answer it.
 *
 * `classifyForFiling` is the one place that decides, PER SUBTASK, which of three rows it is:
 *
 *  - `'subtask'` — a loose subtask, unchanged: pickable exactly as before.
 *  - `'group'`   — pickable exactly like a loose subtask (a group is a valid session target), but
 *                  drawn with a small marker so it reads as a group rather than an ordinary piece.
 *  - `'member'`  — NEVER pickable. Carries the group's own title (when the group itself is still in
 *                  the list this task passed in) so the row can explain itself instead of merely
 *                  looking greyed out with no reason attached.
 *
 * A subtask that is somehow both (`isGroup: true` AND a set `parentGroupId`) is a server-side
 * invariant violation `task-web.ts`'s `patchSubtask` already refuses to write
 * (`group_field_conflict`) — this function still has to answer something for it rather than throw
 * on unexpected input, and reads `isGroup` first: a broken record renders as a group rather than
 * silently vanishing from the list.
 */

import type { Subtask } from '../../lib/tasks'

export type FilingRow =
  | { kind: 'subtask'; subtask: Subtask }
  | { kind: 'group'; subtask: Subtask }
  | { kind: 'member'; subtask: Subtask; groupTitle: string | undefined }

/** Mirror of the server's `isGroupSubtask` (`task-model.ts`) — the one reading of `isGroup`. */
function isGroup(s: Pick<Subtask, 'isGroup'>): boolean {
  return s.isGroup === true
}

/** Mirror of the server's `isGroupMember` (`task-model.ts`) — the one reading of `parentGroupId`. */
function isMember(s: Pick<Subtask, 'parentGroupId'>): boolean {
  return Boolean(s.parentGroupId)
}

/**
 * Classify every subtask of a task for the filing picker, in the SAME order they were given —
 * this never reorders or drops a row, only labels it, so a caller that wants a cascade (group then
 * its members indented under it) can still build one from the order the server returned.
 */
export function classifyForFiling(subtasks: readonly Subtask[]): FilingRow[] {
  return subtasks.map((s): FilingRow => {
    if (isGroup(s)) return { kind: 'group', subtask: s }
    if (isMember(s)) {
      const group = subtasks.find(g => g.id === s.parentGroupId)
      return { kind: 'member', subtask: s, groupTitle: group?.title }
    }
    return { kind: 'subtask', subtask: s }
  })
}

/** Whether a row may be filed into directly. Only a group MEMBER is refused. */
export function isPickable(row: Pick<FilingRow, 'kind'>): boolean {
  return row.kind !== 'member'
}
