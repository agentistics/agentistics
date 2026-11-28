/**
 * recovery-words.ts — the 24 words of the recovery key, PURE apart from randomness (SECRETS.4 §4).
 * Split out of recovery.ts so a module that only turns words into entropy (the backup key's recovery
 * wrap) does not import the file-writing recovery wrapper. recovery.ts re-exports all of it.
 * The bit layout and the word list are documented in recovery.ts.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { BIP39_ENGLISH } from './bip39-english'
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
