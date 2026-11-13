/**
 * delivery/principal-http.ts — the screen every `/api/tasks` WRITE passes before its handler (ENTREGA.GARANTIDA §2.3).
 * It holds no board rule: it refuses an `actor` that claims to be the engine or the owner (`reserved_actor`) and a
 * `session` that claims an identity it cannot prove (`unverified_sender`). The guards that USE the principal arrive
 * with the store guard (S2a); this slice makes sure the display string can no longer impersonate anybody.
 */
import { isReservedActor } from './principal'

export type PrincipalScreen = { status: 400 | 403 | 415; body: { error: string; sentence: string } } | null

const isTasksPath = (p: string) => p === '/api/tasks' || p.startsWith('/api/tasks/')

/**
 * S0d.3 (QA F3) — the screen for EVERY `/api/tasks*` write, whatever its `content-type` (or none, or `Application/Json`).
 * The handlers parse JSON regardless of the header, so gating the screen on the header was the bypass: `text/plain`
 * carried `actor: "flow:entrega"` and a forged session straight through. Now the body is read as text and parsed; a
 * non-empty body that is not JSON is refused 415 `json_required`. The one exception is the file upload
 * (`<ref>/files`, multipart), whose handler reads only the form and never an `actor` or a `session`.
 */
export async function screenTaskRequest(
  r: { path: string; method: string; contentType: string | null; text: () => Promise<string> },
  verify: (id: unknown, token: unknown) => Promise<string | null>,
): Promise<PrincipalScreen> {
  const m = r.method.toUpperCase()
  if (!isTasksPath(r.path) || m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null
  if (r.path.endsWith('/files') && /^\s*multipart\/form-data/i.test(r.contentType ?? '')) return null
  const text = await r.text().catch(() => '')
  if (!text.trim()) return null
  let body: unknown
  try { body = JSON.parse(text) } catch {
    return { status: 415, body: { error: 'json_required', sentence: 'a task write must send a JSON body' } }
  }
  return screenTaskWrite(body, verify)
}

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
