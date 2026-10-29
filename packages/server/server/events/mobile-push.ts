/** Mobile Web Push subscriptions and delivery.
 *
 * Subscription endpoints are device credentials and are kept separately from preferences. The
 * VAPID private key is the only signing secret and is sealed through the existing vault service;
 * it is never returned by an HTTP route or written as JSON.
 */
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { AGENTISTICS_DATA_DIR } from '../config'
import { durableWriteFile } from '../durable-write'
import { sealMachineBoundVapid, withMachineBoundVapid, withSecret } from '../vault/service'
import type { SessionEvent } from './event-types'
import { redactSecrets } from '@agentistics/core'
import { desktopText } from './notify-text'

export type MobileSubscription = {
  id: string
  endpoint: string
  keys: { p256dh: string; auth: string }
  kind: 'mobile' | 'desktop'
  enabled: boolean
  createdAt: string
}

export type MobileSubscriptionStore = { subscriptions: MobileSubscription[] }
export const EMPTY_MOBILE_STORE: MobileSubscriptionStore = { subscriptions: [] }
export const MOBILE_SUBSCRIPTIONS_FILE = process.env.AGENTISTICS_MOBILE_SUBSCRIPTIONS_FILE
  ?? join(AGENTISTICS_DATA_DIR, 'mobile-push-subscriptions.json')
const VAPID_FILE = join(AGENTISTICS_DATA_DIR, 'mobile-push-vapid.sealed')
const VAPID_PURPOSE = 'mobile-push-vapid'
const VAPID_NAME = 'default'

export function parseMobileStore(raw: unknown): MobileSubscriptionStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_MOBILE_STORE }
  const list = (raw as { subscriptions?: unknown }).subscriptions
  if (!Array.isArray(list)) return { ...EMPTY_MOBILE_STORE }
  return { subscriptions: list.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const o = item as Record<string, unknown>
    const keys = o.keys as Record<string, unknown> | undefined
    if (typeof o.id !== 'string' || !o.id || typeof o.endpoint !== 'string' || !/^https:\/\//.test(o.endpoint)
      || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return []
    return [{ id: o.id, endpoint: o.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth },
      kind: o.kind === 'desktop' ? 'desktop' as const : 'mobile' as const,
      enabled: o.enabled !== false, createdAt: typeof o.createdAt === 'string' ? o.createdAt : '' }]
  }) }
}

/** Classifies the browser making the registration request; the request body is never trusted. */
export function isMobileUserAgent(userAgent: string | null): boolean {
  return /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(userAgent ?? '')
}

export async function readMobileSubscriptions(file = MOBILE_SUBSCRIPTIONS_FILE): Promise<MobileSubscription[]> {
  try {
    if (!existsSync(file)) return []
    return parseMobileStore(JSON.parse(await readFile(file, 'utf8')) as unknown).subscriptions
  } catch { return [] }
}

