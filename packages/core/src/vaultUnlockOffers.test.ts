import { describe, expect, test } from 'bun:test'
import { enrolKinds, unlockOffers, type UnlockFacts } from './vaultUnlockOffers'

const base: UnlockFacts = { loopback: false, secure: false, passkeys: 0, codeOnly: null, deviceKey: false }

describe('the unlock gate table, row by origin', () => {
  const rows: Array<[string, Partial<UnlockFacts>, string[]]> = [
    ['this computer (loopback) → Hello, whatever else is true', { loopback: true, secure: true, passkeys: 2, deviceKey: true, codeOnly: true }, ['hello']],
    ['phone, http, nothing registered → register + the https line', {}, ['enrol', 'https']],
    ['phone, https, nothing registered → register', { secure: true }, ['enrol']],
    ['phone, https, a passkey → passkey', { secure: true, passkeys: 1 }, ['passkey']],
    ['phone, http, a passkey (unusable without https) → register + https', { passkeys: 1 }, ['enrol', 'https']],
    ['phone, http, device key, switch unknown (locked) → code alone', { deviceKey: true }, ['code-only']],
    ['phone, http, device key, switch known OFF → not offered', { deviceKey: true, codeOnly: false }, ['enrol', 'https']],
    ['phone, https, passkey + device key → passkey first, then code alone', { secure: true, passkeys: 1, deviceKey: true, codeOnly: true }, ['passkey', 'code-only']],
    ['phone, switch on but THIS phone never approved → register', { secure: true, codeOnly: true }, ['enrol']],
  ]
  for (const [name, f, want] of rows) test(name, () => expect(unlockOffers({ ...base, ...f })).toEqual(want as never))

  test('Hello is never offered off loopback, in any combination', () => {
    for (const secure of [true, false]) for (const passkeys of [0, 1]) for (const deviceKey of [true, false]) for (const codeOnly of [true, false, null]) {
      const o = unlockOffers({ loopback: false, secure, passkeys, deviceKey, codeOnly })
      expect(o).not.toContain('hello')
      expect(o.length).toBeGreaterThan(0)
    }
  })
})

describe('what a phone may register', () => {
  test('passkey needs https; a device key needs the switch', () => {
    expect(enrolKinds({ secure: false, codeOnly: false })).toEqual([])
    expect(enrolKinds({ secure: true, codeOnly: false })).toEqual(['passkey'])
    expect(enrolKinds({ secure: false, codeOnly: true })).toEqual(['device'])
    expect(enrolKinds({ secure: true, codeOnly: true })).toEqual(['passkey', 'device'])
  })
})
