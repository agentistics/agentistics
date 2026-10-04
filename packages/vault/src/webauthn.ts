/**
 * webauthn.ts — the minimum of WebAuthn a phone passkey needs to stand for a gesture (VAULT.PERSONAL
 * spec §7). PURE apart from `node:crypto`; no dependency. Registration takes what the browser's
 * `AuthenticatorAttestationResponse` already decodes (`getPublicKey()` SPKI, `getPublicKeyAlgorithm()`,
 * `getAuthenticatorData()`), so there is no CBOR parser to get wrong; `attestation: 'none'`.
 *
 * Every check refuses at the first failure and names it with a code — never a guess, never a partial yes.
 */
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'

export const ES256 = -7
export const RS256 = -257

export function b64urlDecode(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null
  return new Uint8Array(Buffer.from(s.replace(/=+$/, ''), 'base64url'))
}
export const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const sha256 = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest())
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export interface AuthData { rpIdHash: Uint8Array; up: boolean; uv: boolean; at: boolean; signCount: number; credentialId: Uint8Array | null }

/** authenticatorData: rpIdHash(32) ‖ flags(1) ‖ signCount(4) [‖ aaguid(16) ‖ idLen(2) ‖ id ‖ COSE key…]. */
export function parseAuthData(b: Uint8Array): AuthData | null {
  if (b.length < 37) return null
  const flags = b[32]!
  const at = (flags & 0x40) !== 0
  const signCount = Buffer.from(b.subarray(33, 37)).readUInt32BE(0)
  let credentialId: Uint8Array | null = null
  if (at) {
    if (b.length < 55) return null
    const len = Buffer.from(b.subarray(53, 55)).readUInt16BE(0)
    if (b.length < 55 + len || len === 0) return null
    credentialId = b.slice(55, 55 + len)
  }
  return { rpIdHash: b.slice(0, 32), up: (flags & 0x01) !== 0, uv: (flags & 0x04) !== 0, at, signCount, credentialId }
}

export type WebAuthnFail =
  | 'bad-input' | 'client-type' | 'challenge' | 'origin' | 'rp-id' | 'no-presence' | 'no-verification'
  | 'credential-id' | 'alg' | 'key' | 'signature' | 'counter' | 'unknown-credential'

export interface ClientData { type: string; challenge: string; origin: string }
function parseClientData(json: Uint8Array): ClientData | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>
    return typeof o.type === 'string' && typeof o.challenge === 'string' && typeof o.origin === 'string' ? { type: o.type, challenge: o.challenge, origin: o.origin } : null
  } catch { return null }
}

export interface StoredPasskey { credentialId: string; spki: string; alg: number; rpId: string; signCount: number; label: string; createdAt: string }

/** Registration: the browser's decoded fields → a passkey to store, or the first check that failed. */
export function verifyRegistration(i: {
  clientDataJSON: string; authenticatorData: string; publicKey: string; alg: number; credentialId: string
  expectedChallenge: Uint8Array; expectedOrigin: string; rpId: string
}): { ok: true; passkey: Omit<StoredPasskey, 'label' | 'createdAt'> } | { ok: false; code: WebAuthnFail } {
  const cdj = b64urlDecode(i.clientDataJSON), ad = b64urlDecode(i.authenticatorData), pk = b64urlDecode(i.publicKey), id = b64urlDecode(i.credentialId)
  if (!cdj || !ad || !pk || !id || id.length === 0) return { ok: false, code: 'bad-input' }
  const cd = parseClientData(cdj)
  if (!cd) return { ok: false, code: 'bad-input' }
  if (cd.type !== 'webauthn.create') return { ok: false, code: 'client-type' }
  const ch = b64urlDecode(cd.challenge)
  if (!ch || !same(ch, i.expectedChallenge)) return { ok: false, code: 'challenge' }
  if (cd.origin !== i.expectedOrigin) return { ok: false, code: 'origin' }
  const a = parseAuthData(ad)
  if (!a) return { ok: false, code: 'bad-input' }
  if (!same(a.rpIdHash, sha256(i.rpId))) return { ok: false, code: 'rp-id' }
  if (!a.up) return { ok: false, code: 'no-presence' }
  if (!a.uv) return { ok: false, code: 'no-verification' }
  if (!a.credentialId || !same(a.credentialId, id)) return { ok: false, code: 'credential-id' }
  if (i.alg !== ES256 && i.alg !== RS256) return { ok: false, code: 'alg' }
  try {
    const k = createPublicKey({ key: Buffer.from(pk), format: 'der', type: 'spki' })
    if ((i.alg === ES256 && k.asymmetricKeyType !== 'ec') || (i.alg === RS256 && k.asymmetricKeyType !== 'rsa')) return { ok: false, code: 'key' }
  } catch { return { ok: false, code: 'key' } }
  return { ok: true, passkey: { credentialId: b64url(id), spki: b64url(pk), alg: i.alg, rpId: i.rpId, signCount: a.signCount } }
}

