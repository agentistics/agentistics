import { createECDH } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { AGENTISTICS_DATA_DIR } from '../config'
import { deriveWebPushKeys, encryptWebPushPayload, ensureVapidPublicKey, isMobileUserAgent, mobileEvents, parseMobileStore, sendMobilePush, vapidJwt, webPushTransport, MOBILE_SUBSCRIPTIONS_FILE, type MobileSubscription } from './mobile-push'
import type { SessionEvent } from './event-types'

const event = (id: string, kind: SessionEvent['kind'] = 'waiting'): SessionEvent => ({
  v: 1, seq: 1, id, conversationId: `conversation-${id}`, kind, at: '2026-10-11T12:00:00.000Z', cwd: '/tmp/project', source: 'native',
})
const sub = (id: string, kind: MobileSubscription['kind'] = 'mobile'): MobileSubscription => ({
  id, endpoint: `https://push.example/${id}`, keys: { p256dh: 'key', auth: 'auth' }, kind, enabled: true, createdAt: '',
})
const validKeys = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
}
const pushSub = (id: string): MobileSubscription => ({ ...sub(id), keys: validKeys })

describe('mobile push', () => {
  test('subscription store drops malformed rows and defaults kind to mobile', () => {
    const parsed = parseMobileStore({ subscriptions: [{ id: 'a', endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } }, { id: 'bad' }] })
    expect(parsed.subscriptions).toHaveLength(1)
    expect(parsed.subscriptions[0]?.kind).toBe('mobile')
    expect(parsed.subscriptions[0]?.enabled).toBe(true)
  })

  test('only waiting events not muted by conversation key are mobile candidates', () => {
    expect(mobileEvents([event('one'), event('two', 'working'), event('three', 'waiting-approval')], new Set(['conversation-one'])).map(e => e.id)).toEqual(['three'])
  })

  test('sender never sends desktop subscriptions', async () => {
    const sent: string[] = []
    const result = await sendMobilePush([event('one')], [sub('mobile'), sub('desktop', 'desktop')], new Set(), async s => { sent.push(s.id) })
    expect(sent).toEqual(['mobile'])
    expect(result).toEqual({ sent: 1, failed: 0 })
  })

  test('classifies phone and tablet user agents, but not desktop browsers', () => {
    expect(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe(true)
    expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36')).toBe(true)
    expect(isMobileUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe(false)
    expect(isMobileUserAgent(null)).toBe(false)
  })

  test('aes128gcm matches RFC 8291 Appendix A, including intermediate values', () => {
    const receiverPublic = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
    const auth = 'BTBZMqHH6r4Tts7J_aSIgg'
    const salt = 'DGv6ra1nlYgDCS1FRnbzlw'
    const derived = deriveWebPushKeys(receiverPublic, auth, { salt: Buffer.from(salt, 'base64url'), ephemeralPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') })
    expect(derived.ecdhSecret.toString('base64url')).toBe('kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs')
    expect(derived.prkKey.toString('base64url')).toBe('Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k')
    expect(derived.ikm.toString('base64url')).toBe('S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg')
    expect(derived.prk.toString('base64url')).toBe('09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc')
    expect(derived.cek.toString('base64url')).toBe('oIhVW04MRdy2XN9CiKLxTg')
    expect(derived.nonce.toString('base64url')).toBe('4h_95klXJ5E_qnoN')
    const encrypted = encryptWebPushPayload(
      new TextEncoder().encode('When I grow up, I want to be a watermelon'), receiverPublic, auth,
      { salt: Buffer.from(salt, 'base64url'), ephemeralPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') },
    )
    expect(encrypted.toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN')
  })

  test('VAPID JWT has RFC 8292 claims and an ES256 raw signature', () => {
    const key = createECDH('prime256v1')
    key.setPrivateKey(Buffer.alloc(32, 1))
    const publicKey = key.getPublicKey().toString('base64url')
    const jwt = vapidJwt('https://push.example/send', publicKey, Buffer.alloc(32, 1).toString('base64url'), 1_700_000_000)
    const [encodedHeader, encodedClaims, encodedSignature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(encodedHeader!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(Buffer.from(encodedClaims!, 'base64url').toString()).sub).not.toContain('localhost')
    expect(Buffer.from(encodedSignature!, 'base64url')).toHaveLength(64)
  })

  test('creates a VAPID key once and returns the same public key when reopened', async () => {
    const first = await ensureVapidPublicKey()
    const second = await ensureVapidPublicKey()
    expect(first).toBe(second)
    expect(first).not.toContain('.')
    const sealed = await readFile(join(AGENTISTICS_DATA_DIR, 'mobile-push-vapid.sealed'))
    expect(sealed?.toString()).not.toContain('privateKey')
  })

  test('web push request uses VAPID, TTL, and an aes128gcm record', async () => {
    await ensureVapidPublicKey()
    let request: { url: string; init?: RequestInit } | undefined
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init }
      return new Response(null, { status: 201 })
    }
    await webPushTransport(pushSub('request'), { title: 'Waiting', body: 'Approve', sessionId: 's1' }, fetchImpl)
    expect(request?.url).toBe('https://push.example/request')
    expect(request?.init?.method).toBe('POST')
    const headers = new Headers(request?.init?.headers)
    expect(headers.get('TTL')).toBe('86400')
    expect(headers.get('Content-Encoding')).toBe('aes128gcm')
    expect(headers.get('Authorization')).toMatch(/^vapid t=[^.]+\.[^.]+\.[^.]+, k=[A-Za-z0-9_-]+$/)
    const body = Buffer.from(await new Response(request?.init?.body).arrayBuffer())
    expect(body.length).toBeGreaterThan(16 + 4 + 1 + 65 + 16)
    expect(body.subarray(16, 20).readUInt32BE()).toBe(4096)
    expect(body[20]).toBe(65)
  })

  test('removes subscriptions for 404 and 410, but keeps them for 500', async () => {
    for (const status of [404, 410, 500]) {
      const target = pushSub(`status-${status}`)
      const other = pushSub(`other-${status}`)
      await Bun.write(MOBILE_SUBSCRIPTIONS_FILE, JSON.stringify({ subscriptions: [target, other] }))
      const call = webPushTransport(target, { title: 'Waiting', body: 'Approve', sessionId: 's1' }, async () => new Response(null, { status }))
      if (status === 500) await expect(call).rejects.toThrow('HTTP 500')
      else await expect(call).rejects.toThrow(`HTTP ${status}`)
      const remaining = await readFile(MOBILE_SUBSCRIPTIONS_FILE, 'utf8').then(raw => parseMobileStore(JSON.parse(raw)).subscriptions)
      expect(remaining.map(item => item.id)).toEqual(status === 500 ? [target.id, other.id] : [other.id])
    }
    await rm(MOBILE_SUBSCRIPTIONS_FILE, { force: true })
  })
})
