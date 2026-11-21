/**
 * task-repo-gate.ts — who may write a task's repository, at the one door every writer goes through
 * (REST `POST /api/tasks/<ref>` with `repo`, the MCP `agentistics_task_edit`, which rides the same route with
 * the session proof attached, and `agentop task edit --repo`, which resolves its caller from its process tree).
 *
 * The repository a person writes is the only one that counts for leading (`leadOp`), so a session able to write
 * a repository could set one and then lead a task of another project. A SESSION may therefore write only a value
 * that is a verifiable fact — the repository of its own working directory, on the task it leads as its own
 * filing (`repoWriteRefusal`, `session-roles.ts`). Anything else is the person's to write.
 *
 * WHO is asking is decided in this order, never by what the body omits:
 *   1. a `session` proof in the body — verified, or refused (`unverified_sender`);
 *   2. the SOCKET (`browser-caller.ts`'s classifier, the one the browser padlock uses): a peer inside a managed
 *      session's process tree is a session whatever the body says; an unidentifiable local peer is refused
 *      (fail-closed); the person's own browser or terminal is the person;
 *   3. STATED LIMIT: where there is no /proc (macOS, Windows) the socket cannot be read (`no-proc`), and the
 *      body is all there is — a `curl` from a session there passes as the person.
 */
import type { CallerVerdict } from '../browser/browser-caller'
import { defaultRoleDeps, repoWriteRefusal, roleSenderFromBody, type RoleDeps } from './session-roles'

export type RepoGateCode = 'unverified_sender' | 'not_own_task' | 'repo_not_own_cwd'
export interface RepoGateRefusal { status: 403; body: { error: RepoGateCode; message: string } }

const SESSION_NO_ID = 'Only the person can set a repository: run agentop task edit <task> --repo <owner/name> from your own terminal, or use the task screen.'
const UNIDENTIFIED = 'Could not confirm that this request comes from the person (not from a session), so the repository was not changed. Run agentop task edit <task> --repo <owner/name> from your own terminal, or use the task screen.'

/** The task id a reference names, from the real board. */
async function boardTaskId(ref: string): Promise<string | undefined> {
  const [{ loadTaskWorld }, { findTask }] = await Promise.all([import('./task-source'), import('./task-report')])
  return findTask(ref, (await loadTaskWorld()).book.tasks)?.id
}

/**
 * A REST body (may carry `session: {id, token}`): `null` = go on, otherwise the refusal to answer.
 * `value` is the normalized repository being written ('' clears); `caller` is the socket verdict (absent = not asked).
 */
export async function repoEditGate(
  body: { session?: unknown }, ref: string,
  verify: (id: unknown, token: unknown) => Promise<string | null>,
  value: string, caller?: () => CallerVerdict | Promise<CallerVerdict>,
  deps?: RoleDeps, taskIdOf: (ref: string) => Promise<string | undefined> = boardTaskId,
): Promise<RepoGateRefusal | null> {
  const who = await roleSenderFromBody(body, verify)
  if (!who.ok) return { status: 403, body: { error: 'unverified_sender', message: who.message } }
  if (who.sender !== null) return repoEditGateFor(who.sender, ref, value, deps, taskIdOf)
  // No proof in the body: the socket decides, never the omission.
  const v = caller ? await caller() : undefined
  if (!v || v.kind === 'person' || (v.kind === 'unknown' && v.reason === 'no-proc')) return null
  if (v.kind === 'unknown') return { status: 403, body: { error: 'repo_not_own_cwd', message: UNIDENTIFIED } }
  if (v.managedId === null) return { status: 403, body: { error: 'repo_not_own_cwd', message: SESSION_NO_ID } }
  return repoEditGateFor(v.managedId, ref, value, deps, taskIdOf)
}

/** The same decision for a caller whose session identity is already established (the socket's or the CLI's process tree). */
export async function repoEditGateFor(
  sender: string | null, ref: string, value: string, deps?: RoleDeps, taskIdOf: (ref: string) => Promise<string | undefined> = boardTaskId,
): Promise<RepoGateRefusal | null> {
  if (sender === null) return null
  const taskId = await taskIdOf(ref)
  if (!taskId) return null
  const out = await repoWriteRefusal(sender, taskId, deps ?? await defaultRoleDeps(), value)
  return out ? { status: 403, body: { error: out.code, message: out.message } } : null
}

/**
 * PURE. The session a CLI process is, for the repository gate. `null` = the person.
 * The tree wins: a process with a managed-session ancestor is that session whatever its environment says.
 * A session id that is only CLAIMED (environment set, no ancestor proves it) is refused: `'\u0000unproven'` names no session.
 * No readable tree (no /proc): fall back to the proven principal, then to the claim.
 */
export function cliRepoSender(i: { ancestry: readonly { managedId: string | null }[] | null; proven: string | null; claimed: string | null }): string | null {
  const fromTree = i.ancestry?.find(l => l.managedId)?.managedId ?? null
  if (fromTree) return fromTree
  if (i.proven) return i.proven
  if (i.claimed) return '\u0000unproven'
  return null
}
