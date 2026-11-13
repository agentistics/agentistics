/**
 * delivery/principal-http.ts — the screen every `/api/tasks` WRITE passes before its handler (ENTREGA.GARANTIDA §2.3).
 * It holds no board rule: it refuses an `actor` that claims to be the engine or the owner (`reserved_actor`) and a
 * `session` that claims an identity it cannot prove (`unverified_sender`). The guards that USE the principal arrive
 * with the store guard (S2a); this slice makes sure the display string can no longer impersonate anybody.
 */
import { isReservedActor } from './principal'

export type PrincipalScreen = { status: 400 | 403; body: { error: string; sentence: string } } | null

export async function screenTaskWrite(
  body: unknown, verify: (id: unknown, token: unknown) => Promise<string | null>,
): Promise<PrincipalScreen> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (isReservedActor(b.actor)) return { status: 400, body: { error: 'reserved_actor', sentence: 'actor may not be "owner", "you", "dono" or "flow:*" — those names are decided by the server, not claimed in a request' } }
  const s = b.session as { id?: unknown; token?: unknown } | undefined | null
  if (s && typeof s === 'object' && !(await verify(s.id, s.token))) return { status: 403, body: { error: 'unverified_sender', sentence: 'the session identity could not be verified' } }
  return null
}
