/**
 * vault/phone.ts — OPENING the vault from a phone, and approving a phone on the computer
 * (VAULT.PERSONAL §10, robust section in the spec). No gate lives here: phone-http.ts asks gate.ts.
 *
 * THE RULE (owner, 2026-10-03): from any non-loopback origin the vault never raises Windows Hello. It
 * opens with EITHER
 *   (a) a passkey registered FROM that phone (biometrics, `userVerification: required`) whose PRF output
 *       unwraps a phone copy of the data key, PLUS the authenticator code; or
 *   (b) only when the owner turned on "code alone from the phone": a device key that phone received when
 *       the computer approved it, PLUS the code.
 * The code is checked AFTER the unwrap with the key it produced, by the same `completeUnlock` the
 * computer uses, so the phone's unlock opens the vault for the same auto-lock window.
 *
 * REGISTERING a phone is an escalation, so it is TWO halves on TWO devices: the phone asks with the code
 * (vault open), a pending request appears on the computer with a match code, and the person approves it
 * there with Windows Hello. A stolen code alone therefore enrols nothing. The approval is single use,
 * bound to the phone's session and kind, and expires.
 */
import { randomBytes, randomInt } from 'node:crypto'
import {
  b64url, b64urlDecode, newDeviceSecret, newPhoneSalt, unwrapForPhone, verifyAssertion, wrapForPhone,
  type PhoneWrap, type StoredPasskey, type WebAuthnFail,
} from '@agentistics/vault'
import { ensureVaultOpen, secretFs, stagePhoneUnlock, vaultDir } from './service'
import { dropPhoneWraps, notePhoneSignCount, putPhoneWrap, readPhoneWraps } from './phone-store'
import { addDevice, notePasskeyCount, storedPasskey } from './mobile'
import { join } from 'node:path'

const CHALLENGE_TTL_MS = 60_000
export const REQUEST_TTL_MS = 5 * 60_000
/** After approval, the phone has this long to finish (create the passkey / take its device key). */
export const APPROVAL_TTL_MS = 5 * 60_000
const MAX_PENDING = 5

let _now: () => number = () => Date.now()

/** The kid of the vault on disk — readable while LOCKED (it is in clear in vault.json). */
async function currentKid(): Promise<string | null> {
  const raw = await secretFs().readFile(join(vaultDir(), 'vault.json'))
  if (!raw) return null
  try { const v = JSON.parse(new TextDecoder().decode(raw)) as { kid?: unknown }; return typeof v.kid === 'string' ? v.kid : null } catch { return null }
}

/** What a page needs to choose its offers (core `unlockOffers`) — counts and opaque ids, no labels. */
export async function phoneUnlockFacts(rpId: string): Promise<{ passkeys: number; devices: string[]; stale: number }> {
  const kid = await currentKid()
  const all = await readPhoneWraps()
  const live = all.filter(w => w.kid === kid)
  return {
    passkeys: live.filter(w => w.kind === 'passkey' && w.passkey?.rpId === rpId).length,
    devices: live.filter(w => w.kind === 'device').map(w => w.id),
    stale: all.length - live.length,
  }
}

// ── challenges: unlock assertions and the enrol PRF step ─────────────────────────────────────

type Challenge = { session: string; kind: 'unlock' | 'enrol-prf'; challenge: Uint8Array; rpId: string; origin: string; until: number; credentialId?: string; salt?: string }
let _challenges = new Map<string, Challenge>()
function sweep(): void { for (const [k, c] of _challenges) if (_now() >= c.until) _challenges.delete(k) }
function issue(c: Omit<Challenge, 'challenge' | 'until'>): { challengeId: string; challenge: string } {
  sweep()
  const challenge = new Uint8Array(randomBytes(32))
  const id = b64url(new Uint8Array(randomBytes(16)))
  _challenges.set(id, { ...c, challenge, until: _now() + CHALLENGE_TTL_MS })
  return { challengeId: id, challenge: b64url(challenge) }
}
function take(id: string, session: string, kind: Challenge['kind']): Challenge | null {
  sweep()
  const c = _challenges.get(id)
  _challenges.delete(id)
  return c && c.session === session && c.kind === kind ? c : null
}

/** Phase 1 of a passkey unlock: a challenge plus, per allowed credential, the PRF input (its salt). */
export async function beginPhoneUnlock(session: string, rpId: string, origin: string): Promise<{ ok: true; challengeId: string; challenge: string; rpId: string; allow: { id: string; salt: string }[] } | { ok: false; code: 'no-passkey' }> {
  const kid = await currentKid()
  const keys = (await readPhoneWraps()).filter(w => w.kind === 'passkey' && w.kid === kid && w.passkey?.rpId === rpId)
  if (keys.length === 0) return { ok: false, code: 'no-passkey' }
  const c = issue({ session, kind: 'unlock', rpId, origin })
  return { ok: true, ...c, rpId, allow: keys.map(k => ({ id: k.id, salt: k.salt })) }
}

