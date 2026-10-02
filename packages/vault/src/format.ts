/**
 * format.ts — the sealed file, the AAD, and the per-purpose subkey. PURE.
 *
 * One JSON object per `.sealed` file:
 *
 *   { "agentistics-sealed": 1, "alg": "A256GCM", "kid", "purpose", "name",
 *     "nonce": "<base64, 12 bytes>", "ct": "<base64 ciphertext‖tag>", "sealedAt": "<ISO>" }
 *
 * Nothing in it is derived from the secret — no last four characters, no fingerprint, no length
 * beyond what the ciphertext itself has to carry. `purpose` and `name` are written in clear only so
 * a reader can say WHICH file it is looking at; the opener never trusts them, it binds the values it
 * EXPECTS into the AAD, so a file renamed onto another file fails its tag.
 *
 * See docs/security.md § "Secrets at rest".
 */
export const SEALED_VERSION = 1
export const SEALED_ALG = 'A256GCM'
export const NONCE_BYTES = 12
export const TAG_BYTES = 16
export const KEY_BYTES = 32
/** The AAD's own domain label. A blob of this format can never be confused with any other GCM use. */
export const AAD_LABEL = 'agentistics-sealed/v1'
/** HKDF `info` prefix — the purpose is appended. */
export const HKDF_INFO_PREFIX = 'agentistics/vault/v1/'

/**
 * Closed set of the HOST's purposes. An engine's purposes are namespaced `engine/…` and the host
 * refuses any other string from it, so an engine can never ask for the GitHub token's subkey.
 */
export type HostPurpose =
  | 'github-backup'
  | 'central-token'
  | 'envelope-key'
  | 'central-env'
export type EnginePurpose = `engine/${string}`
export type Purpose = HostPurpose | EnginePurpose

export const HOST_PURPOSES: readonly HostPurpose[] = ['github-backup', 'central-token', 'envelope-key', 'central-env']

/** PURE. Is `p` a purpose this format accepts at all? */
export function isPurpose(p: unknown): p is Purpose {
  if (typeof p !== 'string') return false
  if ((HOST_PURPOSES as readonly string[]).includes(p)) return true
  return isEnginePurpose(p)
}

/** PURE. `engine/` plus a non-empty, path-free remainder. */
export function isEnginePurpose(p: unknown): p is EnginePurpose {
  return typeof p === 'string' && /^engine\/[a-z0-9][a-z0-9._-]{0,63}$/.test(p)
}

export interface SealedFile {
  'agentistics-sealed': typeof SEALED_VERSION
  alg: typeof SEALED_ALG
  kid: string
  purpose: string
  name: string
  nonce: string
  ct: string
  sealedAt: string
}

/** A kid is 16 lowercase hex characters. */
export function isKid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{16}$/.test(v)
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, false)
  return b
}

function field(s: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(s)
  return [u32(bytes.length), bytes]
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/**
 * PURE. The AAD: `label ‖ len(purpose) ‖ purpose ‖ len(name) ‖ name ‖ len(kid) ‖ kid`, every
 * length a 4-byte big-endian count of UTF-8 bytes. Length-prefixing every field (the label too) is
 * what makes the encoding injective: no two distinct `(purpose, name, kid)` tuples serialise to the
 * same bytes, whatever separator characters the strings contain.
 */
export function sealedAad(purpose: string, name: string, kid: string): Uint8Array {
  return concat([...field(AAD_LABEL), ...field(purpose), ...field(name), ...field(kid)])
}

/** Base64 helpers that never throw on the decode side: junk yields `null`. */
export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
export function unb64(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null
  return new Uint8Array(Buffer.from(s, 'base64'))
}

/**
 * PURE. Parse a sealed file's bytes. `null` for anything that is not exactly this format — a
 * truncated file, a different version, a missing field. The caller reports `tampered`: a file that
 * does not even parse is not one this machine wrote.
 */
export function parseSealed(text: string): SealedFile | null {
  let v: unknown
  try { v = JSON.parse(text) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o['agentistics-sealed'] !== SEALED_VERSION || o.alg !== SEALED_ALG) return null
  if (!isKid(o.kid) || typeof o.purpose !== 'string' || typeof o.name !== 'string') return null
  if (typeof o.nonce !== 'string' || typeof o.ct !== 'string' || typeof o.sealedAt !== 'string') return null
  const nonce = unb64(o.nonce)
  const ct = unb64(o.ct)
  if (!nonce || nonce.length !== NONCE_BYTES || !ct || ct.length < TAG_BYTES) return null
  return {
    'agentistics-sealed': SEALED_VERSION, alg: SEALED_ALG, kid: o.kid, purpose: o.purpose,
    name: o.name, nonce: o.nonce, ct: o.ct, sealedAt: o.sealedAt,
  }
}

export function serializeSealed(f: SealedFile): string {
  return JSON.stringify(f, null, 2) + '\n'
}

/** Constant-time byte comparison (lengths are compared first; a length is not a secret here). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!
  return d === 0
}
