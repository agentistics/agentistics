/**
 * task-repo-gate.ts — who may write a task's repository, at the one door every writer goes through
 * (REST `POST /api/tasks/<ref>` with `repo`, the MCP `agentistics_task_edit`, which rides the same route with
 * the session proof attached, and `agentop task edit --repo`, which carries the principal of its own process).
 *
 * The repository a person writes is the only one that counts for leading (`leadOp`), so a session able to write
 * ANY task's repository could set another task's repository to its own and then lead it. The rule lives in
 * `repoWriteRefusal` (`session-roles.ts`); this file only resolves who is asking and which task is meant.
 */
import { defaultRoleDeps, repoWriteRefusal, roleSenderFromBody, type RoleDeps } from './session-roles'

export interface RepoGateRefusal { status: 403; body: { error: 'unverified_sender' | 'not_own_task'; message: string } }

/** The task id a reference names, from the real board. */
async function boardTaskId(ref: string): Promise<string | undefined> {
  const [{ loadTaskWorld }, { findTask }] = await Promise.all([import('./task-source'), import('./task-report')])
  return findTask(ref, (await loadTaskWorld()).book.tasks)?.id
}

/** A REST body (may carry `session: {id, token}`): `null` = go on, otherwise the refusal to answer. */
export async function repoEditGate(
  body: { session?: unknown }, ref: string,
  verify: (id: unknown, token: unknown) => Promise<string | null>,
  deps?: RoleDeps, taskIdOf: (ref: string) => Promise<string | undefined> = boardTaskId,
): Promise<RepoGateRefusal | null> {
  const who = await roleSenderFromBody(body, verify)
  if (!who.ok) return { status: 403, body: { error: 'unverified_sender', message: who.message } }
  return repoEditGateFor(who.sender, ref, deps, taskIdOf)
}

/** The same decision for a caller whose session identity is already proven (the CLI's own principal). */
export async function repoEditGateFor(
  sender: string | null, ref: string, deps?: RoleDeps, taskIdOf: (ref: string) => Promise<string | undefined> = boardTaskId,
): Promise<RepoGateRefusal | null> {
  if (sender === null) return null
  const taskId = await taskIdOf(ref)
  // A reference that names nothing is the edit's own 404, never a reason to let anybody past.
  if (!taskId) return null
  const out = await repoWriteRefusal(sender, taskId, deps ?? await defaultRoleDeps())
  return out ? { status: 403, body: { error: out.code, message: out.message } } : null
}
