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

export interface MobileState { passkeys: { id: string; label: string; rpId: string; createdAt: string }[]; codeReveal: boolean; loopback: boolean; devices?: { id: string; label: string; createdAt: string }[] }
export const mobileState = () => vaultGet<MobileState>('/api/vault/personal/mobile')
/** PURE. Does THIS host have a passkey registered (a credential answers only on its own rpId)? */
export function hasPasskeyHere(s: MobileState | null, host: string): boolean { return Boolean(s?.passkeys.some(p => p.rpId === host)) }

export const setCodeReveal = (enabled: boolean, code?: string) => vaultPost<{ codeReveal: boolean }>('/api/vault/personal/mobile/code-reveal', { enabled, ...(code ? { code } : {}) })
export const removePasskey = (id: string, code?: string) => vaultPost('/api/vault/personal/mobile/passkeys/remove', { id, ...(code ? { code } : {}) })

// Registering a phone is two halves on two devices since §10 — see `phoneVault.ts` (`requestEnrol` → `enrolPasskey`).

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