/** Assertion: refuses at the first failed check; on success the new signCount to store. */
export function verifyAssertion(i: {
  credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string
  expectedChallenge: Uint8Array; expectedOrigin: string; rpId: string; passkeys: readonly StoredPasskey[]
}): { ok: true; credentialId: string; signCount: number } | { ok: false; code: WebAuthnFail } {
  const pkRec = i.passkeys.find(p => p.credentialId === i.credentialId)
  if (!pkRec) return { ok: false, code: 'unknown-credential' }
  if (pkRec.rpId !== i.rpId) return { ok: false, code: 'rp-id' }
  const cdj = b64urlDecode(i.clientDataJSON), ad = b64urlDecode(i.authenticatorData), sig = b64urlDecode(i.signature)
  if (!cdj || !ad || !sig) return { ok: false, code: 'bad-input' }
  const cd = parseClientData(cdj)
  if (!cd) return { ok: false, code: 'bad-input' }
  if (cd.type !== 'webauthn.get') return { ok: false, code: 'client-type' }
  const ch = b64urlDecode(cd.challenge)
  if (!ch || !same(ch, i.expectedChallenge)) return { ok: false, code: 'challenge' }
  if (cd.origin !== i.expectedOrigin) return { ok: false, code: 'origin' }
  const a = parseAuthData(ad)
  if (!a) return { ok: false, code: 'bad-input' }
  if (!same(a.rpIdHash, sha256(i.rpId))) return { ok: false, code: 'rp-id' }
  if (!a.up) return { ok: false, code: 'no-presence' }
  if (!a.uv) return { ok: false, code: 'no-verification' }
  let ok = false
  try {
    const key = createPublicKey({ key: Buffer.from(b64urlDecode(pkRec.spki)!), format: 'der', type: 'spki' })
    const data = Buffer.concat([Buffer.from(ad), Buffer.from(sha256(cdj))])
    ok = pkRec.alg === ES256 ? verify('sha256', data, { key, dsaEncoding: 'der' }, Buffer.from(sig)) : verify('sha256', data, key, Buffer.from(sig))
  } catch { ok = false }
  if (!ok) return { ok: false, code: 'signature' }
  // A counter that does not move forward means a cloned authenticator — both 0 is "this one keeps none".
  if (!(a.signCount === 0 && pkRec.signCount === 0) && a.signCount <= pkRec.signCount) return { ok: false, code: 'counter' }
  return { ok: true, credentialId: pkRec.credentialId, signCount: a.signCount }
}

/** The origin a credential may answer: https on its rpId (any port), or http on localhost. */
export function originMatchesRp(origin: string, rpId: string): boolean {
  try {
    const u = new URL(origin)
    if (u.hostname !== rpId) return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && (rpId === 'localhost'))
  } catch { return false }
}
