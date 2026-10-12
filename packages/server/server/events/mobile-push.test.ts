import { createECDH } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { deriveWebPushKeys, encryptWebPushPayload, mobileEvents, parseMobileStore, sendMobilePush, vapidJwt, type MobileSubscription } from './mobile-push'
import type { SessionEvent } from './event-types'

const event = (id: string, kind: SessionEvent['kind'] = 'waiting'): SessionEvent => ({
  v: 1, seq: 1, id, conversationId: `conversation-${id}`, kind, at: '2026-10-11T12:00:00.000Z', cwd: '/tmp/project', source: 'native',
})
const sub = (id: string, kind: MobileSubscription['kind'] = 'mobile'): MobileSubscription => ({
  id, endpoint: `https://push.example/${id}`, keys: { p256dh: 'key', auth: 'auth' }, kind, enabled: true, createdAt: '',
})

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
})
