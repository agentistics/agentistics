/**
 * vault/mobile.ts — the phone's way to prove a gesture for a personal secret (spec §7, robust section).
 *
 * Off loopback the service NEVER raises a Windows Hello prompt for a personal-secret action (nobody is
 * at the computer). Instead, ONE of:
 *  - a passkey assertion (`userVerification: required`) from a credential registered for this vault →
 *    a GESTURE TOKEN: 60 s, single use, bound to the session AND to the one action it was asked for;
 *  - when the owner opted in (`codeReveal`), a fresh authenticator code → a 30-second REVEAL WINDOW for
 *    that session (reveals only).
 *
 * The passkeys and the setting live in ONE sealed record (`personal/mobile.sealed`, purpose
 * `vault/personal`) — integrity: a plain JSON file anyone running as the user could append a key to
 * would make "register a passkey" a file write. No gate lives here: gate.ts and personal-http.ts decide.
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { PERSONAL_PURPOSE, b64url, verifyAssertion, verifyRegistration, type StoredPasskey, type WebAuthnFail } from '@agentistics/vault'
import { openFromFile, sealToFile } from './service'
import { personalRoot } from './personal'

const RECORD_NAME = 'mobile/settings'
const CHALLENGE_TTL_MS = 60_000
const TOKEN_TTL_MS = 60_000
export const CODE_WINDOW_MS = 30_000

let _now: () => number = () => Date.now()
interface MobileRecord { v: 1; passkeys: StoredPasskey[]; codeReveal: boolean }
const file = () => join(personalRoot(), 'mobile.sealed')

export async function readMobile(): Promise<MobileRecord> {
  const r = await openFromFile(file(), PERSONAL_PURPOSE, RECORD_NAME)
  if (!r.ok) return { v: 1, passkeys: [], codeReveal: false }
  try {
    const o = JSON.parse(new TextDecoder().decode(r.plaintext)) as MobileRecord
    return { v: 1, passkeys: Array.isArray(o.passkeys) ? o.passkeys : [], codeReveal: o.codeReveal === true }
  } catch { return { v: 1, passkeys: [], codeReveal: false } } finally { r.plaintext.fill(0) }
}
async function writeMobile(m: MobileRecord): Promise<void> {
  await sealToFile(file(), PERSONAL_PURPOSE, RECORD_NAME, new TextEncoder().encode(JSON.stringify(m)))
}

/** What the page shows: labels and dates, never a key. */
export async function mobileView(): Promise<{ passkeys: { id: string; label: string; rpId: string; createdAt: string }[]; codeReveal: boolean }> {
  const m = await readMobile()
  return { passkeys: m.passkeys.map(p => ({ id: p.credentialId, label: p.label, rpId: p.rpId, createdAt: p.createdAt })), codeReveal: m.codeReveal }
}

// ── challenges ──────────────────────────────────────────────────────────────────────────────

type Challenge = { session: string; kind: 'register' | 'assert'; binding: string; challenge: Uint8Array; rpId: string; origin: string; label: string; until: number }
let _challenges = new Map<string, Challenge>()
function sweep(): void { for (const [k, c] of _challenges) if (_now() >= c.until) _challenges.delete(k) }
function issue(c: Omit<Challenge, 'challenge' | 'until'>): { challengeId: string; challenge: string } {
  sweep()
  const challenge = new Uint8Array(randomBytes(32))
  const id = b64url(new Uint8Array(randomBytes(16)))
  _challenges.set(id, { ...c, challenge, until: _now() + CHALLENGE_TTL_MS })
  return { challengeId: id, challenge: b64url(challenge) }
}
/** Single use: taken out of the map whatever the outcome. */
function take(id: string, session: string, kind: Challenge['kind']): Challenge | null {
  sweep()
  const c = _challenges.get(id)
  _challenges.delete(id)
  return c && c.session === session && c.kind === kind ? c : null
}

