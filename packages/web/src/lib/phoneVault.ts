/**
 * VAULT.PERSONAL §10 — opening the vault from a phone, browser side. The service decides everything
 * (vault/phone.ts); this module drives `navigator.credentials` (a passkey WITH the PRF extension), keeps
 * the device key a "code alone" phone was handed, and encodes bytes.
 *
 * The device key lives in this browser's storage on the PHONE and nowhere on the computer — that is
 * the point of it (the computer alone cannot open the vault). Every storage access is guarded: a
 * private window makes the accessor itself throw.
 */
import { unlockOffers, type UnlockOffer } from '@agentistics/core'
import { b64urlBytes, b64urlEncode } from './passkey'
import { vaultGet, vaultPost, type Reply } from './vaultApi'

export interface PhoneFacts {
  state: string; loopback: boolean; secure: boolean
  passkeys: number; devices: string[]; stale: number
  codeOnly: boolean | null; enrolKinds: Array<'passkey' | 'device'>
}
export function lockedPhoneBox(facts: Pick<PhoneFacts, 'loopback' | 'passkeys' | 'devices' | 'secure'> | null): 'none' | 'register' | 'insecure' {
  if (!facts || facts.loopback || facts.passkeys > 0 || facts.devices.length > 0) return 'none'
  return facts.secure ? 'register' : 'insecure'
}
export const phoneFacts = () => vaultGet<PhoneFacts>('/api/vault/phone')

// ── the device key ("code alone") ─────────────────────────────────────────────────────────────
const DEVICE_KEY = 'agentistics.vault.deviceKey'
export interface DeviceKey { deviceId: string; deviceSecret: string }

/** PURE. A stored value back into a device key, or null for anything else. */
export function parseDeviceKey(raw: string | null): DeviceKey | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    return typeof o.deviceId === 'string' && /^dev-[A-Za-z0-9_-]{4,40}$/.test(o.deviceId) && typeof o.deviceSecret === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(o.deviceSecret)
      ? { deviceId: o.deviceId, deviceSecret: o.deviceSecret } : null
  } catch { return null }
}
export function readDeviceKey(): DeviceKey | null {
  try { return parseDeviceKey(window.localStorage.getItem(DEVICE_KEY)) } catch { return null }
}
function writeDeviceKey(k: DeviceKey | null): boolean {
  try { if (k) window.localStorage.setItem(DEVICE_KEY, JSON.stringify(k)); else window.localStorage.removeItem(DEVICE_KEY); return true } catch { return false }
}

/** PURE. What this page may offer, from the server's facts and what this browser holds. */
export function offersHere(f: Pick<PhoneFacts, 'loopback' | 'secure' | 'passkeys' | 'devices' | 'codeOnly'>, device: DeviceKey | null): UnlockOffer[] {
  return unlockOffers({ loopback: f.loopback, secure: f.secure, passkeys: f.passkeys, codeOnly: f.codeOnly, deviceKey: Boolean(device && f.devices.includes(device.deviceId)) })
}

/** PURE. The PRF output a browser returned, as base64url — or null when the authenticator gave none. */
export function prfFirst(ext: unknown): string | null {
  const first = (ext as { prf?: { results?: { first?: unknown } } } | null)?.prf?.results?.first
  if (first instanceof ArrayBuffer) return first.byteLength === 32 ? b64urlEncode(first) : null
  if (ArrayBuffer.isView(first)) return first.byteLength === 32 ? b64urlEncode(new Uint8Array(first.buffer, first.byteOffset, first.byteLength)) : null
  return null
}

/** PURE. Does a refusal from some other part of the product mean "the vault is locked"? */
export function isVaultLockedRefusal(code: string | null | undefined): boolean {
  if (!code) return false
  return code === 'locked' || code === 'vault-locked' || code === 'auto-locked' || /^vault_(locked|auto_locked)$/.test(code)
}

const cancelled = (): { ok: false; code: string; sentence: string; status: number } => ({ ok: false, code: 'passkey-cancelled', sentence: '', status: 0 })

type Assertion = { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string; prf: string | null }
async function assertWithPrf(challenge: string, rpId: string, allow: { id: string; salt: string }[]): Promise<Assertion | null> {
  let cred: PublicKeyCredential | null
  try {
    const evalByCredential: Record<string, { first: Uint8Array<ArrayBuffer> }> = {}
    for (const a of allow) evalByCredential[a.id] = { first: b64urlBytes(a.salt) }
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlBytes(challenge), rpId, userVerification: 'required', timeout: 60_000,
        allowCredentials: allow.map(a => ({ type: 'public-key' as const, id: b64urlBytes(a.id) })),
        extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null
  } catch { cred = null }
  if (!cred) return null
  const r = cred.response as AuthenticatorAssertionResponse
  return {
    credentialId: b64urlEncode(cred.rawId), clientDataJSON: b64urlEncode(r.clientDataJSON),
    authenticatorData: b64urlEncode(r.authenticatorData), signature: b64urlEncode(r.signature),
    prf: prfFirst(cred.getClientExtensionResults()),
  }
}

