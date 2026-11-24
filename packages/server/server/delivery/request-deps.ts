/**
 * delivery/request-deps.ts — the ONE place `index.ts` builds the principal deps for a `/api/tasks*` write
 * (eg-integ r4, closes QA r3 R2). The mode is ALWAYS the real `readOwnerProofMode` — a caller cannot pass another —
 * so a wiring slip (a hardcoded `required`, a dropped session proof) lives here, where the HTTP test drives it,
 * not in the 4500-line request closure.
 *
 * Everything heavy is imported lazily: nothing here runs at startup.
 */
import type { PrincipalDeps, BrowserFacts, WebReply } from './web'

/** Seams a test may replace. `mode` is deliberately NOT one of them. */
export interface RequestDepsIo {
  verify?: (id: unknown, token: unknown) => Promise<string | null>
  consumeGrant?: PrincipalDeps['consumeGrant']
}

export async function taskRequestDeps(browser: () => BrowserFacts, io: RequestDepsIo = {}): Promise<PrincipalDeps> {
  const [{ verifySessionIdentity }, { readOwnerProofMode }, gateMod] = await Promise.all([
    import('../sessions/session-identity'), import('./owner-mode'), io.consumeGrant ? Promise.resolve(null) : import('../vault/gate'),
  ])
  return {
    verify: io.verify ?? ((id, token) => verifySessionIdentity(id, token)),
    mode: readOwnerProofMode,
    get browser() { return browser() },
    consumeGrant: io.consumeGrant ?? ((token, scope) => gateMod!.consumeDeliveryGrant(token, { session: 'http:local', loopback: browser().loopbackPeer }, scope)),
  }
}

/** The free-text author of a comment / thread, as `index.ts` reads it: deps are built only when a reserved name needs them. */
export async function taskAuthorField(
  raw: unknown, move: string, ref: string,
  known: 'keep' | { kind: 'session'; id: string; via: 'token' } | undefined,
  body: Record<string, unknown>, depsOf: () => Promise<PrincipalDeps>,
): Promise<{ ok: true; value: string } | { ok: false; reply: WebReply }> {
  const [{ authorFieldAs }, { isReservedActor }] = await Promise.all([import('./principal-http'), import('./principal')])
  const text = String(raw ?? '')
  return authorFieldAs(raw, move, ref, known, body, text && isReservedActor(text) && known !== 'keep' ? await depsOf() : { verify: async () => null, mode: async () => 'legacy' as const })
}

/**
 * The store's `GuardContext` for a `/api/tasks*` write (S2c.1). A `body.session` claim is a CLAIM: it becomes a session
 * principal only when its token proves it (`verifySessionIdentity`); a claim that does not prove itself is REFUSED 403 — it
 * never degrades to the person's (unattributed) context, which would let a forged id act as an anonymous request. No claim
 * at all is the person's own request: `unattributed`.
 */
export async function guardContextOfRequest(
  body: Record<string, unknown>, io: RequestDepsIo = {},
): Promise<{ ok: true; ctx: import('./guard').GuardContext } | { ok: false; reply: WebReply }> {
  const claim = body.session as { id?: unknown; token?: unknown } | undefined | null
  if (claim === undefined || claim === null) return { ok: true, ctx: { principal: { kind: 'unattributed' } } }
  const { verifySessionIdentity } = await import('../sessions/session-identity')
  const verify = io.verify ?? ((id: unknown, token: unknown) => verifySessionIdentity(id, token))
  const id = typeof claim === 'object' ? await verify(claim.id, claim.token) : null
  if (id) return { ok: true, ctx: { principal: { kind: 'session', id, via: 'token' } } }
  return { ok: false, reply: { status: 403, body: { error: 'unverified_sender', sentence: 'the session identity could not be verified' } } }
}

export type OpenKnown = 'keep' | { kind: 'session'; id: string; via: 'token' } | undefined

/**
 * Who a thread OPEN is, before the author name is read (r3 W3a/W3b): a proven session is recorded as ITSELF; the owner's
 * web UI (`owner: true`) in REQUIRED mode needs the owner gate and then keeps the owner's name; legacy is untouched.
 */
export async function threadOpenKnown(
  body: Record<string, unknown>, ref: string,
  ownerGate: (pieceKey: string, move: string) => Promise<{ status: number; body: unknown } | null | undefined | void>,
  io: RequestDepsIo = {},
): Promise<{ known: OpenKnown; denied?: { status: number; body: unknown } }> {
  const [{ verifySessionIdentity }, { readOwnerProofMode }] = await Promise.all([import('../sessions/session-identity'), import('./owner-mode')])
  const claim = body.session as { id?: unknown; token?: unknown } | undefined
  const verify = io.verify ?? ((id: unknown, token: unknown) => verifySessionIdentity(id, token))
  const session = claim ? await verify(claim.id, claim.token) : null
  if (session) return { known: { kind: 'session', id: session, via: 'token' } }
  if (body.owner === true && await readOwnerProofMode() === 'required') {
    const denied = await ownerGate(ref, 'thread:open')
    if (denied) return { known: undefined, denied }
    return { known: 'keep' }
  }
  return { known: undefined }
}