export async function writeMobileSubscriptions(subscriptions: readonly MobileSubscription[], file = MOBILE_SUBSCRIPTIONS_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await durableWriteFile(file, `${JSON.stringify({ subscriptions }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export function upsertMobileSubscription(store: MobileSubscriptionStore, sub: MobileSubscription): MobileSubscriptionStore {
  return { subscriptions: [...store.subscriptions.filter(s => s.id !== sub.id && s.endpoint !== sub.endpoint), sub] }
}

export function removeMobileSubscription(store: MobileSubscriptionStore, id: string): MobileSubscriptionStore {
  return { subscriptions: store.subscriptions.filter(s => s.id !== id) }
}

export function mobileEvents(events: readonly SessionEvent[], muted: ReadonlySet<string>): SessionEvent[] {
  return events.filter(e => !muted.has(e.conversationId ?? e.id) && (e.kind === 'waiting' || e.kind === 'waiting-approval'))
}

export type WebPushFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type PushTransport = (sub: MobileSubscription, payload: { title: string; body: string; sessionId: string }, fetchImpl?: WebPushFetch) => Promise<void>

const textEncoder = new TextEncoder()
const VAPID_SUBJECT = process.env.AGENTISTICS_VAPID_SUBJECT ?? 'https://github.com/agentistics/agentistics'
const PUSH_TTL = 86400

function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64url') }
function unb64(value: string): Buffer { return Buffer.from(value, 'base64url') }
function concat(...parts: Uint8Array[]): Buffer { return Buffer.concat(parts.map(part => Buffer.from(part))) }
function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Buffer { return createHmac('sha256', salt).update(ikm).digest() }
function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  const out: Buffer[] = []; let previous = Buffer.alloc(0)
  for (let counter = 1; Buffer.concat(out).length < length; counter++) {
    previous = createHmac('sha256', prk).update(concat(previous, info, Buffer.from([counter]))).digest()
    out.push(previous)
  }
  return Buffer.concat(out).subarray(0, length)
}

/** The RFC 8291 aes128gcm content encoding (one final record). Exported for the RFC vector test. */
export function encryptWebPushPayload(
  payload: Uint8Array, p256dh: string, auth: string, options: { salt?: Uint8Array; ephemeralPrivateKey?: Uint8Array } = {},
): Buffer {
  const derived = deriveWebPushKeys(p256dh, auth, options)
  const cipher = createCipheriv('aes-128-gcm', derived.cek, derived.nonce)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const recordSize = 4096
  return concat(derived.salt, Buffer.from([(recordSize >>> 24) & 255, (recordSize >>> 16) & 255, (recordSize >>> 8) & 255, recordSize & 255]), Buffer.from([derived.ephemeralPublic.length]), derived.ephemeralPublic, encrypted)
}

/** RFC 8291 Appendix A key schedule, exposed so the normative intermediate values can be tested. */
export function deriveWebPushKeys(
  p256dh: string, auth: string, options: { salt?: Uint8Array; ephemeralPrivateKey?: Uint8Array } = {},
): { ephemeralPublic: Buffer; salt: Buffer; ecdhSecret: Buffer; prkKey: Buffer; ikm: Buffer; prk: Buffer; cek: Buffer; nonce: Buffer } {
  const receiver = unb64(p256dh)
  const authSecret = unb64(auth)
  if (receiver.length !== 65 || receiver[0] !== 4 || authSecret.length !== 16) throw new Error('invalid Web Push subscription keys')
  const ephemeral = createECDH('prime256v1')
  ephemeral.setPrivateKey(options.ephemeralPrivateKey ? Buffer.from(options.ephemeralPrivateKey) : randomBytes(32))
  const ephemeralPublic = ephemeral.getPublicKey(undefined, 'uncompressed')
  const sharedSecret = ephemeral.computeSecret(receiver)
  const keyInfo = concat(textEncoder.encode('WebPush: info\0'), receiver, ephemeralPublic)
  const ikm = hkdfExpand(hkdfExtract(authSecret, sharedSecret), keyInfo, 32)
  const salt = options.salt ? Buffer.from(options.salt) : randomBytes(16)
  if (salt.length !== 16) throw new Error('invalid Web Push salt')
  const prk = hkdfExtract(salt, ikm)
  const cek = hkdfExpand(prk, textEncoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdfExpand(prk, textEncoder.encode('Content-Encoding: nonce\0'), 12)
  return { ephemeralPublic, salt, ecdhSecret: sharedSecret, prkKey: hkdfExtract(authSecret, sharedSecret), ikm, prk, cek, nonce }
}

export function vapidJwt(endpoint: string, publicKey: string, privateD: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64(textEncoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64(textEncoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + 43200, sub: VAPID_SUBJECT })))
  const signingInput = `${header}.${claims}`
  const publicBytes = unb64(publicKey)
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) throw new Error('invalid VAPID public key')
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privateD, x: b64(publicBytes.subarray(1, 33)), y: b64(publicBytes.subarray(33)) }, format: 'jwk' })
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${b64(signature)}`
}

type VapidRecord = { publicKey: string; privateKey: string; curve?: string }

async function readMachineVapid(): Promise<VapidRecord | null> {
  const result = await withMachineBoundVapid(VAPID_FILE, VAPID_NAME, bytes => JSON.parse(new TextDecoder().decode(bytes)) as VapidRecord)
  return result.ok ? result.value : null
}

async function readLegacyVapid(): Promise<VapidRecord | null> {
  const result = await withSecret(VAPID_PURPOSE, VAPID_NAME, VAPID_FILE, bytes => JSON.parse(new TextDecoder().decode(bytes)) as VapidRecord)
  if (!result.ok) return null
  // The old file has the same path and public key. Re-seal it in the machine scope while the
  // human vault is readable, so future phone registrations and sends need no unlock.
  const body = new TextEncoder().encode(JSON.stringify(result.value))
  try { await sealMachineBoundVapid(VAPID_FILE, VAPID_NAME, body) } finally { body.fill(0) }
  return result.value
}

async function loadVapid(): Promise<{ publicKey: string; privateD: string }> {
  const value = await readMachineVapid() ?? await readLegacyVapid()
  if (!value) throw new Error('VAPID key is unavailable on this machine')
  return { publicKey: value.publicKey, privateD: value.privateKey }
}

/** Sends an encrypted Web Push request and removes endpoints that the push service no longer knows. */
export const webPushTransport: PushTransport = async (sub, payload, fetchImpl: WebPushFetch = fetch) => {
  const vapid = await loadVapid()
  const body = encryptWebPushPayload(textEncoder.encode(JSON.stringify(payload)), sub.keys.p256dh, sub.keys.auth)
  const response = await fetchImpl(sub.endpoint, {
    method: 'POST', body: body as unknown as BodyInit,
    headers: {
      Authorization: `vapid t=${vapidJwt(sub.endpoint, vapid.publicKey, vapid.privateD)}, k=${vapid.publicKey}`,
      TTL: String(PUSH_TTL), Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
    },
  })
  if (response.status === 404 || response.status === 410) {
    const current = await readMobileSubscriptions()
    await writeMobileSubscriptions(current.filter(item => item.id !== sub.id))
  }
  if (!response.ok) throw new Error(`Web Push endpoint returned HTTP ${response.status}`)
}

/** Sends only mobile subscriptions. Desktop rows are intentionally ignored here. */
export async function sendMobilePush(
  events: readonly SessionEvent[], subscriptions: readonly MobileSubscription[], muted: ReadonlySet<string>,
  transport: PushTransport,
): Promise<{ sent: number; failed: number }> {
  const wanted = mobileEvents(events, muted)
  let sent = 0; let failed = 0
  for (const sub of subscriptions) {
    if (sub.kind !== 'mobile' || !sub.enabled) continue
    for (const event of wanted) {
      try {
        // The body carries the session's last screen line; a pasted credential must not reach a lock screen.
        const text = desktopText(event)
        await transport(sub, { title: redactSecrets(text.title), body: redactSecrets(text.body), sessionId: event.id })
        sent++
      } catch { failed++ }
    }
  }
  return { sent, failed }
}

/** Sends a plain notice (no session event) to enabled mobile subscriptions. Best-effort: never throws. */
export async function sendMobileNotice(
  title: string, body: string, subscriptions: readonly MobileSubscription[], transport: PushTransport,
): Promise<{ sent: number; failed: number }> {
  let sent = 0; let failed = 0
  for (const sub of subscriptions) {
    if (sub.kind !== 'mobile' || !sub.enabled) continue
    try { await transport(sub, { title, body, sessionId: '' }); sent++ } catch { failed++ }
  }
  return { sent, failed }
}

/** Creates the key material once and seals it with the app vault. The return value is public only. */
export async function ensureVapidPublicKey(): Promise<string> {
  const existing = await readMachineVapid() ?? await readLegacyVapid()
  if (existing) return existing.publicKey
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privateJwk = pair.privateKey.export({ format: 'jwk' }) as JsonWebKey
  const publicJwk = pair.publicKey.export({ format: 'jwk' }) as JsonWebKey
  const publicKey = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).subarray(-65).toString('base64url')
  const body = new TextEncoder().encode(JSON.stringify({ publicKey, privateKey: privateJwk.d, curve: publicJwk.crv }))
  try { await sealMachineBoundVapid(VAPID_FILE, VAPID_NAME, body) } finally { body.fill(0) }
  return publicKey
}

/**
 * Default transport seam. A deployment can provide a real Web Push implementation without
 * changing routing or notification policy. Until configured, this deliberately fails closed.
 */
export const unavailablePushTransport = webPushTransport

export function mobilePushPayload(event: SessionEvent): { title: string; body: string; sessionId: string } {
  const text = desktopText(event)
  return { title: text.title, body: text.body, sessionId: event.id }
}