export function beginRegistration(session: string, rpId: string, origin: string, label: string) {
  const c = issue({ session, kind: 'register', binding: 'register', rpId, origin, label })
  return {
    ...c,
    rp: { id: rpId, name: 'Agentistics' },
    user: { id: b64url(new TextEncoder().encode('agentistics-vault')), name: 'agentistics', displayName: 'Agentistics' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
  }
}

export async function finishRegistration(session: string, b: Record<string, unknown>): Promise<{ ok: true; id: string } | { ok: false; code: 'no-challenge' | WebAuthnFail }> {
  const c = take(String(b.challengeId ?? ''), session, 'register')
  if (!c) return { ok: false, code: 'no-challenge' }
  const r = verifyRegistration({
    clientDataJSON: String(b.clientDataJSON ?? ''), authenticatorData: String(b.authenticatorData ?? ''), publicKey: String(b.publicKey ?? ''),
    alg: Number(b.alg), credentialId: String(b.credentialId ?? ''), expectedChallenge: c.challenge, expectedOrigin: c.origin, rpId: c.rpId,
  })
  if (!r.ok) return r
  const m = await readMobile()
  m.passkeys = [...m.passkeys.filter(p => p.credentialId !== r.passkey.credentialId), { ...r.passkey, label: c.label, createdAt: new Date(_now()).toISOString() }]
  await writeMobile(m)
  return { ok: true, id: r.passkey.credentialId }
}

export async function beginAssertion(session: string, binding: string, rpId: string, origin: string): Promise<{ ok: true; challengeId: string; challenge: string; allowCredentials: string[]; rpId: string } | { ok: false; code: 'no-passkey' }> {
  const keys = (await readMobile()).passkeys.filter(p => p.rpId === rpId)
  if (keys.length === 0) return { ok: false, code: 'no-passkey' }
  const c = issue({ session, kind: 'assert', binding, rpId, origin, label: '' })
  return { ok: true, ...c, allowCredentials: keys.map(k => k.credentialId), rpId }
}

// ── gesture tokens: what a verified assertion turns into ─────────────────────────────────────

let _tokens = new Map<string, { session: string; binding: string; until: number }>()

export async function finishAssertion(session: string, b: Record<string, unknown>): Promise<{ ok: true; gestureToken: string } | { ok: false; code: 'no-challenge' | WebAuthnFail }> {
  const c = take(String(b.challengeId ?? ''), session, 'assert')
  if (!c) return { ok: false, code: 'no-challenge' }
  const m = await readMobile()
  const r = verifyAssertion({
    credentialId: String(b.credentialId ?? ''), clientDataJSON: String(b.clientDataJSON ?? ''), authenticatorData: String(b.authenticatorData ?? ''),
    signature: String(b.signature ?? ''), expectedChallenge: c.challenge, expectedOrigin: c.origin, rpId: c.rpId, passkeys: m.passkeys,
  })
  if (!r.ok) return r
  m.passkeys = m.passkeys.map(p => (p.credentialId === r.credentialId ? { ...p, signCount: r.signCount } : p))
  await writeMobile(m)
  const token = b64url(new Uint8Array(randomBytes(24)))
  _tokens.set(token, { session, binding: c.binding, until: _now() + TOKEN_TTL_MS })
  return { ok: true, gestureToken: token }
}

/** Single use, this session, THIS action — a reveal of A never edits B. */
export function consumeGestureToken(session: string, token: string | undefined, binding: string): boolean {
  if (!token) return false
  const t = _tokens.get(token)
  _tokens.delete(token)
  return Boolean(t && t.session === session && t.binding === binding && _now() < t.until)
}

export async function removePasskey(id: string): Promise<boolean> {
  const m = await readMobile()
  const next = m.passkeys.filter(p => p.credentialId !== id)
  if (next.length === m.passkeys.length) return false
  await writeMobile({ ...m, passkeys: next })
  return true
}

export async function setCodeReveal(enabled: boolean): Promise<void> {
  const m = await readMobile()
  await writeMobile({ ...m, codeReveal: enabled })
  if (!enabled) _windows = new Map()
}

// ── the code's 30-second reveal window (opt-in) ──────────────────────────────────────────────

let _windows = new Map<string, number>()
export function openCodeWindow(session: string): void { _windows.set(session, _now() + CODE_WINDOW_MS) }
export function codeWindowOpen(session: string): boolean { const u = _windows.get(session); return u !== undefined && _now() < u }

export function __resetMobileForTests(now?: () => number): void {
  _now = now ?? (() => Date.now())
  _challenges = new Map(); _tokens = new Map(); _windows = new Map()
}
