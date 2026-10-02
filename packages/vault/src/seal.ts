/**
 * seal.ts — HKDF subkeys and AES-256-GCM seal/open. PURE apart from the nonce's randomness.
 *
 * The DEK itself never seals anything: every purpose gets its own subkey,
 * `HKDF-SHA256(ikm = DEK, salt = kid, info = "agentistics/vault/v1/" + purpose)`, so a blob sealed
 * for one purpose cannot be opened as another even before the AAD is checked. That matters because
 * the host serves seal/open to an engine (engine-api 1.5 `secrets`), restricted to `engine/…`.
 *
 * Nothing here logs, and no error raised here carries plaintext or key material: a failed open is a
 * CODE (`tampered` / `wrong-machine`), never a message built from the input.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import {
  HKDF_INFO_PREFIX, KEY_BYTES, NONCE_BYTES, SEALED_ALG, SEALED_VERSION, TAG_BYTES,
  b64, parseSealed, scopeOfPurpose, sealedAad, serializeSealed, unb64, type SealedFile, type VaultScope,
} from './format'

/** PURE. The per-purpose subkey. */
export function subkey(dek: Uint8Array, kid: string, purpose: string): Uint8Array {
  if (dek.length !== KEY_BYTES) throw new Error('vault: data key has the wrong length')
  return new Uint8Array(hkdfSync('sha256', dek, new TextEncoder().encode(kid), HKDF_INFO_PREFIX + purpose, KEY_BYTES))
}

/** Raw AES-256-GCM with an explicit AAD. Returns `ciphertext ‖ tag`. */
export function aeadSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  c.setAAD(aad)
  const body = Buffer.concat([c.update(plaintext), c.final()])
  return new Uint8Array(Buffer.concat([body, c.getAuthTag()]))
}

/** Raw AES-256-GCM open. `null` on ANY failure — the reason is never more specific than "no". */
export function aeadOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < TAG_BYTES) return null
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
    d.setAAD(aad)
    d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
    return new Uint8Array(Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_BYTES)), d.final()]))
  } catch {
    return null
  }
}

export interface SealInput {
  dek: Uint8Array
  kid: string
  /** The scope of the vault whose DEK this is — from the vault HANDLE, never from a caller. */
  scope?: VaultScope
  purpose: string
  name: string
  plaintext: Uint8Array
  /** Injected for tests; defaults to `randomBytes(12)`. */
  nonce?: Uint8Array
  now?: Date
}

/** Seal one value into the on-disk record. */
export function sealRecord(i: SealInput): SealedFile {
  // A purpose of the OTHER scope is refused before any crypto (SECRETS.4 §1.1).
  if (scopeOfPurpose(i.purpose) !== (i.scope ?? 'human')) throw new Error(`vault: purpose "${i.purpose}" is not sealed under the ${i.scope ?? 'human'} scope`)
  const nonce = i.nonce ?? new Uint8Array(randomBytes(NONCE_BYTES))
  if (nonce.length !== NONCE_BYTES) throw new Error('vault: nonce has the wrong length')
  const ct = aeadSeal(subkey(i.dek, i.kid, i.purpose), nonce, sealedAad(i.purpose, i.name, i.kid), i.plaintext)
  return {
    'agentistics-sealed': SEALED_VERSION, alg: SEALED_ALG, kid: i.kid, purpose: i.purpose, name: i.name,
    nonce: b64(nonce), ct: b64(ct), sealedAt: (i.now ?? new Date()).toISOString(),
  }
}

/** Seal straight to the file's bytes. */
export function sealToBytes(i: SealInput): Uint8Array {
  return new TextEncoder().encode(serializeSealed(sealRecord(i)))
}

export type OpenFailure = 'tampered' | 'wrong-machine' | 'purpose'
export type OpenOutcome = { ok: true; plaintext: Uint8Array } | { ok: false; code: OpenFailure; kid?: string }

export interface OpenInput {
  dek: Uint8Array
  /** The scope of the OPEN vault — from the vault handle. A purpose of the other scope is `purpose`. */
  scope?: VaultScope
  /** The OPEN vault's kid. */
  kid: string
  /** What the caller expects this file to be — bound into the AAD, never read from the file. */
  purpose: string
  name: string
  bytes: Uint8Array | string
}

/**
 * Open a sealed file. The order of the checks is what keeps the two refusals honest:
 *  1. it does not parse as this format            → `tampered`
 *  2. it carries another vault's kid               → `wrong-machine` (copied, not modified)
 *  3. its header names another purpose or name     → `tampered` (moved onto the wrong file)
 *  4. the tag does not verify under the EXPECTED   → `tampered`
 *     purpose, name and kid
 */
export function openRecord(i: OpenInput): OpenOutcome {
  if (scopeOfPurpose(i.purpose) !== (i.scope ?? 'human')) return { ok: false, code: 'purpose' }
  const text = typeof i.bytes === 'string' ? i.bytes : new TextDecoder('utf-8', { fatal: false }).decode(i.bytes)
  const f = parseSealed(text)
  if (!f) return { ok: false, code: 'tampered' }
  if (f.kid !== i.kid) return { ok: false, code: 'wrong-machine', kid: f.kid }
  if (f.purpose !== i.purpose || f.name !== i.name) return { ok: false, code: 'tampered' }
  const nonce = unb64(f.nonce)
  const ct = unb64(f.ct)
  if (!nonce || !ct) return { ok: false, code: 'tampered' }
  const pt = aeadOpen(subkey(i.dek, i.kid, i.purpose), nonce, sealedAad(i.purpose, i.name, i.kid), ct)
  return pt ? { ok: true, plaintext: pt } : { ok: false, code: 'tampered' }
}

/** A fresh data key and key id. */
export function newDataKey(): { dek: Uint8Array; kid: string } {
  return { dek: new Uint8Array(randomBytes(KEY_BYTES)), kid: randomBytes(8).toString('hex') }
}
