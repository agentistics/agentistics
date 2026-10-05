/**
 * createFiling.ts — filing what the create form's collapsed section asked for, once the task exists.
 *
 * Sequential on purpose (every call read-modify-writes the same store). The parts are READ BACK to learn
 * their ids — `addSubtask` reports success, not the id it minted — which is only safe here, on a task
 * nothing else has touched yet, where `made[i]` is `subs[i]`. A session whose part cannot be read back is
 * LEFT UNFILED rather than filed under some other part (the server refuses an attach to the task itself).
 */
import { addSubtask, attachSession, type Subtask } from '../../lib/tasks'

/** Which picks can actually be filed: those whose part exists. */
export function filablePicks(subs: readonly string[], picked: ReadonlyMap<string, number>): [string, number][] {
  return [...picked].filter(([, at]) => subs[at] !== undefined)
}

export async function fileExtras(taskId: string, subs: readonly string[], picked: ReadonlyMap<string, number>): Promise<void> {
  for (const s of subs) await addSubtask(taskId, s)
  if (subs.length === 0) return
  const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`)
  if (!res.ok) return
  const made = ((await res.json()) as { task: { subtasks: Subtask[] } }).task.subtasks
  for (const [id, at] of filablePicks(subs, picked)) {
    const sub = made[at]
    if (sub) await attachSession(taskId, id, sub.id)
  }
}
