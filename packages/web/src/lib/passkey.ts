/**
 * VAULT.PERSONAL §7 — the phone's passkey, browser side. Registration sends what the browser already
 * decodes (`getPublicKey()` SPKI, `getPublicKeyAlgorithm()`, `getAuthenticatorData()`), so the service
 * needs no CBOR parser; `attestation: 'none'`, `userVerification: 'required'`. The service verifies
 * everything (vault/webauthn.ts); this module only drives `navigator.credentials` and encodes bytes.
 */
import { vaultGet, vaultPost, type Reply } from './vaultApi'

export const b64urlEncode = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const x of u) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const b64urlBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  const out = new Uint8Array(new ArrayBuffer(b.length))
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

/** PURE. Can this page use a passkey at all? (WebAuthn exists only in a secure context.) */
export function passkeySupport(w: { isSecureContext?: boolean; PublicKeyCredential?: unknown }): 'ok' | 'insecure' | 'unsupported' {
  if (!w.isSecureContext) return 'insecure'
  return w.PublicKeyCredential ? 'ok' : 'unsupported'
}

export interface MobileState { passkeys: { id: string; label: string; rpId: string; createdAt: string }[]; codeReveal: boolean; loopback: boolean }
export const mobileState = () => vaultGet<MobileState>('/api/vault/personal/mobile')
/** PURE. Does THIS host have a passkey registered (a credential answers only on its own rpId)? */
export function hasPasskeyHere(s: MobileState | null, host: string): boolean { return Boolean(s?.passkeys.some(p => p.rpId === host)) }

export const setCodeReveal = (enabled: boolean, code?: string) => vaultPost<{ codeReveal: boolean }>('/api/vault/personal/mobile/code-reveal', { enabled, ...(code ? { code } : {}) })
export const removePasskey = (id: string, code?: string) => vaultPost('/api/vault/personal/mobile/passkeys/remove', { id, ...(code ? { code } : {}) })

type RegisterBegin = { options: { challengeId: string; challenge: string; rp: { id: string; name: string }; user: { id: string; name: string; displayName: string }; pubKeyCredParams: { type: 'public-key'; alg: number }[] } }

/** Register this phone. The first call asks the code (and raises Windows Hello on the computer). */
export async function registerPasskey(label: string, code?: string): Promise<Reply<{ id: string }>> {
  const b = await vaultPost<RegisterBegin>('/api/vault/personal/mobile/register/begin', { label, ...(code ? { code } : {}) })
  if (!b.ok) return b
  const o = b.options
  let cred: PublicKeyCredential | null
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64urlBytes(o.challenge), rp: o.rp, user: { ...o.user, id: b64urlBytes(o.user.id) }, pubKeyCredParams: o.pubKeyCredParams,
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' }, attestation: 'none', timeout: 60_000,
      },
    }) as PublicKeyCredential | null
  } catch { cred = null }
  if (!cred) return { ok: false, code: 'passkey-cancelled', sentence: '', status: 0 }
  const r = cred.response as AuthenticatorAttestationResponse
  const pk = r.getPublicKey?.()
  if (!pk) return { ok: false, code: 'passkey-unsupported', sentence: '', status: 0 }
  return vaultPost<{ id: string }>('/api/vault/personal/mobile/register/finish', {
    challengeId: o.challengeId, clientDataJSON: b64urlEncode(r.clientDataJSON), authenticatorData: b64urlEncode(r.getAuthenticatorData()),
    publicKey: b64urlEncode(pk), alg: r.getPublicKeyAlgorithm(), credentialId: b64urlEncode(cred.rawId),
  })
}

/**
 * One phone gesture for ONE action on ONE target → a single-use token the next call carries. The begin
 * may ask the code (the read grant); the caller passes it.
 */
export async function phoneGesture(action: string, target: string, code?: string): Promise<Reply<{ gestureToken: string }>> {
  const b = await vaultPost<{ challengeId: string; challenge: string; allowCredentials: string[]; rpId: string }>('/api/vault/personal/mobile/assert/begin', { action, target, ...(code ? { code } : {}) })
  if (!b.ok) return b
  let cred: PublicKeyCredential | null
  try {
    cred = await navigator.credentials.get({
      publicKey: { challenge: b64urlBytes(b.challenge), rpId: b.rpId, allowCredentials: b.allowCredentials.map(id => ({ type: 'public-key' as const, id: b64urlBytes(id) })), userVerification: 'required', timeout: 60_000 },
    }) as PublicKeyCredential | null
  } catch { cred = null }
  if (!cred) return { ok: false, code: 'passkey-cancelled', sentence: '', status: 0 }
  const r = cred.response as AuthenticatorAssertionResponse
  return vaultPost<{ gestureToken: string }>('/api/vault/personal/mobile/assert/finish', {
    challengeId: b.challengeId, credentialId: b64urlEncode(cred.rawId), clientDataJSON: b64urlEncode(r.clientDataJSON),
    authenticatorData: b64urlEncode(r.authenticatorData), signature: b64urlEncode(r.signature),
  })
}
