/**
 * backup-key.ts — the backup key (an X25519 pair) and the wrapping of an object's DEK to it. PURE
 * apart from randomness.
 *
 * A device that writes a backup needs only the backup PUBLIC key. It wraps each object's DEK so that
 * only the backup private key opens it, and so that the reader can tell WHICH device made the wrap:
 *
 *   E        = fresh X25519 pair, one per wrap
 *   header   = "agentistics/backup/dek-wrap/v1" ‖ sender.pub ‖ E.pub ‖ backup.pub   (raw 32-byte keys)
 *   key      = HKDF-SHA256(ikm = X25519(E, backup) ‖ X25519(sender, backup),
 *                          salt = E.pub ‖ backup.pub, info = header)
 *   ct       = AES-256-GCM(key, 12-byte random nonce, AAD = header, DEK) ‖ tag
 *
 * The second Diffie-Hellman authenticates the sender, but only against a key the reader already
 * trusts: the sender public key travels in the wrap, so `unwrapFromBackupKey` refuses any sender not
 * in the caller's PINNED list, before doing any key agreement. Without that, whoever stores the wraps
 * could plant a DEK of their own choosing. (Whoever holds the backup private key can forge a wrap for
 * any sender — they can already read everything.)
 */
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto'
import { KEY_BYTES, NONCE_BYTES, TAG_BYTES, b64, unb64 } from '../format'
import { aeadOpen, aeadSeal } from '../seal'

export const DEK_WRAP_LABEL = 'agentistics/backup/dek-wrap/v1'
const DEK_WRAP_VERSION = 1
const X25519_BYTES = 32
// The fixed DER headers around a raw X25519 key (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

/** Raw 32-byte X25519 keys. The private half is a secret: seal it at rest, zero it after use. */
export interface BackupKeypair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

/** The wire form of a wrapped DEK (base64 fields). */
export interface DekWrap {
  v: 1
  senderPublicKey: string
  ephemeralPublicKey: string
  nonce: string
  ct: string
}

export type DekUnwrapFailure = 'malformed' | 'unknown-sender' | 'unwrap-failed'
export type DekUnwrapOutcome =
  | { ok: true; dek: Uint8Array; senderPublicKey: Uint8Array }
  | { ok: false; code: DekUnwrapFailure }

function privateKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== X25519_BYTES) throw new Error('vault: private key has the wrong length')
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

function publicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== X25519_BYTES) throw new Error('vault: public key has the wrong length')
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

const rawTail = (der: Buffer) => new Uint8Array(der.subarray(der.length - X25519_BYTES))

/** PURE. The public half of a raw private key. */
export function backupPublicKeyOf(privateKey: Uint8Array): Uint8Array {
  return rawTail(createPublicKey(privateKeyObject(privateKey)).export({ type: 'spki', format: 'der' }) as Buffer)
}

/** A fresh X25519 pair — used for the backup key, and for a device's sender key. */
export function newBackupKeypair(): BackupKeypair {
  const { privateKey } = generateKeyPairSync('x25519')
  const raw = rawTail(privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer)
  return { publicKey: backupPublicKeyOf(raw), privateKey: raw }
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b))

function headerOf(sender: Uint8Array, ephemeral: Uint8Array, recipient: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(DEK_WRAP_LABEL), sender, ephemeral, recipient]))
}

/** key = HKDF(dh1 ‖ dh2). Both shared secrets and the concatenation are zeroed. */
function wrapKey(dh1: Buffer, dh2: Buffer, ephemeral: Uint8Array, recipient: Uint8Array, header: Uint8Array): Uint8Array {
  const ikm = Buffer.concat([dh1, dh2])
  try { return new Uint8Array(hkdfSync('sha256', ikm, Buffer.concat([ephemeral, recipient]), header, KEY_BYTES)) }
  finally { ikm.fill(0); dh1.fill(0); dh2.fill(0) }
}

/**
 * Wrap an object's DEK to the backup public key, as this sender.
 * `fixed` exists for the compatibility vectors only: never pass it otherwise.
 */
export function wrapForBackupKey(
  dek: Uint8Array, sender: BackupKeypair, backupPublicKey: Uint8Array,
  fixed?: { ephemeralPrivateKey: Uint8Array; nonce: Uint8Array },
): DekWrap {
  if (dek.length !== KEY_BYTES) throw new Error('vault: data key has the wrong length')
  if (!same(backupPublicKeyOf(sender.privateKey), sender.publicKey)) throw new Error('vault: sender key halves do not match')
  const recipient = publicKeyObject(backupPublicKey)
  const ephemeralPrivate = fixed?.ephemeralPrivateKey ?? newBackupKeypair().privateKey
  const nonce = fixed?.nonce ?? new Uint8Array(randomBytes(NONCE_BYTES))
  if (nonce.length !== NONCE_BYTES) throw new Error('vault: nonce has the wrong length')
  const ephemeralPublic = backupPublicKeyOf(ephemeralPrivate)
  const header = headerOf(sender.publicKey, ephemeralPublic, backupPublicKey)
  const key = wrapKey(
    diffieHellman({ privateKey: privateKeyObject(ephemeralPrivate), publicKey: recipient }),
    diffieHellman({ privateKey: privateKeyObject(sender.privateKey), publicKey: recipient }),
    ephemeralPublic, backupPublicKey, header,
  )
  try {
    return {
      v: DEK_WRAP_VERSION,
      senderPublicKey: b64(sender.publicKey),
      ephemeralPublicKey: b64(ephemeralPublic),
      nonce: b64(nonce),
      ct: b64(aeadSeal(key, nonce, header, dek)),
    }
  } finally {
    key.fill(0)
    if (!fixed) ephemeralPrivate.fill(0)
  }
}

/**
 * Open a wrapped DEK with the backup private key. `pinnedSenders` are the device public keys the
 * caller trusts, obtained from somewhere other than whatever served the wrap. An empty list refuses.
 */
export function unwrapFromBackupKey(
  wrap: unknown, backupPrivateKey: Uint8Array, pinnedSenders: readonly Uint8Array[],
): DekUnwrapOutcome {
  const w = (wrap && typeof wrap === 'object' ? wrap : {}) as Record<string, unknown>
  const sender = unb64(w.senderPublicKey)
  const ephemeral = unb64(w.ephemeralPublicKey)
  const nonce = unb64(w.nonce)
  const ct = unb64(w.ct)
  if (w.v !== DEK_WRAP_VERSION || sender?.length !== X25519_BYTES || ephemeral?.length !== X25519_BYTES
    || nonce?.length !== NONCE_BYTES || ct?.length !== KEY_BYTES + TAG_BYTES) return { ok: false, code: 'malformed' }
  if (!pinnedSenders.some(p => same(p, sender))) return { ok: false, code: 'unknown-sender' }
  try {
    const recipientPrivate = privateKeyObject(backupPrivateKey)
    const recipientPublic = backupPublicKeyOf(backupPrivateKey)
    const header = headerOf(sender, ephemeral, recipientPublic)
    const key = wrapKey(
      diffieHellman({ privateKey: recipientPrivate, publicKey: publicKeyObject(ephemeral) }),
      diffieHellman({ privateKey: recipientPrivate, publicKey: publicKeyObject(sender) }),
      ephemeral, recipientPublic, header,
    )
    try {
      const dek = aeadOpen(key, nonce, header, ct)
      return dek ? { ok: true, dek, senderPublicKey: sender } : { ok: false, code: 'unwrap-failed' }
    } finally { key.fill(0) }
  } catch {
    // A low-order point or unusable key material: the same "no" as a failed tag.
    return { ok: false, code: 'unwrap-failed' }
  }
}
