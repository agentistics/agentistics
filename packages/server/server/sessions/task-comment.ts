/**
 * task-comment.ts — where a NEW comment may land. Pure.
 *
 * A comment belongs to the task, a subtask GROUP or a subtask (loose or a group member); the
 * target is the optional `subtaskId` on `TaskComment`. Which thread then SHOWS it is
 * `@agentistics/core`'s `commentThreads.ts` — this module only decides whether a write is allowed.
 *
 * A target that names nothing is REFUSED, in words — never silently filed on the task. A comment
 * an assistant meant for "the login form" that quietly lands on the delivery reads, to everyone
 * after it, as a remark about the whole delivery. A subtask that was DELETED is indistinguishable
 * from one that never existed (removal is a hard delete), so both get the same sentence.
 */

import { commentTarget, type CommentTarget } from '@agentistics/core'
import type { Subtask } from './task-model'

export type CommentTargetRefusal = 'no_such_subtask' | 'wrong_delivery'

export type CommentTargetPlan =
  | { ok: true; subtaskId?: string; target: CommentTarget }
  | { ok: false; reason: CommentTargetRefusal; message: string }

export function planCommentTarget(
  taskId: string,
  subtaskId: string | undefined,
  subtasks: readonly Subtask[],
): CommentTargetPlan {
  const wanted = subtaskId?.trim()
  if (!wanted) return { ok: true, target: { kind: 'task', id: null } }
  const s = subtasks.find(x => x.id === wanted)
  if (!s) {
    return {
      ok: false, reason: 'no_such_subtask',
      message: `No subtask "${wanted}" exists — it was never created, or it has been deleted. The comment was not saved.`,
    }
  }
  if (s.taskId !== taskId) {
    return {
      ok: false, reason: 'wrong_delivery',
      message: `Subtask "${s.title}" belongs to a different task. The comment was not saved.`,
    }
  }
  return { ok: true, subtaskId: s.id, target: commentTarget({ id: '', createdAt: '', subtaskId: s.id }, subtasks) }
}

/** The activity log's phrase for a target — rendered verbatim, so it says WHICH thread. */
export function commentTargetPhrase(t: CommentTarget): string {
  if (t.kind === 'task') return 'on the task'
  return t.kind === 'group' ? `on group "${t.title ?? t.id}"` : `on subtask "${t.title ?? t.id}"`
}
