/**
 * vaultPassword.ts — the vault's OWN password: its rules and its generator (owner decision 2026-11-07,
 * COFRE.DESBLOQUEIO). PURE, and shared on purpose: the page checks a draft live with THESE rules and the
 * server refuses a weak one with the SAME function — a rule enforced only in the browser is a rule any
 * request can skip.
 *
 * The rules are the owner's, exactly: at least 9 characters, at least 1 uppercase letter, at least 2
 * special characters and at least 1 number. "Special" is anything that is not a letter, a digit or white
 * space (so `é` and `ç` are letters, `!` and `€` are special). Counting is by code point, so an emoji is
 * one character rather than two UTF-16 units.
 *
 * The generator draws from `crypto.getRandomValues` (a CSPRNG in the browser and in Bun), rejects modulo
 * bias, guarantees every rule by construction and then shuffles, so the guaranteed characters do not sit
 * at predictable positions.
 */

export type VaultPasswordRule = 'length' | 'upper' | 'special' | 'digit'
export const VAULT_PASSWORD_RULES: readonly VaultPasswordRule[] = ['length', 'upper', 'special', 'digit']
export const VAULT_PASSWORD_MIN_LENGTH = 9
export const VAULT_PASSWORD_MIN_SPECIAL = 2
/** Generous but bounded: a scrypt input this long costs nothing more, and a request body stays small. */
export const VAULT_PASSWORD_MAX_LENGTH = 256

export interface VaultPasswordCheck {
  ok: boolean
  /** Each rule, met or not — what the page ticks off as the person types. */
  rules: Record<VaultPasswordRule, boolean>
  /** The rules NOT met, in the order the page lists them. */
  failed: VaultPasswordRule[]
  /** Longer than `VAULT_PASSWORD_MAX_LENGTH` (not one of the owner's rules; a bound on the input). */
  tooLong: boolean
}

const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase()
const isDigit = (c: string): boolean => /^\p{Nd}$/u.test(c)
const isLetter = (c: string): boolean => /^\p{L}$/u.test(c)
const isSpace = (c: string): boolean => /^\s$/u.test(c)
const isSpecial = (c: string): boolean => !isLetter(c) && !isDigit(c) && !isSpace(c) && !/^\p{M}$/u.test(c)

/** PURE. Every rule against `pw`. Never echoes the password anywhere. */
export function checkVaultPassword(pw: string): VaultPasswordCheck {
  const chars = [...pw]
  const rules: Record<VaultPasswordRule, boolean> = {
    length: chars.length >= VAULT_PASSWORD_MIN_LENGTH,
    upper: chars.some(isUpper),
    special: chars.filter(isSpecial).length >= VAULT_PASSWORD_MIN_SPECIAL,
    digit: chars.some(isDigit),
  }
  const failed = VAULT_PASSWORD_RULES.filter(r => !rules[r])
  const tooLong = chars.length > VAULT_PASSWORD_MAX_LENGTH
  return { ok: failed.length === 0 && !tooLong, rules, failed, tooLong }
}

/** The rule as words, for the live checklist and for the server's refusal (EN + PT). */
export const VAULT_PASSWORD_RULE_TEXT: Readonly<Record<VaultPasswordRule, { en: string; pt: string }>> = {
  length: { en: `At least ${VAULT_PASSWORD_MIN_LENGTH} characters`, pt: `Pelo menos ${VAULT_PASSWORD_MIN_LENGTH} caracteres` },
  upper: { en: 'At least 1 uppercase letter', pt: 'Pelo menos 1 letra maiúscula' },
  special: { en: `At least ${VAULT_PASSWORD_MIN_SPECIAL} special characters (like ! @ # $)`, pt: `Pelo menos ${VAULT_PASSWORD_MIN_SPECIAL} caracteres especiais (como ! @ # $)` },
  digit: { en: 'At least 1 number', pt: 'Pelo menos 1 número' },
}

/** PURE. The refusal sentence for a weak password: what is missing, never the password. */
export function vaultPasswordWeakSentence(c: VaultPasswordCheck, lang: 'en' | 'pt'): string {
  if (c.tooLong) {
    return lang === 'pt'
      ? `A senha do cofre pode ter no máximo ${VAULT_PASSWORD_MAX_LENGTH} caracteres. Nada foi alterado.`
      : `The vault password can be at most ${VAULT_PASSWORD_MAX_LENGTH} characters. Nothing was changed.`
  }
  const missing = c.failed.map(r => VAULT_PASSWORD_RULE_TEXT[r][lang].toLowerCase()).join('; ')
  return lang === 'pt'
    ? `Essa senha ainda não serve para o cofre — falta: ${missing}. Nada foi alterado.`
    : `That password cannot protect the vault yet — it still needs: ${missing}. Nothing was changed.`
}

// ── the generator ───────────────────────────────────────────────────────────────────────────

/** Letters without the look-alikes (I l O 0 1) — a generated password is often copied by hand. */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGITS = '23456789'
/** Specials that survive a shell, a URL field and a password manager without escaping. */
const SPECIALS = '!@#$%&*+-=?_'
const ALL = UPPER + LOWER + DIGITS + SPECIALS
export const VAULT_PASSWORD_GENERATED_LENGTH = 18

/** A source of random 32-bit words. Production is `crypto.getRandomValues`; tests may pass their own. */
export type RandomWords = (n: number) => Uint32Array

const cryptoWords: RandomWords = (n) => {
  const out = new Uint32Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

/** An unbiased index in [0, max): rejection sampling over 32-bit words. */
function uniform(max: number, rnd: RandomWords): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max
  for (;;) {
    const w = rnd(1)[0]!
    if (w < limit) return w % max
  }
}

const pick = (set: string, rnd: RandomWords): string => set[uniform(set.length, rnd)]!

/**
 * A random password that meets every rule: one uppercase, one digit and two specials guaranteed, the
 * rest from the whole alphabet, then a Fisher–Yates shuffle. 18 characters over 69 symbols ≈ 109 bits.
 */
export function generateVaultPassword(length = VAULT_PASSWORD_GENERATED_LENGTH, rnd: RandomWords = cryptoWords): string {
  const n = Math.max(length, VAULT_PASSWORD_MIN_LENGTH)
  const chars = [pick(UPPER, rnd), pick(DIGITS, rnd), pick(SPECIALS, rnd), pick(SPECIALS, rnd)]
  while (chars.length < n) chars.push(pick(ALL, rnd))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = uniform(i + 1, rnd)
    const t = chars[i]!; chars[i] = chars[j]!; chars[j] = t
  }
  return chars.join('')
}