export type PhoneUnlockFail = 'no-challenge' | 'bad-secret' | WebAuthnFail | 'unknown-device'
/**
 * Phase 2 (both kinds): verify what the phone brought and turn it into a PENDING key. The caller then
 * completes with the code. Returns the id of the phone that opened it (for the audit's label).
 */
export async function stageFromPhone(session: string, b: Record<string, unknown>): Promise<{ ok: true; id: string; state: 'open' | 'pending-stepup' } | { ok: false; code: PhoneUnlockFail | string; sentence?: string }> {
  if (b.kind === 'device') {
    const id = typeof b.deviceId === 'string' ? b.deviceId : ''
    const secret = typeof b.deviceSecret === 'string' ? b64urlDecode(b.deviceSecret) : null
    const w = (await readPhoneWraps()).find(x => x.kind === 'device' && x.id === id)
    if (!w) return { ok: false, code: 'unknown-device' }
    if (!secret) return { ok: false, code: 'bad-secret' }
    try {
      const r = await stagePhoneUnlock(kid => unwrapForPhone(w, secret, kid))
      return r.ok ? { ok: true, id, state: r.state } : r
    } finally { secret.fill(0) }
  }
  const c = take(String(b.challengeId ?? ''), session, 'unlock')
  if (!c) return { ok: false, code: 'no-challenge' }
  const credentialId = String(b.credentialId ?? '')
  const w = (await readPhoneWraps()).find(x => x.kind === 'passkey' && x.id === credentialId)
  if (!w || !w.passkey) return { ok: false, code: 'unknown-credential' }
  const pk: StoredPasskey = { credentialId: w.id, spki: w.passkey.spki, alg: w.passkey.alg, rpId: w.passkey.rpId, signCount: w.passkey.signCount, label: '', createdAt: w.createdAt }
  const v = verifyAssertion({
    credentialId, clientDataJSON: String(b.clientDataJSON ?? ''), authenticatorData: String(b.authenticatorData ?? ''),
    signature: String(b.signature ?? ''), expectedChallenge: c.challenge, expectedOrigin: c.origin, rpId: c.rpId, passkeys: [pk],
  })
  if (!v.ok) return v
  await notePhoneSignCount(w.id, v.signCount)
  const prf = typeof b.prf === 'string' ? b64urlDecode(b.prf) : null
  if (!prf) return { ok: false, code: 'bad-secret' }
  try {
    const r = await stagePhoneUnlock(kid => unwrapForPhone(w, prf, kid))
    return r.ok ? { ok: true, id: w.id, state: r.state } : r
  } finally { prf.fill(0) }
}

// ── enrolment: a request on the phone, an approval on the computer ──────────────────────────

export type EnrolKind = 'passkey' | 'device'
interface EnrolRequest { id: string; session: string; label: string; kind: EnrolKind; match: string; createdAt: number; until: number; status: 'pending' | 'approved' | 'denied'; used: boolean }
let _requests = new Map<string, EnrolRequest>()
function sweepRequests(): void { for (const [k, r] of _requests) if (_now() >= r.until) _requests.delete(k) }

/** The phone asked (the route already checked the code and the kind). One pending request per session. */
export function requestEnrol(session: string, label: string, kind: EnrolKind): { ok: true; id: string; match: string; expiresInMs: number } | { ok: false; code: 'too-many' } {
  sweepRequests()
  for (const [k, r] of _requests) if (r.session === session && r.status === 'pending') _requests.delete(k)
  if ([..._requests.values()].filter(r => r.status === 'pending').length >= MAX_PENDING) return { ok: false, code: 'too-many' }
  const id = b64url(new Uint8Array(randomBytes(12)))
  // Shown on BOTH screens, so the person approves the phone in their hand and not another request.
  const match = `${randomInt(10, 100)} ${randomInt(10, 100)}`
  _requests.set(id, { id, session, label, kind, match, createdAt: _now(), until: _now() + REQUEST_TTL_MS, status: 'pending', used: false })
  return { ok: true, id, match, expiresInMs: REQUEST_TTL_MS }
}

/** For the computer: the requests waiting on a person. Labels and match codes — nothing secret. */
export function pendingRequests(): { id: string; label: string; kind: EnrolKind; match: string; createdAt: string; expiresInMs: number }[] {
  sweepRequests()
  return [..._requests.values()].filter(r => r.status === 'pending')
    .map(r => ({ id: r.id, label: r.label, kind: r.kind, match: r.match, createdAt: new Date(r.createdAt).toISOString(), expiresInMs: Math.max(0, r.until - _now()) }))
}

