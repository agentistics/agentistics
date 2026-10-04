/**
 * phone-wrap.ts — a copy of the data key that ONLY a registered phone can open (VAULT.PERSONAL §10).
 * PURE apart from the randomness of salts and nonces.
 *
 * Why it exists: once presence is enrolled, every silent wrapper is retired (SECRETS.4 §7.3), so a
 * locked vault opens with Windows Hello / a security key / the 24 words — none of which a phone across
 * the room can give. A phone therefore needs a wrapper of its own, and the secret behind it must live
 * ON THE PHONE, never on the computer (a secret kept beside the wrapper would be a silent wrapper again):
 *
 *  - `passkey`: the WebAuthn PRF extension. The phone's authenticator turns a per-wrapper salt into 32
 *    bytes ONLY after the person's biometrics (`userVerification: required`); those bytes are the KEK.
 *  - `device`: 32 random bytes minted at approval and handed to the phone's browser, kept nowhere on
 *    the computer. Exists only while the owner's "code alone from the phone" switch is on.
 *
 * Either way the authenticator code is still checked after the unwrap (the service does that with the
 * key this returns), so a captured phone secret alone opens nothing, and a stolen code alone neither.
 *
 * KEK = HKDF-SHA256(ikm = phone secret, salt = wrapper salt, info = label ‖ kind ‖ id). The AAD binds
 * kind, id and the vault's kid, so a wrapper moved onto another entry, or kept past a key rotation,
 * fails its tag instead of opening.
 */
import { hkdfSync, randomBytes } from 'node:crypto'
import { aeadOpen, aeadSeal } from './seal'
import { KEY_BYTES, NONCE_BYTES } from './format'

export type PhoneKeyKind = 'passkey' | 'device'
export const PHONE_SECRET_BYTES = 32
const LABEL = 'agentistics/vault/phone-wrap/v1'

export interface PhoneWrap {
  id: string
  kind: PhoneKeyKind
  /** The vault key id this copy belongs to. A rotation leaves it stale (the phone must be re-approved). */
  kid: string
  /** base64url, 32 bytes. For a passkey this is also the PRF evaluation input the phone is asked for. */
  salt: string
  nonce: string
  ct: string
  createdAt: string
  /** A passkey's PUBLIC half, so an assertion can be verified while the vault is still locked. */
  passkey?: { spki: string; alg: number; rpId: string; signCount: number }
}

const u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const d = (s: string): Uint8Array | null => { try { const b = Buffer.from(s, 'base64url'); return b.length ? new Uint8Array(b) : null } catch { return null } }

function kek(secret: Uint8Array, salt: Uint8Array, kind: PhoneKeyKind, id: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, salt, `${LABEL}/${kind}/${id}`, KEY_BYTES))
}
function aad(kind: PhoneKeyKind, id: string, kid: string): Uint8Array {
  return new TextEncoder().encode(`${LABEL}\0${kind}\0${id}\0${kid}`)
}

/** A fresh salt (the PRF input for a passkey). */
export function newPhoneSalt(): string { return u(new Uint8Array(randomBytes(32))) }
/** A fresh device secret — handed to the phone once, never stored on the computer. */
export function newDeviceSecret(): Uint8Array { return new Uint8Array(randomBytes(PHONE_SECRET_BYTES)) }

/** Seal the data key under a phone secret. Refuses a secret that is not exactly 32 bytes. */
export function wrapForPhone(i: {
  dek: Uint8Array; kid: string; kind: PhoneKeyKind; id: string; secret: Uint8Array; salt: string; createdAt: string
  passkey?: PhoneWrap['passkey']
}): PhoneWrap {
  if (i.secret.length !== PHONE_SECRET_BYTES) throw new Error('vault: phone secret has the wrong length')
  const salt = d(i.salt)
  if (!salt || salt.length !== 32) throw new Error('vault: phone salt has the wrong length')
  const key = kek(i.secret, salt, i.kind, i.id)
  const nonce = new Uint8Array(randomBytes(NONCE_BYTES))
  try {
    const ct = aeadSeal(key, nonce, aad(i.kind, i.id, i.kid), i.dek)
    return { id: i.id, kind: i.kind, kid: i.kid, salt: i.salt, nonce: u(nonce), ct: u(ct), createdAt: i.createdAt, ...(i.passkey ? { passkey: i.passkey } : {}) }
  } finally { key.fill(0) }
}

/** The data key, or `null` on ANY failure (wrong secret, moved wrapper, rotated key, junk). */
export function unwrapForPhone(w: PhoneWrap, secret: Uint8Array, kid: string): Uint8Array | null {
  if (secret.length !== PHONE_SECRET_BYTES || w.kid !== kid) return null
  const salt = d(w.salt), nonce = d(w.nonce), ct = d(w.ct)
  if (!salt || salt.length !== 32 || !nonce || nonce.length !== NONCE_BYTES || !ct) return null
  const key = kek(secret, salt, w.kind, w.id)
  try {
    const dek = aeadOpen(key, nonce, aad(w.kind, w.id, kid), ct)
    if (dek && dek.length !== KEY_BYTES) { dek.fill(0); return null }
    return dek
  } finally { key.fill(0) }
}

/** PURE. Is this a well-formed wrapper record (as read from disk)? Anything else is ignored. */
export function isPhoneWrap(x: unknown): x is PhoneWrap {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  const s = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 4096
  if (!s(o.id) || !s(o.kid) || !s(o.salt) || !s(o.nonce) || !s(o.ct) || !s(o.createdAt)) return false
  if (o.kind !== 'passkey' && o.kind !== 'device') return false
  if (o.kind === 'passkey') {
    const p = o.passkey as Record<string, unknown> | undefined
    if (!p || !s(p.spki) || !s(p.rpId) || typeof p.alg !== 'number' || typeof p.signCount !== 'number') return false
  }
  return true
}
