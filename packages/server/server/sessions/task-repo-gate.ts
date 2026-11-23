/**
 * task-repo-gate.ts — who may write a task's repository (D7, 2026-11-21).
 *
 * The repository a person writes is the only one that counts for leading (`leadOp`). A same-user agent chooses its
 * own environment and process tree (`systemd-run --user`, `setsid -f env -i`, a double fork) and can even
 * `git remote set-url` its own cwd, so neither the process tree, the socket classifier nor "the repository of its
 * own cwd" is a barrier for a WRITE. Therefore:
 *
 *   - a SESSION never writes a task's repository — REST, MCP and CLI alike: 403 `repo_person_only`;
 *   - the PERSON writes it from the task screen with the owner's single-use vault grant (the same gate as the
 *     delivery approval: `consumeDeliveryGrant`, header `X-Agentop-Owner-Grant`, loopback + Origin), scoped to
 *     ONE task (`taskRepoScope`). No grant → 403 `owner_proof_required` (the screen then asks the vault).
 *
 * The `session` proof in the body is a courtesy that gives a session the precise sentence. It is NOT the barrier:
 * the grant is. A caller that hides from it (no proof, own environment, own process tree) has no grant either.
 */
import type { DeliveryGrantUse, DeliveryScope } from '../vault/gate'
import { roleSenderFromBody } from './session-roles'

export type RepoGateCode = 'repo_person_only' | 'unverified_sender' | 'owner_proof_required' | 'grant_scope' | 'grant_invalid' | 'owner_proof_local_only' | 'owner_proof_unavailable'
export interface RepoGateRefusal { status: 403; body: { error: RepoGateCode; message: string; action?: { kind: 'open-vault'; path: string } } }

/** The one sentence a session is told, everywhere (REST, MCP, CLI). */
export const REPO_PERSON_ONLY = 'Only the person sets a task\'s repository, from the task screen.'
export const REPO_PERSON_ONLY_PT = 'Só a pessoa define o repositório de uma tarefa, na tela da tarefa.'

/** The grant scope of ONE task's repository: a grant minted for another task, or for a delivery move, never spends here. */
export function taskRepoScope(taskId: string): DeliveryScope { return { pieceKey: `task-repo:${taskId}`, move: 'edit' } }

const personOnly = (): RepoGateRefusal => ({ status: 403, body: { error: 'repo_person_only', message: REPO_PERSON_ONLY } })

/** The task id a reference names, from the real board. */
async function boardTaskId(ref: string): Promise<string | undefined> {
  const [{ loadTaskWorld }, { findTask }] = await Promise.all([import('./task-source'), import('./task-report')])
  return findTask(ref, (await loadTaskWorld()).book.tasks)?.id
}

export interface RepoGateInput {
  body: { session?: unknown } & Record<string, unknown>
  ref: string
  verify: (id: unknown, token: unknown) => Promise<string | null>
  /** The `X-Agentop-Owner-Grant` header. */
  grant: string | null
  consume: (token: string | null, scope: DeliveryScope) => DeliveryGrantUse
  /** Whether the vault can give an owner proof at all (`false` = silent-only / uninitialized). */
  proofAvailable?: () => Promise<boolean | null>
  lang?: 'en' | 'pt'
  taskIdOf?: (ref: string) => Promise<string | undefined>
}

const GRANT_TEXT: Record<string, { en: string; pt: string }> = {
  owner_proof_required: { en: 'Confirm it is you (vault password, Windows Hello or Touch ID) to change the repository. Each confirmation works once, for 5 minutes.', pt: 'Confirme que é você (senha do Cofre, Windows Hello ou Touch ID) para mudar o repositório. Cada confirmação vale uma vez, por 5 minutos.' },
  grant_scope: { en: 'That confirmation was for another task. Confirm again for this one.', pt: 'Essa confirmação era para outra tarefa. Confirme de novo para esta.' },
  grant_invalid: { en: 'That confirmation expired or was already used. Confirm again.', pt: 'Essa confirmação expirou ou já foi usada. Confirme de novo.' },
  owner_proof_local_only: { en: 'This confirmation can only be given on this computer.', pt: 'Esta confirmação só pode ser feita neste computador.' },
  owner_proof_unavailable: { en: 'To change a task\'s repository, agentistics needs to confirm it is you. Open the Vault and set a password (or turn on Windows Hello / Touch ID), then try again.', pt: 'Para mudar o repositório de uma tarefa, o agentistics precisa confirmar que é você. Abra o Cofre e crie uma senha (ou ative o Windows Hello / Touch ID); depois tente de novo.' },
}

/** `null` = go on (the person, with a grant spent for exactly this task), otherwise the refusal to answer. */
export async function repoEditGate(i: RepoGateInput): Promise<RepoGateRefusal | null> {
  const lang = i.lang ?? 'en'
  // 1. A session identified by proof in the body: refused whatever else it carries.
  const who = await roleSenderFromBody(i.body, i.verify)
  if (!who.ok) return { status: 403, body: { error: 'unverified_sender', message: who.message } }
  if (who.sender !== null) return personOnly()
  // 2. THE barrier: the owner's single-use grant for this one task.
  const taskId = await (i.taskIdOf ?? boardTaskId)(i.ref)
  if (!taskId) return null // no such task: the write answers 404 itself, nothing to protect
  const used = i.consume(i.grant, taskRepoScope(taskId))
  if (used.ok) return null
  const code = (used.code === 'grant-scope' ? 'grant_scope' : used.code === 'owner-proof-local-only' ? 'owner_proof_local_only' : 'grant_invalid') as RepoGateCode
  const setup = code === 'grant_invalid' && !i.grant && (await i.proofAvailable?.().catch(() => null)) === false
  const key = setup ? 'owner_proof_unavailable' : !i.grant && code === 'grant_invalid' ? 'owner_proof_required' : code
  return { status: 403, body: { error: key as RepoGateCode, message: GRANT_TEXT[key]![lang], ...(setup ? { action: { kind: 'open-vault' as const, path: '/vault' } } : {}) } }
}
