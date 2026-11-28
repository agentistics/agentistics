/**
 * backup-sender-cert.ts — how a reader that lost every device learns which sender keys to pin. PURE.
 *
 * `unwrapFromBackupKey` refuses any sender the caller does not already trust. A new machine that has
 * only the recovery words has no pins of its own, and taking them from whoever stores the backups
 * would defeat the check. So each device certifies its OWN sender public key at setup, while it holds
 * the backup private key, and the certificate is stored beside the backups:
 *
 *   key  = HKDF-SHA256(ikm = backup private key, no salt, info = "agentistics/bk/sender-cert/v1")
 *   cert = HMAC-SHA256(key, "agentistics/bk/sender-cert/v1" ‖ sender.pub ‖ backup.pub)
 *
 * After opening the words, the reader checks the stored certificates and pins what verifies. The
 * store cannot forge one: that needs the backup private key, which it never has.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { KEY_BYTES, b64, unb64 } from '../format'
import { backupPublicKeyOf } from './backup-key'

export const SENDER_CERT_LABEL = 'agentistics/bk/sender-cert/v1'
const SENDER_CERT_VERSION = 1
const X25519_BYTES = 32
const MAC_BYTES = 32

/** The wire form (base64 fields). */
export interface SenderCert { v: 1; senderPublicKey: string; cert: string }

function certKey(backupPrivateKey: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', backupPrivateKey, new Uint8Array(0), SENDER_CERT_LABEL, KEY_BYTES))
}

function macOf(key: Uint8Array, sender: Uint8Array, backupPublicKey: Uint8Array): Buffer {
  return createHmac('sha256', key).update(SENDER_CERT_LABEL).update(sender).update(backupPublicKey).digest()
}

/** Certify a sender public key. Throws on wrong-sized keys. */
export function makeSenderCert(backupPrivateKey: Uint8Array, senderPublicKey: Uint8Array): SenderCert {
  if (senderPublicKey.length !== X25519_BYTES) throw new Error('vault: public key has the wrong length')
  const backupPublicKey = backupPublicKeyOf(backupPrivateKey)
  const key = certKey(backupPrivateKey)
  try {
    return { v: SENDER_CERT_VERSION, senderPublicKey: b64(senderPublicKey), cert: b64(macOf(key, senderPublicKey, backupPublicKey)) }
  } finally { key.fill(0) }
}

/**
 * The sender public keys whose certificate verifies under this backup key, ready to pass as
 * `pinnedSenders`. `certs` is untrusted: malformed or invalid entries are dropped, never thrown.
 */
export function verifySenderCerts(certs: readonly unknown[], backupPrivateKey: Uint8Array): Uint8Array[] {
  const backupPublicKey = backupPublicKeyOf(backupPrivateKey)
  const key = certKey(backupPrivateKey)
  const out: Uint8Array[] = []
  try {
    for (const entry of Array.isArray(certs) ? certs : []) {
      const c = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      const sender = unb64(c.senderPublicKey)
      const mac = unb64(c.cert)
      if (c.v !== SENDER_CERT_VERSION || sender?.length !== X25519_BYTES || mac?.length !== MAC_BYTES) continue
      if (timingSafeEqual(mac, macOf(key, sender, backupPublicKey))) out.push(sender)
    }
  } finally { key.fill(0) }
  return out
}
