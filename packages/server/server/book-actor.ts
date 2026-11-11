import type { EngineBookActor } from '@agentistics/engine-api'

export interface BookActorProof {
  id?: unknown
  token?: unknown
}

export interface BookActorBody {
  session?: unknown
}

export interface BookRoleDeps {
  /** The stored roles document's `roles` map. */
  roles: () => Promise<Record<string, string>>
  /** The registry row of a managed id (its conversation id is the roles key once it has one). */
  row: (id: string) => Promise<{ id: string; conversationId?: string | undefined } | undefined>
  roleOfRow: (roles: Record<string, never>, row: { id: string; conversationId?: string | undefined }) => string | undefined
}

/**
 * The stored role of a VERIFIED managed id. Roles are keyed by the session's conversation id once it has one
 * (`sessionIdentityKey`), so the registry row is read first; the managed id alone would read a real leader as a
 * plain user. Only `leader` / `worker` count.
 */
export async function bookRoleOf(id: string, deps: BookRoleDeps): Promise<'leader' | 'worker' | undefined> {
  const roles = await deps.roles()
  const row = (await deps.row(id).catch(() => undefined)) ?? { id }
  const role = deps.roleOfRow(roles as Record<string, never>, row)
  return role === 'leader' || role === 'worker' ? role : undefined
}

export interface BookActorDeps {
  verify: (id: unknown, token: unknown) => Promise<string | null>
  roleOf?: (id: string) => Promise<'leader' | 'worker' | undefined>
}

/**
 * Resolve the actor for a local Book request. The request body may carry the same session proof as
 * the session-message and session-role doors; all other actor-shaped fields are deliberately ignored.
 * A request with no proof cannot be told apart from any local process (a session can simply omit it),
 * so it is an UNVERIFIED local user, never the owner: owner authority needs its own origin check
 * (the owner-message hook, a later slice). A failed proof is likewise unverified.
 */
export async function bookActorFromRequest(
  req: Request,
  deps: BookActorDeps,
  bodyOverride?: BookActorBody | null,
): Promise<EngineBookActor> {
  let body: BookActorBody | null = bodyOverride ?? null
  if (bodyOverride === undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    body = await req.clone().json().catch(() => null) as BookActorBody | null
  }

  const bodyHasProof = body !== null && Object.prototype.hasOwnProperty.call(body, 'session')
  const headerId = req.headers.get('x-agentistics-session-id')
  const headerToken = req.headers.get('x-agentistics-session-token')
  const headerHasProof = headerId !== null || headerToken !== null
  const proof = bodyHasProof
    ? body?.session
    : headerHasProof
      ? { id: headerId, token: headerToken }
      : undefined

  if (proof === undefined) return { id: 'localShell', verified: false, role: 'user' }
  const candidate = proof && typeof proof === 'object' ? proof as BookActorProof : {}
  const id = await deps.verify(candidate.id, candidate.token)
  if (!id) return { id: 'localShell', verified: false, role: 'user' }
  return { id, verified: true, role: (await deps.roleOf?.(id)) ?? 'user' }
}
