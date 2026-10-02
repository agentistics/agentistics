/**
 * totp.test.ts — checked against the RFC 4648 (base32) and RFC 6238 (TOTP) published vectors.
 * A home-grown OTP that merely "looks right" fails against real authenticator apps, so the
 * published vectors are the only acceptable oracle here.
 */
import { describe, expect, it } from 'bun:test'
import {
  base32Encode,
  base32Decode,
  totpAt,
  verifyTotp,
  totpSkewSteps,
  TOTP_STEP_SECONDS,
  otpauthUri,
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
} from './totp'

describe('base32', () => {
  it('encodes and decodes round-trip', () => {
    const bytes = new TextEncoder().encode('12345678901234567890')
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes)
  })

  it('matches the RFC 4648 vectors', () => {
    const enc = (s: string) => base32Encode(new TextEncoder().encode(s))
    expect(enc('f')).toBe('MY======')
    expect(enc('fo')).toBe('MZXQ====')
    expect(enc('foo')).toBe('MZXW6===')
    expect(enc('foob')).toBe('MZXW6YQ=')
    expect(enc('fooba')).toBe('MZXW6YTB')
    expect(enc('foobar')).toBe('MZXW6YTBOI======')
  })

  it('throws on a character outside the alphabet', () => {
    expect(() => base32Decode('MZXW6YTB!')).toThrow()
  })
})

describe('totpAt', () => {
  // RFC 6238 Appendix B, SHA-1, seed "12345678901234567890", 8 digits.
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'))

  it('matches the vector at T=59 (counter 1)', () => {
    expect(totpAt(secret, 1, 8)).toBe('94287082')
  })

  it('matches the vector at T=1111111109 (counter 37037036)', () => {
    expect(totpAt(secret, 37037036, 8)).toBe('07081804')
  })

  it('matches the vector at T=1234567890 (counter 41152263)', () => {
    expect(totpAt(secret, 41152263, 8)).toBe('89005924')
  })

  it('matches the vector at T=2000000000 (counter 66666666)', () => {
    expect(totpAt(secret, 66666666, 8)).toBe('69279037')
  })

  it('produces zero-padded 6-digit codes by default', () => {
    const code = totpAt(secret, 1)
    expect(code).toHaveLength(6)
    expect(code).toMatch(/^\d{6}$/)
  })
})

describe('verifyTotp', () => {
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'))

  it('accepts the current code', () => {
    const now = 59
    expect(verifyTotp(secret, totpAt(secret, Math.floor(now / 30)), now)).toBe(true)
  })

  it('accepts a code from the previous step (clock skew)', () => {
    const now = 120
    expect(verifyTotp(secret, totpAt(secret, Math.floor(now / 30) - 1), now)).toBe(true)
  })

  it('rejects a code three steps old', () => {
    const now = 300
    expect(verifyTotp(secret, totpAt(secret, Math.floor(now / 30) - 3), now)).toBe(false)
  })

  it('rejects a malformed code without throwing', () => {
    expect(verifyTotp(secret, 'abcdef', 59)).toBe(false)
    expect(verifyTotp(secret, '', 59)).toBe(false)
    expect(verifyTotp(secret, '12345', 59)).toBe(false)
  })

  it('tolerates spaces, which authenticator apps display', () => {
    const now = 59
    const code = totpAt(secret, Math.floor(now / 30))
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true)
  })
})

describe('generateSecret', () => {
  it('produces a decodable 20-byte base32 secret', () => {
    const s = generateSecret()
    expect(base32Decode(s).length).toBe(20)
  })

  it('does not repeat', () => {
    expect(generateSecret()).not.toBe(generateSecret())
  })
})

describe('otpauthUri', () => {
  it('builds a scannable URI with the issuer', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'vini@example.com', 'Agentistics')
    expect(uri).toContain('otpauth://totp/Agentistics:vini%40example.com')
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain('issuer=Agentistics')
    expect(uri).toContain('period=30')
  })
})

describe('recovery codes', () => {
  it('generates 10 distinct codes', () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
  })

  it('hashes deterministically and never returns the plaintext', () => {
    const [c] = generateRecoveryCodes(1)
    expect(hashRecoveryCode(c!)).toBe(hashRecoveryCode(c!))
    expect(hashRecoveryCode(c!)).not.toBe(c)
    expect(hashRecoveryCode(c!)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('normalises case and spacing so a hand-typed code still matches', () => {
    const [c] = generateRecoveryCodes(1)
    expect(hashRecoveryCode(`  ${c!.toLowerCase()} `)).toBe(hashRecoveryCode(c!))
  })
})

describe('totpSkewSteps — telling a wrong code apart from a wrong clock', () => {
  const secret = 'JBSWY3DPEHPK3PXP'
  const now = 1_700_000_000

  it('reports zero when the code is for the current step', () => {
    expect(totpSkewSteps(secret, totpAt(secret, Math.floor(now / TOTP_STEP_SECONDS)), now)).toBe(0)
  })

  it('reports how many steps ahead a code from a device with the right time is', () => {
    // The server is 6 minutes BEHIND: the device's code belongs to a later step.
    const deviceCounter = Math.floor((now + 6 * 60) / TOTP_STEP_SECONDS)
    expect(totpSkewSteps(secret, totpAt(secret, deviceCounter), now)).toBe(12)
  })

  it('reports a negative skew when the server runs ahead', () => {
    const deviceCounter = Math.floor((now - 3 * 60) / TOTP_STEP_SECONDS)
    expect(totpSkewSteps(secret, totpAt(secret, deviceCounter), now)).toBe(-6)
  })

  it('returns null for a code this secret never produced — a wrong code stays wrong', () => {
    expect(totpSkewSteps(secret, '000000', now, 2)).toBeNull()
    expect(totpSkewSteps(secret, 'not-a-code', now)).toBeNull()
  })

  it('stays inside its window, so a very stale code is not excused', () => {
    const far = Math.floor(now / TOTP_STEP_SECONDS) + 40
    expect(totpSkewSteps(secret, totpAt(secret, far), now, 20)).toBeNull()
  })

  it('never accepts what verifyTotp rejects — it only explains it', () => {
    const drifted = totpAt(secret, Math.floor(now / TOTP_STEP_SECONDS) + 12)
    expect(verifyTotp(secret, drifted, now)).toBe(false)
    expect(totpSkewSteps(secret, drifted, now)).toBe(12)
  })
})
