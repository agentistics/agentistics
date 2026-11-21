/**
 * personalGrant.ts — the owner's proof for the person's OWN browser, held by the page (NAVEGADOR S10 r3).
 *
 * The server cannot tell the person from a session's child process by their socket, so it asks for what a
 * session lacks: a short-lived grant minted by the VAULT's fresh proof (`POST /api/vault/personal-browser`, the
 * same Windows Hello / Touch ID / password the padlock unlock asks). It lives in MEMORY only — never
 * localStorage, never a cookie (a cookie rides to every localhost port) and never a URL: POSTs and the status
 * carry it as a header, the stream mux in its `sub` frame, the input socket as a sub-protocol. A reload or a
 * server restart means proving again, which is the point.
 */
import { useSyncExternalStore } from 'react'
import { vaultPost } from './vaultApi'

export const PERSONAL_GRANT_HEADER = 'X-Agentop-Personal-Grant'
/** MUST equal the server's `PERSONAL_GRANT_PROTOCOL` (`browser/personal-grant.ts`). */
export const PERSONAL_GRANT_PROTOCOL = 'agentop-personal'

let grant: { token: string; exp: number } | null = null
const subs = new Set<() => void>()
const emit = () => { for (const s of subs) s() }

export function setPersonalGrant(token: string, expiresAt: number): void { grant = { token, exp: expiresAt }; emit() }
export function clearPersonalGrant(): void { if (grant === null) return; grant = null; emit() }
export function getPersonalGrant(now: number = Date.now()): string | null {
  if (grant && grant.exp <= now) { grant = null; emit() }
  return grant?.token ?? null
}
export function subscribePersonalGrant(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } }
/** Re-renders when the grant appears, is cleared (a refusal said it is no longer valid) or expires. */
export function usePersonalGrant(): string | null {
  return useSyncExternalStore(subscribePersonalGrant, () => getPersonalGrant(), () => null)
}

export function personalGrantHeaders(): Record<string, string> {
  const g = getPersonalGrant()
  return g ? { [PERSONAL_GRANT_HEADER]: g } : {}
}
/** `new WebSocket(url, protocols)`: the marker the server echoes, then the grant. Undefined without one. */
export function personalInputProtocols(): string[] | undefined {
  const g = getPersonalGrant()
  return g ? [PERSONAL_GRANT_PROTOCOL, g] : undefined
}

export function unlockSentence(pt: boolean): string {
  return pt
    ? 'Para usar o navegador pessoal, confirme que é você com o Cofre (senha, Windows Hello ou Touch ID).'
    : 'To use your own browser, confirm it is you with the Vault (password, Windows Hello or Touch ID).'
}

const UNAVAILABLE = new Set(['owner-proof-unavailable', 'owner_proof_unavailable'])

function refusalSentence(code: string, server: string, pt: boolean): string {
  if (UNAVAILABLE.has(code)) {
    return pt
      ? 'Para usar o navegador pessoal, o agentistics precisa confirmar que é você. Abra o Cofre e crie uma senha (ou ative o Windows Hello / Touch ID); depois tente de novo.'
      : 'To use your own browser, agentistics needs to confirm it is you. Open the Vault and set a password (or turn on Windows Hello / Touch ID), then try again.'
  }
  if (code === 'owner-proof-local-only' || code === 'owner_proof_local_only') return pt ? 'Esta confirmação só pode ser feita neste computador.' : 'This confirmation can only be given on this computer.'
  if (code === 'session_cannot_unlock') return pt ? 'Só a pessoa pode usar o navegador pessoal.' : 'Only the person can use the personal browser.'
  if (server && server.trim()) return server
  return pt ? 'Não foi possível confirmar que é você. Tente de novo.' : 'Could not confirm it is you. Try again.'
}

export type UnlockOutcome = { ok: true } | { ok: false; code: string; sentence: string; openVault: boolean }
export type AskGrant = () => Promise<{ ok: true; personalGrant: string; expiresAt: number } | { ok: false; code: string; sentence: string }>

const askVault: AskGrant = async () => {
  const r = await vaultPost<{ personalGrant: string; expiresAt: number }>('/api/vault/personal-browser', {})
  if (r.ok && typeof r.personalGrant === 'string') return { ok: true, personalGrant: r.personalGrant, expiresAt: Number(r.expiresAt) || Date.now() + 3_600_000 }
  return { ok: false, code: r.ok ? 'failed' : r.code, sentence: r.ok ? '' : r.sentence }
}

/** The person's proof, once: asks the vault (its own prompt / gesture) and keeps the grant in memory. */
export async function requestPersonalGrant(ask: AskGrant = askVault, pt = false): Promise<UnlockOutcome> {
  const r = await ask()
  if (r.ok) { setPersonalGrant(r.personalGrant, r.expiresAt); return { ok: true } }
  return { ok: false, code: r.code, sentence: refusalSentence(r.code, r.sentence, pt), openVault: UNAVAILABLE.has(r.code) }
}

/** End the grant here and on the server (a "lock the browser again"). */
export async function revokePersonalGrant(): Promise<void> {
  const g = getPersonalGrant()
  clearPersonalGrant()
  if (!g) return
  try { await vaultPost('/api/vault/personal-browser', { revoke: true, grant: g }) } catch { /* the server forgets it on restart anyway */ }
}
