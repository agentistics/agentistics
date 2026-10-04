import { describe, expect, test } from 'bun:test'
import { b64urlBytes, b64urlEncode, hasPasskeyHere, passkeySupport } from './passkey'
import { PERSONAL_TEXT } from './personalText'

describe('the phone passkey, browser side', () => {
  test('WebAuthn needs a secure context, and the page says why in words', () => {
    expect(passkeySupport({ isSecureContext: false, PublicKeyCredential: class {} })).toBe('insecure')
    expect(passkeySupport({ isSecureContext: true })).toBe('unsupported')
    expect(passkeySupport({ isSecureContext: true, PublicKeyCredential: class {} })).toBe('ok')
    expect(PERSONAL_TEXT.phoneInsecure.pt).toContain('https')
    expect(PERSONAL_TEXT.phoneInsecure.pt).not.toMatch(/`/)
  })
  test('base64url round-trips arbitrary bytes', () => {
    const b = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255, 62, 63])
    expect(Array.from(b64urlBytes(b64urlEncode(b)))).toEqual(Array.from(b))
    expect(b64urlEncode(b)).not.toMatch(/[+/=]/)
  })
  test('a passkey answers only on its own host', () => {
    const s = { passkeys: [{ id: 'a', label: 'p', rpId: 'box.ts.net', createdAt: '' }], codeReveal: false, loopback: false }
    expect(hasPasskeyHere(s, 'box.ts.net')).toBe(true)
    expect(hasPasskeyHere(s, '192.168.0.10')).toBe(false)
    expect(hasPasskeyHere(null, 'box.ts.net')).toBe(false)
  })
})
