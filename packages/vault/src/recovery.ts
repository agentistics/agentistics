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
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomInt } from 'node:crypto'
import { BIP39_ENGLISH } from './bip39-english'
import type { Lang } from './sentences'
import { bytes, text, type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult, type WrapperRecord } from './protectors/types'

export const RECOVERY_FILE = 'dek.recovery'
export const RECOVERY_WORDS = 24
export const ENTROPY_BYTES = 32

const INDEX = new Map(BIP39_ENGLISH.map((w, i) => [w, i]))
const BY_PREFIX = new Map(BIP39_ENGLISH.map((w, i) => [w.slice(0, 4), i]))

/** A fresh 256-bit recovery entropy. The caller zeroes it. */
export function newRecoveryEntropy(): Uint8Array {
  return new Uint8Array(randomBytes(ENTROPY_BYTES))
}

/** PURE. 32 bytes → 24 words (BIP-39 bit layout: entropy ‖ first 8 bits of SHA-256, 11 bits a word). */
export function entropyToWords(entropy: Uint8Array): string[] {
  if (entropy.length !== ENTROPY_BYTES) throw new Error('recovery: entropy must be 32 bytes')
  const check = createHash('sha256').update(entropy).digest()[0]!
  const all = new Uint8Array(ENTROPY_BYTES + 1)
  all.set(entropy, 0); all[ENTROPY_BYTES] = check
  const words: string[] = []
  for (let i = 0; i < RECOVERY_WORDS; i++) {
    let v = 0
    for (let b = 0; b < 11; b++) {
      const bit = i * 11 + b
      v = (v << 1) | ((all[bit >> 3]! >> (7 - (bit & 7))) & 1)
    }
    words.push(BIP39_ENGLISH[v]!)
  }
  all.fill(0)
  return words
}

export type WordsResult =
  | { ok: true; entropy: Uint8Array }
  | { ok: false; reason: 'count'; got: number }
  | { ok: false; reason: 'unknown-word'; position: number }
  | { ok: false; reason: 'checksum' }

/** PURE. Resolve one typed word: the whole word, or its unique 4-letter prefix. */
export function resolveWord(typed: string): number | null {
  const w = typed.trim().toLowerCase()
  if (INDEX.has(w)) return INDEX.get(w)!
  if (w.length >= 4) {
    const i = BY_PREFIX.get(w.slice(0, 4))
    if (i !== undefined && BIP39_ENGLISH[i]!.startsWith(w)) return i
  }
  return null
}

/** PURE. 24 words (whitespace-separated, case-insensitive, 4-letter prefixes accepted) → entropy. */
export function wordsToEntropy(input: string | readonly string[]): WordsResult {
  const words = (typeof input === 'string' ? input.split(/\s+/) : [...input]).map(w => w.trim()).filter(Boolean)
  if (words.length !== RECOVERY_WORDS) return { ok: false, reason: 'count', got: words.length }
  const idx: number[] = []
  for (let i = 0; i < words.length; i++) {
    const n = resolveWord(words[i]!)
    if (n === null) return { ok: false, reason: 'unknown-word', position: i + 1 }
    idx.push(n)
  }
  const all = new Uint8Array(ENTROPY_BYTES + 1)
  for (let i = 0; i < RECOVERY_WORDS; i++) {
    for (let b = 0; b < 11; b++) {
      if ((idx[i]! >> (10 - b)) & 1) { const bit = i * 11 + b; all[bit >> 3]! |= 1 << (7 - (bit & 7)) }
    }
  }
  const entropy = new Uint8Array(all.subarray(0, ENTROPY_BYTES))
  const ok = createHash('sha256').update(entropy).digest()[0] === all[ENTROPY_BYTES]
  all.fill(0)
  if (!ok) { entropy.fill(0); return { ok: false, reason: 'checksum' } }
  return { ok: true, entropy }
}

/** Three distinct positions (1-based) to confirm, in ascending order — §4.2. */
export function confirmPositions(n = 3): number[] {
  const s = new Set<number>()
  while (s.size < n) s.add(randomInt(1, RECOVERY_WORDS + 1))
  return [...s].sort((a, b) => a - b)
}

/** PURE. Did the user type the words at those positions? (prefixes accepted) */
export function confirmWords(words: readonly string[], positions: readonly number[], typed: readonly string[]): boolean {
  if (typed.length !== positions.length) return false
  return positions.every((p, i) => resolveWord(typed[i] ?? '') === INDEX.get(words[p - 1] ?? ''))
}

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
export function recoveryProtector(o: { io: ProtectorIo; vaultDir: string; entropy?: Uint8Array }): Protector {
  const file = `${o.vaultDir}/${RECOVERY_FILE}`
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
