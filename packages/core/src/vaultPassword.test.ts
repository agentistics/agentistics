import { describe, expect, test } from 'bun:test'
import {
  VAULT_PASSWORD_GENERATED_LENGTH, VAULT_PASSWORD_MAX_LENGTH, VAULT_PASSWORD_RULES, VAULT_PASSWORD_RULE_TEXT,
  checkVaultPassword, generateVaultPassword, vaultPasswordWeakSentence,
} from './vaultPassword'

// Test values only — none of these is anyone's password.
const GOOD = 'Abcdef1!@'

describe('checkVaultPassword — the owner\'s four rules, each one failing on its own', () => {
  test('a password meeting every rule passes', () => {
    const c = checkVaultPassword(GOOD)
    expect(c.ok).toBe(true)
    expect(c.failed).toEqual([])
    expect(c.rules).toEqual({ length: true, upper: true, special: true, digit: true })
  })
  test('length: 8 characters fails, 9 passes', () => {
    expect(checkVaultPassword('Abcde1!@').failed).toEqual(['length'])
    expect(checkVaultPassword('Abcdef1!@').ok).toBe(true)
  })
  test('upper: no uppercase letter fails', () => {
    expect(checkVaultPassword('abcdef1!@').failed).toEqual(['upper'])
  })
  test('special: ONE special character is not enough, two pass', () => {
    expect(checkVaultPassword('Abcdefg1!').failed).toEqual(['special'])
    expect(checkVaultPassword('Abcdefg1x').failed).toEqual(['special'])
    expect(checkVaultPassword('Abcdef1!@').ok).toBe(true)
  })
  test('digit: no number fails', () => {
    expect(checkVaultPassword('Abcdefg!@').failed).toEqual(['digit'])
  })
  test('the empty string fails every rule, in the order the page lists them', () => {
    expect(checkVaultPassword('').failed).toEqual(['length', 'upper', 'special', 'digit'])
  })
  test('letters with accents are letters, not specials; € is special; space is neither', () => {
    expect(checkVaultPassword('Ação1éçõ!').failed).toEqual(['special'])
    expect(checkVaultPassword('Ação1éç€!').ok).toBe(true)
    expect(checkVaultPassword('Abcdef1! ').failed).toEqual(['special'])
    expect(checkVaultPassword('ÉÇÃ123!@x').ok).toBe(true) // non-ASCII uppercase counts
  })
  test('length counts characters, not UTF-16 units (an emoji is one)', () => {
    expect(checkVaultPassword('A1!😀😀😀😀😀').failed).toEqual(['length']) // 8 characters
    expect(checkVaultPassword('A1!😀😀😀😀😀😀').ok).toBe(true)          // 9 (the emoji count as specials)
  })
  test('a bounded input: longer than the maximum is refused, said apart from the rules', () => {
    const long = 'A1!@' + 'x'.repeat(VAULT_PASSWORD_MAX_LENGTH)
    const c = checkVaultPassword(long)
    expect(c.ok).toBe(false)
    expect(c.tooLong).toBe(true)
    expect(c.failed).toEqual([])
  })
})

describe('the refusal sentence', () => {
  test('names what is missing (EN + PT) and never echoes the password', () => {
    const pw = 'abc'
    const c = checkVaultPassword(pw)
    for (const lang of ['en', 'pt'] as const) {
      const s = vaultPasswordWeakSentence(c, lang)
      expect(s).not.toContain(pw)
      for (const r of c.failed) expect(s).toContain(VAULT_PASSWORD_RULE_TEXT[r][lang].toLowerCase())
    }
    expect(vaultPasswordWeakSentence(c, 'pt')).toContain('Nada foi alterado')
  })
  test('every rule has words in both languages', () => {
    for (const r of VAULT_PASSWORD_RULES) {
      expect(VAULT_PASSWORD_RULE_TEXT[r].en.length).toBeGreaterThan(5)
      expect(VAULT_PASSWORD_RULE_TEXT[r].pt.length).toBeGreaterThan(5)
    }
  })
})

describe('generateVaultPassword — a CSPRNG password that always meets the rules', () => {
  test('1000 samples: every one passes, has the generated length, and they are all different', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const p = generateVaultPassword()
      expect(checkVaultPassword(p).ok).toBe(true)
      expect([...p]).toHaveLength(VAULT_PASSWORD_GENERATED_LENGTH)
      seen.add(p)
    }
    expect(seen.size).toBe(1000)
  })
  test('the guaranteed characters do not sit at fixed positions (shuffled)', () => {
    const firsts = new Set<string>()
    for (let i = 0; i < 200; i++) firsts.add(generateVaultPassword()[0]!)
    expect(firsts.size).toBeGreaterThan(10)
  })
  test('a length below the minimum is raised to the minimum, and still meets the rules', () => {
    const p = generateVaultPassword(4)
    expect([...p]).toHaveLength(9)
    expect(checkVaultPassword(p).ok).toBe(true)
  })
  test('rejection sampling: a source that returns biased words first is still unbiased in what it keeps', () => {
    // A source that first offers the top of the 32-bit range (which rejection must discard) then normal words.
    let n = 0
    const rnd = (k: number) => { const out = new Uint32Array(k); for (let i = 0; i < k; i++) out[i] = (n++ % 3 === 0) ? 0xffffffff : n * 2654435761 >>> 0; return out }
    const p = generateVaultPassword(18, rnd)
    expect(checkVaultPassword(p).ok).toBe(true)
  })
})
