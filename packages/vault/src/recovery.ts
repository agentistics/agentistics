/**
 * recovery.ts — the 24-word recovery key (SECRETS.4 §4). PURE apart from randomness.
 *
 *  - 24 words = 256 bits of entropy + an 8-bit checksum (the first byte of SHA-256(entropy)), spelled
 *    in the vendored BIP-39 English list. A typo is caught by the checksum and by the list itself;
 *    the first 4 letters of every word are unique, so a prefix is enough to type.
 *  - It is a KEY, not a seed: `KEK = HKDF-SHA256(ikm = entropy, salt = kid, info =
 *    "agentistics/vault/v2/recovery")` — no slow KDF (the entropy is full-strength) and NO BIP-39
 *    PBKDF2("mnemonic"), so the words can never be mistaken for, or imported as, a wallet phrase.
 *  - `dek.recovery` = AES-256-GCM(KEK, DEK), AAD `"agentistics-vault/v2/recovery" ‖ kid`.
 *
 * The words are never stored, logged or audited; every buffer holding the entropy or a KEK is zeroed
 * by the code that made it. A word list is a JS string array and cannot be zeroed — the CALLER drops
 * it as soon as it has turned it into entropy (stated in docs/security.md as best-effort).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { Lang } from './sentences'
import { bytes, text, type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult, type WrapperRecord } from './protectors/types'

export const RECOVERY_FILE = 'dek.recovery'
export { RECOVERY_WORDS, ENTROPY_BYTES, newRecoveryEntropy, entropyToWords, resolveWord, wordsToEntropy, confirmPositions, confirmWords, type WordsResult } from './recovery-words'
import { ENTROPY_BYTES } from './recovery-words'

function kekOf(entropy: Uint8Array, kid: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', entropy, bytes(kid), 'agentistics/vault/v2/recovery', 32))
}
const aadOf = (kid: string) => bytes(`agentistics-vault/v2/recovery${kid}`)

interface RecoveryFile { v: 1; nonce: string; ct: string }

/**
 * The recovery WRAPPER as a `Protector`. Built with the entropy when one is in hand (enrolment,
 * `recover`); without it, `unwrap` is `unavailable` — the words are not something a service start can
 * ask for. The probe is a pure round trip (no device involved).
 */
export function recoveryProtector(o: { io: ProtectorIo; vaultDir: string; entropy?: Uint8Array; file?: string }): Protector {
  const file = `${o.vaultDir}/${o.file ?? RECOVERY_FILE}`
  return {
    id: 'recovery',
    label: (lang: Lang) => lang === 'pt' ? 'a chave de recuperação de 24 palavras' : 'the 24-word recovery key',
    async probe(): Promise<ProbeResult> { return o.entropy?.length === ENTROPY_BYTES ? { ok: true } : { ok: false, reason: 'no recovery key in hand' } },
    async wrap(dek: Uint8Array, kid: string) {
      if (o.entropy?.length !== ENTROPY_BYTES) return { ok: false as const, reason: 'no recovery key in hand' }
      const kek = kekOf(o.entropy, kid)
      try {
        const nonce = randomBytes(12)
        const c = createCipheriv('aes-256-gcm', kek, nonce, { authTagLength: 16 })
        c.setAAD(aadOf(kid))
        const ct = Buffer.concat([c.update(dek), c.final(), c.getAuthTag()])
        const f: RecoveryFile = { v: 1, nonce: nonce.toString('base64'), ct: ct.toString('base64') }
        await o.io.writeFile(file, bytes(JSON.stringify(f) + '\n'))
        return { ok: true as const, record: { type: 'recovery' as const, createdAt: new Date().toISOString(), params: { file: RECOVERY_FILE } } }
      } finally { kek.fill(0) }
    },
    async unwrap(_r: WrapperRecord, kid: string): Promise<UnwrapResult> {
      if (o.entropy?.length !== ENTROPY_BYTES) return { ok: false, kind: 'unavailable', reason: 'the recovery key is typed only by `agentop vault recover`' }
      const raw = await o.io.readFile(file)
      if (!raw) return { ok: false, kind: 'missing', reason: `${RECOVERY_FILE} is missing` }
      let f: RecoveryFile
      try { f = JSON.parse(text(raw)) as RecoveryFile; if (f.v !== 1) throw new Error('v') } catch { return { ok: false, kind: 'missing', reason: `${RECOVERY_FILE} is damaged` } }
      const kek = kekOf(o.entropy, kid)
      let a: Buffer | null = null
      try {
        const ct = Buffer.from(f.ct, 'base64')
        const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(f.nonce, 'base64'), { authTagLength: 16 })
        d.setAAD(aadOf(kid))
        d.setAuthTag(ct.subarray(ct.length - 16))
        a = d.update(ct.subarray(0, ct.length - 16))
        const b = d.final()
        const dek = new Uint8Array(a.length + b.length)
        dek.set(a, 0); dek.set(b, a.length)
        return { ok: true, dek }
      } catch {
        // Words that pass the checksum but are not THIS vault's: denied, never more detail.
        return { ok: false, kind: 'denied', reason: 'those words do not open this vault' }
      } finally { kek.fill(0); a?.fill(0) }
    },
    async remove() { await o.io.removeFile(file).catch(() => {}) },
  }
}

/**
 * Review S6: write a NEW recovery wrapper without ever leaving the vault with none. The wrapper goes to
 * a STAGING file, is read back from disk and must open this very DEK, and only then replaces
 * `dek.recovery` (an atomic write of the verified bytes); the staging file is removed on every path.
 * A failure anywhere leaves the old wrapper — and so the old words — exactly as they were.
 */
export async function writeRecoveryVerified(
  io: ProtectorIo, vaultDir: string, dek: Uint8Array, kid: string, entropy: Uint8Array,
): Promise<{ ok: true; record: WrapperRecord } | { ok: false; reason: string }> {
  const STAGING = `${RECOVERY_FILE}.new`
  const staged = recoveryProtector({ io, vaultDir, entropy, file: STAGING })
  try {
    const w = await staged.wrap(dek, kid)
    if (!w.ok) return { ok: false, reason: w.reason }
    const back = await staged.unwrap(w.record, kid)
    const same = back.ok && back.dek.length === dek.length && back.dek.every((b, i) => b === dek[i])
    if (back.ok) back.dek.fill(0)
    if (!same) return { ok: false, reason: 'the new recovery key did not read back from disk' }
    const bytesOnDisk = await io.readFile(`${vaultDir}/${STAGING}`)
    if (!bytesOnDisk) return { ok: false, reason: 'the new recovery key vanished before it could be kept' }
    await io.writeFile(`${vaultDir}/${RECOVERY_FILE}`, bytesOnDisk)
    return { ok: true, record: { type: 'recovery', createdAt: new Date().toISOString(), params: { file: RECOVERY_FILE } } }
  } finally {
    await io.removeFile(`${vaultDir}/${STAGING}`).catch(() => {})
  }
}