// ── opening ───────────────────────────────────────────────────────────────────────────────────

/** Biometrics on this phone (a passkey + PRF) and the code, in ONE request. */
export async function unlockWithPasskey(code: string): Promise<Reply<{ state: string }>> {
  const b = await vaultPost<{ challengeId: string; challenge: string; rpId: string; allow: { id: string; salt: string }[] }>('/api/vault/phone/unlock/begin', {})
  if (!b.ok) return b
  const a = await assertWithPrf(b.challenge, b.rpId, b.allow)
  if (!a) return cancelled()
  return vaultPost<{ state: string }>('/api/vault/phone/unlock', { kind: 'passkey', challengeId: b.challengeId, ...a, prf: a.prf ?? '', code })
}

/** The code alone, on a phone the computer approved (the device key rides along). */
export async function unlockWithDevice(code: string): Promise<Reply<{ state: string }>> {
  const k = readDeviceKey()
  if (!k) return { ok: false, code: 'phone-unknown', sentence: '', status: 0 }
  const r = await vaultPost<{ state: string }>('/api/vault/phone/unlock', { kind: 'device', ...k, code })
  // A key the service no longer knows (switch turned off, phone removed) is dead weight: forget it.
  if (!r.ok && r.code === 'phone-unknown') writeDeviceKey(null)
  return r
}

// ── registering this phone: ask here, approve on the computer ─────────────────────────────────

export const requestEnrol = (kind: 'passkey' | 'device', label: string, code: string) =>
  vaultPost<{ id: string; match: string; expiresInMs: number }>('/api/vault/phone/enrol/request', { kind, label, code })
export const enrolStatus = (id: string) =>
  vaultGet<{ status: 'pending' | 'approved' | 'denied' | 'expired' }>(`/api/vault/phone/enrol/status?id=${encodeURIComponent(id)}`)

/** After the computer approved: create the passkey, then ask it for its PRF output (the way to OPEN). */
export async function enrolPasskey(requestId: string): Promise<Reply<{ unlockable: boolean; sentence?: string }>> {
  type Begin = { options: { challengeId: string; challenge: string; rp: { id: string; name: string }; user: { id: string; name: string; displayName: string }; pubKeyCredParams: { type: 'public-key'; alg: number }[] } }
  const b = await vaultPost<Begin>('/api/vault/personal/mobile/register/begin', { requestId })
  if (!b.ok) return b
  const o = b.options
  let cred: PublicKeyCredential | null
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64urlBytes(o.challenge), rp: o.rp, user: { ...o.user, id: b64urlBytes(o.user.id) }, pubKeyCredParams: o.pubKeyCredParams,
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' }, attestation: 'none', timeout: 60_000,
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null
  } catch { cred = null }
  if (!cred) return cancelled()
  const r = cred.response as AuthenticatorAttestationResponse
  const pk = r.getPublicKey?.()
  if (!pk) return { ok: false, code: 'passkey-unsupported', sentence: '', status: 0 }
  const f = await vaultPost<{ id: string; prf: { challengeId: string; challenge: string; salt: string } }>('/api/vault/personal/mobile/register/finish', {
    requestId, challengeId: o.challengeId, clientDataJSON: b64urlEncode(r.clientDataJSON), authenticatorData: b64urlEncode(r.getAuthenticatorData()),
    publicKey: b64urlEncode(pk), alg: r.getPublicKeyAlgorithm(), credentialId: b64urlEncode(cred.rawId),
  })
  if (!f.ok) return f
  const a = await assertWithPrf(f.prf.challenge, o.rp.id, [{ id: f.id, salt: f.prf.salt }])
  if (!a) return cancelled()
  return vaultPost<{ unlockable: boolean; sentence?: string }>('/api/vault/phone/enrol/passkey-key', { challengeId: f.prf.challengeId, ...a, ...(a.prf ? { prf: a.prf } : {}) })
}

/** After the computer approved: take the device key and keep it in this browser. */
export async function enrolDevice(requestId: string): Promise<Reply<{ stored: boolean }>> {
  const r = await vaultPost<DeviceKey>('/api/vault/phone/enrol/device', { requestId })
  if (!r.ok) return r
  return { ok: true, stored: writeDeviceKey({ deviceId: r.deviceId, deviceSecret: r.deviceSecret }) }
}

// ── the computer's side ───────────────────────────────────────────────────────────────────────

export interface PhoneRequest { id: string; label: string; kind: 'passkey' | 'device'; match: string; createdAt: string; expiresInMs: number }
export const phoneRequests = () => vaultGet<{ requests: PhoneRequest[] }>('/api/vault/phone/requests')
export const decidePhoneRequest = (id: string, approve: boolean) => vaultPost('/api/vault/phone/requests/decide', { id, approve })
export const removeDevice = (id: string, code?: string) => vaultPost('/api/vault/phone/devices/remove', { id, ...(code ? { code } : {}) })
export const clearStalePhones = (code?: string) => vaultPost<{ removed: number }>('/api/vault/phone/stale/clear', code ? { code } : {})
