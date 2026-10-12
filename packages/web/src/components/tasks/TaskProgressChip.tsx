import { groupStatus, taskProgress, type TaskStatusDef } from '@agentistics/core'
import { useTaskDetail } from '../../lib/tasks'
import { Ring } from './TaskHero'

/**
 * The task's completion ring + "%" — the SAME ring Agentask draws, at header size. One request
 * (`useTaskDetail`); nothing is drawn while it loads, when it fails, or for a task with no subtasks
 * (no breakdown = no bar, as on the board).
 */
export function TaskProgressChip({ taskRef, statuses = null, lang }: {
  taskRef: string
  statuses?: readonly TaskStatusDef[] | null
  lang: 'pt' | 'en'
}) {
  const { detail } = useTaskDetail(taskRef)
  if (!detail) return null
  const subs = detail.subtasks.map(s => {
    if (!s.isGroup) return s
    const status = groupStatus(detail.subtasks.filter(m => m.parentGroupId === s.id).map(m => m.status))
    return { ...s, status, done: status === 'done' }
  })
  if (subs.length === 0) return null
  const counts: Record<string, number> = {}
  for (const s of subs) counts[s.status] = (counts[s.status] ?? 0) + 1
  const done = subs.filter(s => s.done).length
  const inProgress = counts['in_progress'] ?? 0
  const blocked = counts['blocked'] ?? 0
  const pct = taskProgress(done, subs.length, inProgress, blocked, counts).percent ?? 0
  return (
    <span data-task-progress style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Ring
        bare done={done} inProgress={inProgress} blocked={blocked} total={subs.length} size={22}
        statuses={statuses} counts={counts} titles={[]} lang={lang}
      />
      <span style={{ fontWeight: 650 }}>{pct}%</span>
    </span>
  )
}
