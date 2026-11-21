/**
 * NAVEGADOR S10 r3 — the owner's proof for the person's OWN browser.
 *
 * The socket (`browser-caller.ts`) can never prove "this is the person": a detached child with a clean
 * environment, a `--network host` container and `systemd-run` all look like them. The personal browser holds
 * their real logins, so it asks for what a session does not have: a short-lived grant the VAULT's fresh owner
 * proof minted (`POST /api/vault/personal-browser`, the same proof the padlock unlock uses), held by the
 * person's UI and sent on every personal door — a header on the POSTs and the status, the mux subscription's
 * own field on the stream, a sub-protocol on the input socket. Never a URL, never a cookie (a cookie rides to
 * every localhost port the person's browser visits, including a dev server a session started).
 *
 * Server side the grant is random, in MEMORY ONLY (a restart revokes everything — the person proves again),
 * stored as a digest, bound to the HTTP session that asked, ≤ 12 h and revocable. Nothing here logs a token.
 */
import { createHash, randomBytes } from 'node:crypto'
import { personalCallerRefusal, type CallerVerdict, type PersonalRefusal } from './browser-caller'

export const PERSONAL_GRANT_TTL_MS = 12 * 3_600_000
export const PERSONAL_GRANT_HEADER = 'x-agentop-personal-grant'
/** The sub-protocol the input socket answers with; the grant rides as the NEXT offered protocol. */
export const PERSONAL_GRANT_PROTOCOL = 'agentop-personal'
const MAX_GRANTS = 64
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/

const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

export class PersonalGrants {
  private readonly grants = new Map<string, { exp: number; session: string }>()

  mint(session: string, nowMs: number = Date.now()): { token: string; expiresAt: number } {
    for (const [k, v] of this.grants) if (v.exp <= nowMs) this.grants.delete(k)
    while (this.grants.size >= MAX_GRANTS) { const oldest = this.grants.keys().next().value; if (oldest === undefined) break; this.grants.delete(oldest) }
    const token = randomBytes(32).toString('base64url')
    const expiresAt = nowMs + PERSONAL_GRANT_TTL_MS
    this.grants.set(digest(token), { exp: expiresAt, session })
    return { token, expiresAt }
  }

  check(token: unknown, session: string, nowMs: number = Date.now()): boolean {
    if (typeof token !== 'string' || !TOKEN.test(token)) return false
    const g = this.grants.get(digest(token))
    return !!g && g.session === session && g.exp > nowMs
  }

  revoke(token: unknown): void { if (typeof token === 'string') this.grants.delete(digest(token)) }
  revokeAll(): void { this.grants.clear() }
  size(): number { return this.grants.size }
  /** Tests only: what the store keys by (digests, never tokens). */
  __debugKeys(): string[] { return [...this.grants.keys()] }
}

let shared: PersonalGrants | null = null
/** The one store of this server process. */
export function personalGrants(): PersonalGrants { return (shared ??= new PersonalGrants()) }
export function __resetPersonalGrantsForTests(): void { shared = null }

/** The grant the input socket's `Sec-WebSocket-Protocol` carries (`agentop-personal, <token>`), or null. */
export function personalGrantFromProtocols(header: string | null | undefined): string | null {
  if (!header) return null
  const parts = header.split(',').map(s => s.trim())
  if (parts[0] !== PERSONAL_GRANT_PROTOCOL) return null
  const t = parts[1]
  return t && TOKEN.test(t) ? t : null
}

export type PersonalDoorRefusal = Omit<PersonalRefusal, 'error'> & {
  error: 'personal_proof_required' | PersonalRefusal['error']
  action?: { kind: 'open-vault'; path: '/vault' }
}

/** The JSON body a door answers a refusal with (the same shape on every door). */
export function personalRefusalBody(r: PersonalDoorRefusal): { ok: false; error: string; sentence: string; action?: { kind: 'open-vault'; path: '/vault' }; why?: string } {
  return { ok: false, error: r.error, sentence: r.sentence, ...(r.action ? { action: r.action } : {}), ...(r.why ? { why: r.why } : {}) }
}

/**
 * The ONE decision every personal door shares (POST verbs, status, stream, input socket): no valid grant is
 * refused whatever the socket says; a known SESSION is refused even with one (the socket stays as an extra
 * refusal — it can add a no, never a yes). `null` = proceed.
 */
export function personalDoorRefusal(i: { grantOk: boolean; caller: CallerVerdict; lang?: 'en' | 'pt' }): PersonalDoorRefusal | null {
  const pt = i.lang === 'pt'
  if (!i.grantOk) {
    return {
      status: 403, error: 'personal_proof_required', action: { kind: 'open-vault', path: '/vault' },
      sentence: pt
        ? 'Para usar o navegador pessoal, confirme que é você com o Cofre (senha, Windows Hello ou Touch ID).'
        : 'To use your own browser, confirm it is you with the Vault (password, Windows Hello or Touch ID).',
    }
  }
  if (i.caller.kind === 'session') return personalCallerRefusal(i.caller, i.lang ?? 'en')
  return null
}
