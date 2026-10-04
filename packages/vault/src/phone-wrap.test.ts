import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { isPhoneWrap, newDeviceSecret, newPhoneSalt, unwrapForPhone, wrapForPhone } from './phone-wrap'

const dek = new Uint8Array(randomBytes(32))
const kid = 'k-1'
const make = (secret = newDeviceSecret(), kind: 'device' | 'passkey' = 'device', id = 'dev-a') =>
  ({ secret, w: wrapForPhone({ dek, kid, kind, id, secret, salt: newPhoneSalt(), createdAt: 'now', ...(kind === 'passkey' ? { passkey: { spki: 'x', alg: -7, rpId: 'r', signCount: 0 } } : {}) }) })

describe('a phone copy of the data key', () => {
  test('opens with its own secret and the right kid', () => {
    const { secret, w } = make()
    expect(Buffer.from(unwrapForPhone(w, secret, kid)!)).toEqual(Buffer.from(dek))
  })
  test('the wrapper holds no plaintext key and no secret', () => {
    const { secret, w } = make()
    const json = JSON.stringify(w)
    expect(json).not.toContain(Buffer.from(dek).toString('base64url'))
    expect(json).not.toContain(Buffer.from(secret).toString('base64url'))
  })
  test('a wrong secret, a rotated kid, a moved id or a changed kind open nothing', () => {
    const { secret, w } = make()
    expect(unwrapForPhone(w, newDeviceSecret(), kid)).toBeNull()
    expect(unwrapForPhone(w, secret, 'k-2')).toBeNull()
    expect(unwrapForPhone({ ...w, id: 'dev-b' }, secret, kid)).toBeNull()
    expect(unwrapForPhone({ ...w, kind: 'passkey' }, secret, kid)).toBeNull()
    expect(unwrapForPhone({ ...w, kid: 'k-2' }, secret, 'k-2')).toBeNull()
  })
  test('a short secret is refused at both ends', () => {
    expect(() => wrapForPhone({ dek, kid, kind: 'device', id: 'x', secret: new Uint8Array(16), salt: newPhoneSalt(), createdAt: 'n' })).toThrow()
    const { w } = make()
    expect(unwrapForPhone(w, new Uint8Array(16), kid)).toBeNull()
  })
  test('the shape check keeps only well-formed records, and a passkey record must carry its public key', () => {
    expect(isPhoneWrap(make().w)).toBe(true)
    expect(isPhoneWrap(make(undefined, 'passkey').w)).toBe(true)
    const { passkey: _p, ...noKey } = make(undefined, 'passkey').w
    expect(isPhoneWrap(noKey)).toBe(false)
    expect(isPhoneWrap({ ...make().w, kind: 'other' })).toBe(false)
    expect(isPhoneWrap(null)).toBe(false)
  })
})