/** The computer decided (the route already proved the gesture on loopback). */
export function decideRequest(id: string, approve: boolean): { ok: true; label: string } | { ok: false; code: 'not-found' } {
  sweepRequests()
  const r = _requests.get(id)
  if (!r || r.status !== 'pending') return { ok: false, code: 'not-found' }
  r.status = approve ? 'approved' : 'denied'
  if (approve) r.until = _now() + APPROVAL_TTL_MS
  return { ok: true, label: r.label }
}

/** For the phone that asked (and only that phone): has the computer answered? */
export function requestStatus(session: string, id: string): 'pending' | 'approved' | 'denied' | 'expired' {
  sweepRequests()
  const r = _requests.get(id)
  if (!r || r.session !== session || r.used) return 'expired'
  return r.status
}

/** An approval is spent ONCE, by the session and kind it was given for. */
function approved(session: string, id: string, kind: EnrolKind): EnrolRequest | null {
  sweepRequests()
  const r = _requests.get(id)
  return r && r.session === session && r.kind === kind && r.status === 'approved' && !r.used ? r : null
}
export function approvalLabel(session: string, id: string, kind: EnrolKind): string | null { return approved(session, id, kind)?.label ?? null }
function spend(id: string): void { const r = _requests.get(id); if (r) { r.used = true; _requests.delete(id) } }

/** A passkey was registered under an approval: spend it, and ask the phone for its PRF output. */
export function passkeyRegistered(session: string, requestId: string, credentialId: string, rpId: string, origin: string): { challengeId: string; challenge: string; salt: string } {
  spend(requestId)
  const salt = newPhoneSalt()
  return { ...issue({ session, kind: 'enrol-prf', rpId, origin, credentialId, salt }), salt }
}

/**
 * The enrol PRF step: an assertion from the passkey just registered, carrying its PRF output for the
 * salt. Verified against the sealed passkey (the vault is open), then a phone copy of the data key is
 * written. A phone with no PRF keeps its passkey for confirming actions and is told it cannot OPEN.
 */
export async function finishPasskeyKey(session: string, b: Record<string, unknown>): Promise<{ ok: true; unlockable: boolean } | { ok: false; code: string }> {
  const c = take(String(b.challengeId ?? ''), session, 'enrol-prf')
  if (!c || !c.credentialId || !c.salt) return { ok: false, code: 'no-challenge' }
  const pk = await storedPasskey(c.credentialId)
  if (!pk || String(b.credentialId ?? '') !== c.credentialId) return { ok: false, code: 'unknown-credential' }
  const v = verifyAssertion({
    credentialId: c.credentialId, clientDataJSON: String(b.clientDataJSON ?? ''), authenticatorData: String(b.authenticatorData ?? ''),
    signature: String(b.signature ?? ''), expectedChallenge: c.challenge, expectedOrigin: c.origin, rpId: c.rpId, passkeys: [pk],
  })
  if (!v.ok) return v
  await notePasskeyCount(pk.credentialId, v.signCount)
  const prf = typeof b.prf === 'string' ? b64urlDecode(b.prf) : null
  if (!prf || prf.length !== 32) return { ok: true, unlockable: false }
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) { prf.fill(0); return { ok: false, code: 'vault-locked' } }
  try {
    const w: PhoneWrap = wrapForPhone({
      dek: o.dek, kid: o.kid, kind: 'passkey', id: pk.credentialId, secret: prf, salt: c.salt, createdAt: new Date(_now()).toISOString(),
      passkey: { spki: pk.spki, alg: pk.alg, rpId: pk.rpId, signCount: v.signCount },
    })
    await putPhoneWrap(w)
    return { ok: true, unlockable: true }
  } finally { prf.fill(0) }
}

/** A device key under an approval: minted here, handed to the phone ONCE, never kept on the computer. */
export async function issueDeviceKey(session: string, requestId: string): Promise<{ ok: true; deviceId: string; deviceSecret: string; label: string } | { ok: false; code: 'not-approved' | 'vault-locked' }> {
  const r = approved(session, requestId, 'device')
  if (!r) return { ok: false, code: 'not-approved' }
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) return { ok: false, code: 'vault-locked' }
  spend(requestId)
  const id = `dev-${b64url(new Uint8Array(randomBytes(9)))}`
  const secret = newDeviceSecret()
  try {
    const createdAt = new Date(_now()).toISOString()
    await putPhoneWrap(wrapForPhone({ dek: o.dek, kid: o.kid, kind: 'device', id, secret, salt: newPhoneSalt(), createdAt }))
    await addDevice({ id, label: r.label, createdAt })
    return { ok: true, deviceId: id, deviceSecret: b64url(secret), label: r.label }
  } finally { secret.fill(0) }
}

/** Copies left behind by a key rotation open nothing; the computer can clear them. */
export async function dropStalePhoneWraps(): Promise<number> {
  const kid = await currentKid()
  return dropPhoneWraps(w => w.kid !== kid)
}

export function __resetPhoneForTests(now?: () => number): void {
  _now = now ?? (() => Date.now())
  _challenges = new Map(); _requests = new Map()
}
