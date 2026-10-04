/** A software authenticator (real ES256 / RS256 keys) driving the verifier through every refusal. */
import { describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { ES256, RS256, b64url, originMatchesRp, parseAuthData, verifyAssertion, verifyRegistration, type StoredPasskey } from './webauthn'

const RP = 'box.tail1234.ts.net', ORIGIN = `https://${RP}`
const h = (s: string) => createHash('sha256').update(s).digest()
function authData(o: { rpId?: string; up?: boolean; uv?: boolean; count?: number; credId?: Uint8Array }): Uint8Array {
  const flags = (o.up === false ? 0 : 1) | (o.uv === false ? 0 : 4) | (o.credId ? 0x40 : 0)
  const c = Buffer.alloc(4); c.writeUInt32BE(o.count ?? 0)
  const parts = [h(o.rpId ?? RP), Buffer.from([flags]), c]
  if (o.credId) { const l = Buffer.alloc(2); l.writeUInt16BE(o.credId.length); parts.push(Buffer.alloc(16), l, Buffer.from(o.credId)) }
  return new Uint8Array(Buffer.concat(parts))
}
const cdj = (type: string, challenge: Uint8Array, origin = ORIGIN) => b64url(new TextEncoder().encode(JSON.stringify({ type, challenge: b64url(challenge), origin })))

function authenticator(alg: number) {
  const kp = alg === ES256 ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: 2048 })
  const credId = new Uint8Array(randomBytes(16))
  let count = 0
  return {
    credId,
    register(challenge: Uint8Array) {
      return { clientDataJSON: cdj('webauthn.create', challenge), authenticatorData: b64url(authData({ credId, count })), publicKey: b64url(new Uint8Array(kp.publicKey.export({ format: 'der', type: 'spki' }))), alg, credentialId: b64url(credId) }
    },
    assert(challenge: Uint8Array, o: { origin?: string; uv?: boolean; rpId?: string; countDelta?: number; tamper?: boolean } = {}) {
      count += o.countDelta ?? 1
      const ad = authData({ rpId: o.rpId, uv: o.uv, count })
      const c = cdj('webauthn.get', challenge, o.origin)
      const data = Buffer.concat([Buffer.from(ad), createHash('sha256').update(Buffer.from(c, 'base64url')).digest()])
      const sig = alg === ES256 ? sign('sha256', data, { key: kp.privateKey, dsaEncoding: 'der' }) : sign('sha256', data, kp.privateKey)
      if (o.tamper) ad[36] = (ad[36] ?? 0) ^ 0x7f
      return { credentialId: b64url(credId), clientDataJSON: c, authenticatorData: b64url(ad), signature: b64url(new Uint8Array(sig)) }
    },
  }
}

for (const alg of [ES256, RS256]) {
  describe(`passkey ${alg === ES256 ? 'ES256' : 'RS256'}`, () => {
    const a = authenticator(alg)
    const regCh = new Uint8Array(randomBytes(32))
    const reg = verifyRegistration({ ...a.register(regCh), expectedChallenge: regCh, expectedOrigin: ORIGIN, rpId: RP })
    test('registers', () => { expect(reg.ok).toBe(true) })
    const store = (): StoredPasskey[] => (reg.ok ? [{ ...reg.passkey, label: 'phone', createdAt: '' }] : [])
    test('a good assertion passes and returns the new counter', () => {
      const ch = new Uint8Array(randomBytes(32))
      const r = verifyAssertion({ ...a.assert(ch), expectedChallenge: ch, expectedOrigin: ORIGIN, rpId: RP, passkeys: store() })
      expect(r).toMatchObject({ ok: true })
    })
    test('every refusal names its check', () => {
      const ch = new Uint8Array(randomBytes(32)), other = new Uint8Array(randomBytes(32))
      const base = { expectedChallenge: ch, expectedOrigin: ORIGIN, rpId: RP, passkeys: store() }
      expect(verifyAssertion({ ...a.assert(other), ...base })).toEqual({ ok: false, code: 'challenge' })
      expect(verifyAssertion({ ...a.assert(ch, { origin: 'https://evil.example' }), ...base })).toEqual({ ok: false, code: 'origin' })
      expect(verifyAssertion({ ...a.assert(ch, { uv: false }), ...base })).toEqual({ ok: false, code: 'no-verification' })
      expect(verifyAssertion({ ...a.assert(ch, { rpId: 'evil.example' }), ...base })).toEqual({ ok: false, code: 'rp-id' })
      expect(verifyAssertion({ ...a.assert(ch, { tamper: true }), ...base })).toEqual({ ok: false, code: 'signature' })
      expect(verifyAssertion({ ...a.assert(ch), ...base, rpId: 'other.host' })).toEqual({ ok: false, code: 'rp-id' })
      expect(verifyAssertion({ ...a.assert(ch), ...base, passkeys: [] })).toEqual({ ok: false, code: 'unknown-credential' })
    })
    test('a counter that does not move forward is a clone', () => {
      const ch = new Uint8Array(randomBytes(32))
      const keys = store().map(k => ({ ...k, signCount: 1000 }))
      expect(verifyAssertion({ ...a.assert(ch), expectedChallenge: ch, expectedOrigin: ORIGIN, rpId: RP, passkeys: keys })).toEqual({ ok: false, code: 'counter' })
    })
  })
}

describe('registration refusals', () => {
  const a = authenticator(ES256)
  const ch = new Uint8Array(randomBytes(32))
  test('wrong challenge, wrong origin, no UV, wrong type', () => {
    const r = a.register(ch)
    expect(verifyRegistration({ ...r, expectedChallenge: new Uint8Array(32), expectedOrigin: ORIGIN, rpId: RP })).toEqual({ ok: false, code: 'challenge' })
    expect(verifyRegistration({ ...r, expectedChallenge: ch, expectedOrigin: 'https://x', rpId: RP })).toEqual({ ok: false, code: 'origin' })
    expect(verifyRegistration({ ...r, authenticatorData: b64url(authData({ credId: a.credId, uv: false })), expectedChallenge: ch, expectedOrigin: ORIGIN, rpId: RP })).toEqual({ ok: false, code: 'no-verification' })
    expect(verifyRegistration({ ...r, alg: -8, expectedChallenge: ch, expectedOrigin: ORIGIN, rpId: RP })).toEqual({ ok: false, code: 'alg' })
    expect(verifyRegistration({ ...r, credentialId: b64url(new Uint8Array(16)), expectedChallenge: ch, expectedOrigin: ORIGIN, rpId: RP })).toEqual({ ok: false, code: 'credential-id' })
  })
  test('authData parsing and origins', () => {
    expect(parseAuthData(new Uint8Array(10))).toBeNull()
    expect(originMatchesRp('https://box.tail1234.ts.net:47292', RP)).toBe(true)
    expect(originMatchesRp('http://box.tail1234.ts.net:47292', RP)).toBe(false)
    expect(originMatchesRp('http://localhost:47292', 'localhost')).toBe(true)
  })
})
