/**
 * backup-recovery.ts — the backup private key wrapped under the 24 recovery words, so that losing
 * every device does not lose the backups. PURE apart from the nonce's randomness.
 *
 * The words are the same encoding as the vault's recovery key (`recovery.ts`: BIP-39 English,
 * 256 bits of entropy + checksum, NOT a wallet seed); generate them with `newRecoveryEntropy` +
 * `entropyToWords`. The entropy is full strength, so there is no slow KDF:
 *
 *   key  = HKDF-SHA256(ikm = entropy, no salt, info = "agentistics/bk/recovery/v1")
 *   wrap = AES-256-GCM(key, 12-byte random nonce, AAD = the same label, backup private key) ‖ tag
 *
 * The wrap is ciphertext and may be stored anywhere. The public key is DERIVED from the opened
 * private key, so a reader never has to trust a public key stored next to the wrap. The words are
 * never stored or logged, and no failure carries any part of the input.
 */
import { hkdfSync, randomBytes } from 'node:crypto'
import { KEY_BYTES, NONCE_BYTES, TAG_BYTES, b64, unb64 } from '../format'
import { ENTROPY_BYTES, wordsToEntropy } from '../recovery-words'
import { aeadOpen, aeadSeal } from '../seal'
import { backupPublicKeyOf } from './backup-key'

export const BACKUP_RECOVERY_LABEL = 'agentistics/bk/recovery/v1'
const RECOVERY_WRAP_VERSION = 1

export interface RecoveryWrap { v: 1; nonce: string; ct: string }

export type RecoveryOpenFailure = 'word-count' | 'unknown-word' | 'checksum' | 'wrong-words' | 'malformed'
export type RecoveryOpenOutcome =
  | { ok: true; privateKey: Uint8Array; publicKey: Uint8Array }
  | { ok: false; code: RecoveryOpenFailure }

const AAD = new TextEncoder().encode(BACKUP_RECOVERY_LABEL)

function recoveryKey(entropy: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', entropy, new Uint8Array(0), BACKUP_RECOVERY_LABEL, KEY_BYTES))
}

/** Wrap the backup private key under the words' entropy. `fixed` is for the compatibility vectors only. */
export function makeRecoveryWrap(backupPrivateKey: Uint8Array, entropy: Uint8Array, fixed?: { nonce: Uint8Array }): RecoveryWrap {
  if (backupPrivateKey.length !== KEY_BYTES) throw new Error('vault: private key has the wrong length')
  if (entropy.length !== ENTROPY_BYTES) throw new Error('vault: recovery entropy has the wrong length')
  const nonce = fixed?.nonce ?? new Uint8Array(randomBytes(NONCE_BYTES))
  if (nonce.length !== NONCE_BYTES) throw new Error('vault: nonce has the wrong length')
  const key = recoveryKey(entropy)
  try { return { v: RECOVERY_WRAP_VERSION, nonce: b64(nonce), ct: b64(aeadSeal(key, nonce, AAD, backupPrivateKey)) } }
  finally { key.fill(0) }
}

/**
 * Open the wrap with the typed words. `wrong-words` covers both words that are valid but not these
 * and a modified wrap: the cipher cannot tell them apart. The caller zeroes the private key.
 */
export function openRecoveryWrap(wrap: unknown, words: string | readonly string[]): RecoveryOpenOutcome {
  const w = (wrap && typeof wrap === 'object' ? wrap : {}) as Record<string, unknown>
  const nonce = unb64(w.nonce)
  const ct = unb64(w.ct)
  if (w.v !== RECOVERY_WRAP_VERSION || nonce?.length !== NONCE_BYTES || ct?.length !== KEY_BYTES + TAG_BYTES) {
    return { ok: false, code: 'malformed' }
  }
  const parsed = wordsToEntropy(words)
  if (!parsed.ok) return { ok: false, code: parsed.reason === 'count' ? 'word-count' : parsed.reason }
  const key = recoveryKey(parsed.entropy)
  try {
    const privateKey = aeadOpen(key, nonce, AAD, ct)
    return privateKey
      ? { ok: true, privateKey, publicKey: backupPublicKeyOf(privateKey) }
      : { ok: false, code: 'wrong-words' }
  } finally { key.fill(0); parsed.entropy.fill(0) }
}
