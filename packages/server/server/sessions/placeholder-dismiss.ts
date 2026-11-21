/**
 * sessions/placeholder-dismiss.ts — PURE. Who may dismiss a PLACEHOLDER the guard sweep restored (B4).
 *
 * The placeholder is not work: it holds a group down after a raw delete. Only the task leader (a proven session whose registry
 * row is the leader of that very task) or the owner may remove it; every other actor — a worker session, an unattributed caller —
 * is refused. No classification is needed: the removal is a decision of the people who own the task, not a forward move.
 */
export type DismissPrincipal = { kind: 'owner' } | { kind: 'session'; id: string } | { kind: string }

export async function mayDismissPlaceholder(o: {
  principal: DismissPrincipal | undefined
  taskId: string
  isTaskLeader: (sessionId: string, taskId: string) => Promise<boolean>
}): Promise<boolean> {
  const p = o.principal
  if (!p) return false
  if (p.kind === 'owner') return true
  if (p.kind === 'session' && typeof (p as { id?: unknown }).id === 'string') return o.isTaskLeader((p as { id: string }).id, o.taskId)
  return false
}

export const PLACEHOLDER_PROTECTED_MESSAGE = 'This subtask is a placeholder the guard sweep restored after a raw delete; only the task leader or the owner can dismiss it.'

export const NOT_A_PLACEHOLDER_MESSAGE = 'This subtask is not a placeholder the guard sweep restored (its ledger has no open restoration for it); this door only dismisses placeholders.'

/** PURE. Is this registry row a proven leader of THAT task? A leader of another task, a missing row and a worker are all no. */
export async function isLeaderOfTask(row: { taskId?: string } | undefined, taskId: string, roleOf: (row: never) => Promise<string>): Promise<boolean> {
  if (!row || row.taskId !== taskId) return false
  return (await roleOf(row as never)) === 'leader'
}
