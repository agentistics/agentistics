import { effectiveSubtasks } from '../sessions/task-report'
import { subtaskDone, type Subtask, type Task } from '../sessions/task-model'
import { PHASE_STATUS } from './machine'

/** The same effective group status as the Live. A task with open children is a container, not a review piece. */
export function boardReviewTargets(book: { tasks: readonly Task[]; subtasks: readonly Subtask[] }) {
  const wanted = new Set([PHASE_STATUS.revisao_lider.id, PHASE_STATUS.pr_merge.id, PHASE_STATUS.ci.id])
  const subs = effectiveSubtasks(book.subtasks)
  const targets = subs.filter(s => !s.parentGroupId && wanted.has(s.status)).map(s => ({
    ...s, hasOpenChildren: subs.some(child => child.parentGroupId === s.id && !subtaskDone(child.status)),
  }))
  return [
    ...targets,
    ...book.tasks.filter(t => wanted.has(t.status) && !subs.some(s => s.taskId === t.id))
      .map(t => ({ ...t, taskId: t.id, hasOpenChildren: false })),
  ]
}
