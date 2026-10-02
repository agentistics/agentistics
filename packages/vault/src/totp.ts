/**
 * totp.ts — RFC 6238 TOTP (SHA-1, 30s step, 6 digits) and RFC 4648 base32, on node:crypto only.
 *
 * MOVED here from packages/server/server/totp.ts by SECRETS.4 §2.1, so the host's account MFA
 * (stepup.ts / iam-handlers.ts, which re-export it) and the vault's authenticator gate share ONE
 * implementation. The vault's gate uses the BYTES-keyed functions (`hotp`, `matchTotp`) so the seed
 * can be zeroed after each use — a base32 string cannot be.
 *
 * No dependency, so `bun build --compile` of the machine binary keeps working. Pure and unit
 * tested against the published RFC vectors — a home-grown OTP that merely looks plausible fails
 * against real authenticator apps, and you find out during an outage.
 *
 * Recovery codes are stored ONLY as sha256 hashes, the same rule machine tokens follow.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_SECONDS = 30

export function base32Encode(buf: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  while (out.length % 8 !== 0) out += '='
  return out
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error('invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** A fresh 20-byte (160-bit) shared secret, base32-encoded for authenticator apps. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The HOTP value for an explicit counter — the unit-testable core of TOTP. */
export function totpAt(secretBase32: string, counter: number, digits = 6): string {
  const key = base32Decode(secretBase32)
  try { return hotp(key, counter, digits) } finally { key.fill(0) }
}

/** RFC 4226 HOTP over a raw key (the vault gate's form: the caller zeroes `key`). */
export function hotp(key: Uint8Array, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const mac = createHmac('sha1', key).update(buf).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff)
  return String(bin % 10 ** digits).padStart(digits, '0')
}

/** Accepts the current step plus `window` steps either side (default 1 = ±30s of clock skew). */
export function verifyTotp(secretBase32: string, code: string, nowSec: number, window = 1): boolean {
  const trimmed = code.replace(/\s/g, '')
  if (!/^\d{6,8}$/.test(trimmed)) return false
  const counter = Math.floor(nowSec / STEP_SECONDS)
  for (let d = -window; d <= window; d++) {
    let expected: string
    try {
      expected = totpAt(secretBase32, counter + d, trimmed.length)
    } catch {
      return false // unusable secret — never fall through to "accepted"
    }
    const a = Buffer.from(expected)
    const b = Buffer.from(trimmed)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

/**
 * How far the presented code sits from the current step, searched over a WIDE window, or null
 * when it is not this secret's code at all.
 *
 * A TOTP failure has two causes that look identical to the user — a wrong code, and two clocks
 * that disagree — and only one of them is their fault. A container whose host slept (WSL2 and
 * laptops both do this) drifts minutes in an afternoon, so every enrolment then fails with
 * "invalid code" and no way to tell. This is a DIAGNOSTIC, never an authorisation: the caller
 * still refuses the code — enrolling a secret against a clock that is wrong only moves the
 * failure to every future login.
 */
export function totpSkewSteps(
  secretBase32: string,
  code: string,
  nowSec: number,
  windowSteps = 20,
): number | null {
  const trimmed = code.replace(/\s/g, '')
  if (!/^\d{6,8}$/.test(trimmed)) return null
  const counter = Math.floor(nowSec / STEP_SECONDS)
  // Nearest first, so a code that matches twice (it cannot, in practice) reports the small skew.
  for (let d = 0; d <= windowSteps; d++) {
    for (const signed of d === 0 ? [0] : [d, -d]) {
      let expected: string
      try {
        expected = totpAt(secretBase32, counter + signed, trimmed.length)
      } catch {
        return null
      }
      if (expected === trimmed) return signed
    }
  }
  return null
}

/**
 * The vault gate's matcher (SECRETS.4 §2.1): the STEP (counter) the code belongs to within ±`window`,
 * or null. Every candidate is compared, in constant time, whatever matched first — so the timing does
 * not say which step it was. The step is what replay protection records.
 */
export function matchTotp(key: Uint8Array, code: string, nowSec: number, window = 1, digits = 6): number | null {
  const c = code.replace(/\s/g, '')
  if (!new RegExp(`^\\d{${digits}}$`).test(c)) return null
  const counter = Math.floor(nowSec / STEP_SECONDS)
  const given = Buffer.from(c)
  let found: number | null = null
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(hotp(key, counter + d, digits))
    if (timingSafeEqual(expected, given) && found === null) found = counter + d
  }
  return found
}

/** `totpSkewSteps` over a raw key: how many steps off a code is, within ±`windowSteps`, or null. */
export function skewStepsOf(key: Uint8Array, code: string, nowSec: number, windowSteps = 20, digits = 6): number | null {
  const c = code.replace(/\s/g, '')
  if (!new RegExp(`^\\d{${digits}}$`).test(c)) return null
  const counter = Math.floor(nowSec / STEP_SECONDS)
  for (let d = 0; d <= windowSteps; d++) {
    for (const signed of d === 0 ? [0] : [d, -d]) if (hotp(key, counter + signed, digits) === c) return signed
  }
  return null
}

/** Seconds per TOTP step — the unit `totpSkewSteps` reports in. */
export const TOTP_STEP_SECONDS = STEP_SECONDS

export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/** Ten single-use codes in XXXXX-XXXXX form. Shown once, stored only as hashes. */
export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () =>
    randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g)!.join('-'),
  )
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex')
}
