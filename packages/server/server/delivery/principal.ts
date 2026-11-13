/**
 * delivery/principal.ts — ENTREGA.GARANTIDA §2.3. WHO is asking, decided by what the caller PROVED, never by
 * what it left out. `actor` stays a display string; every write path resolves a `RequestPrincipal` first.
 *
 *   owner / vault-credential  a valid single-use `delivery` grant (a fresh proof of the vault's own credential)
 *   owner / legacy-browser    `ownerProof: legacy` only, and only the narrow browser shape — WARN-flagged
 *   session                   a pane / structured session that PROVED itself (HMAC), or the CLI process tree
 *   flow                      the engine itself, IN-PROCESS — never built from a request body
 *   unattributed              anything else, including "no proof at all"
 *
 * PURE: no IO. The adapters (REST in `web.ts`/`index.ts`, MCP, CLI) gather the facts; the vault gate
 * (`vault/gate.ts` `requireDeliveryOwner`) mints the grant. Nothing here reads a file or a clock.
 */

export type OwnerProofMode = 'legacy' | 'required'
export type FlowEngine = 'entrega' | 'verificacao' | 'custody'

export type RequestPrincipal =
  | { kind: 'owner'; via: 'vault-credential'; grantId: string }
  | { kind: 'owner'; via: 'legacy-browser' }
  | { kind: 'session'; id: string; via: 'token' | 'process-tree' }
  | { kind: 'flow'; engine: FlowEngine }
  | { kind: 'unattributed' }

/** An absent / unreadable / unknown value reads as `legacy` (owner order: `required` is opt-in). */
export function parseOwnerProofMode(v: unknown): OwnerProofMode { return v === 'required' ? 'required' : 'legacy' }

/** A body `actor` may never claim to be the engine or the owner: `flow:*`, `owner`, `you`, `dono`. */
export function isReservedActor(actor: unknown): boolean {
  if (typeof actor !== 'string') return false
  const a = actor.trim().toLowerCase()
  return a === 'owner' || a === 'you' || a === 'dono' || a.startsWith('flow:')
}

/** What the REST adapter could establish about the HTTP request. All of it is evidence, none of it is trusted by default. */
export interface RestFacts {
  mode: OwnerProofMode
  /** A `delivery` grant the vault already CONSUMED for exactly this request's scope (single-use). */
  grant?: { id: string } | null
  /** `body.session` was present. */
  sessionClaimed: boolean
  /** The id `verifySessionIdentity` returned for it (null = the proof failed). */
  sessionVerified: string | null
  /** The body's display `actor`, if any. */
  actor?: unknown
  /** Loopback socket peer AND loopback Host (vault `loopbackRequest`). Matters ONLY for the `delivery` grant, never for the legacy browser shape. */
  loopbackPeer: boolean
  /** `Origin` header (when present) is this server's own web origin. */
  originOwn: boolean
  /** `Sec-Fetch-Site: same-origin`. */
  sameOriginFetch: boolean
}

export type RestResolution =
  | { ok: true; principal: RequestPrincipal }
  | { ok: false; status: 400 | 403; code: 'reserved_actor' | 'unverified_sender'; sentence: string }

/** §2.3 REST order: grant → proven session → (legacy only) the browser shape → unattributed. */
export function resolveRestPrincipal(f: RestFacts): RestResolution {
  if (isReservedActor(f.actor)) return { ok: false, status: 400, code: 'reserved_actor', sentence: 'actor may not be "owner", "you", "dono" or "flow:*" — those names are decided by the server, not claimed in a request' }
  if (f.sessionClaimed && !f.sessionVerified) return { ok: false, status: 403, code: 'unverified_sender', sentence: 'the session identity could not be verified' }
  // A session that proves itself is a session, whatever browser headers ride along (§3.5.15 viii) — and it never holds a grant.
  if (f.sessionVerified) return { ok: true, principal: { kind: 'session', id: f.sessionVerified, via: 'token' } }
  if (f.grant) return { ok: true, principal: { kind: 'owner', via: 'vault-credential', grantId: f.grant.id } }
  if (f.mode === 'legacy' && f.originOwn && f.sameOriginFetch) {
    return { ok: true, principal: { kind: 'owner', via: 'legacy-browser' } }
  }
  return { ok: true, principal: { kind: 'unattributed' } }
}

/** The display / service-layer string. `owner` only for a principal that IS the owner; "no proof" is `unattributed`. */
export function actorOf(p: RequestPrincipal): string {
  switch (p.kind) {
    case 'owner': return 'owner'
    case 'session': return p.id
    case 'flow': return `flow:${p.engine}`
    case 'unattributed': return 'unattributed'
  }
}

export const isOwner = (p: RequestPrincipal): boolean => p.kind === 'owner'

/** The token the owner-only moves are scoped to. */
export interface OwnerScope { pieceKey: string; move: string }

/** `approve:publicado`, `phase:done`, `override` … — ONE spelling shared by the grant mint and the grant use. */
export function ownerMove(action: unknown, detail?: unknown): string {
  const a = typeof action === 'string' ? action : ''
  const d = typeof detail === 'string' && detail ? `:${detail}` : ''
  return `${a}${d}`
}

/** Owner-only moves and what a non-owner principal is told. */
export function ownerRefusal(p: RequestPrincipal, mode: OwnerProofMode): { status: 403; code: 'owner_proof_required' | 'so_o_dono'; sentence: string } | null {
  if (isOwner(p)) return null
  if (mode === 'required' && p.kind === 'unattributed') {
    return { status: 403, code: 'owner_proof_required', sentence: 'this move needs the owner’s fresh proof of the vault credential (password, Hello or Touch ID) — confirm it in the vault dialog and retry' }
  }
  return { status: 403, code: 'so_o_dono', sentence: 'only the owner may do this (a session or an unattributed caller cannot)' }
}

/** Who `leads()` accepts without looking anything up: the owner and the engine. A session must be the proven leader; `unattributed` never. */
export function leadsByPrincipalActor(actor: string): boolean {
  return actor === 'owner' || actor.startsWith('flow:')
}
