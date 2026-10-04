import { describe, expect, test } from 'bun:test'
import { isVaultLockedRefusal, offersHere, parseDeviceKey, prfFirst } from './phoneVault'

const facts = { loopback: false, secure: true, passkeys: 0, devices: ['dev-abcd1234'], codeOnly: null as boolean | null }
const key = { deviceId: 'dev-abcd1234', deviceSecret: 'A'.repeat(43) }

describe('the phone page offers', () => {
  test('Hello only on this computer', () => expect(offersHere({ ...facts, loopback: true }, key)).toEqual(['hello']))
  test('code alone only when THIS browser holds a key the service still knows', () => {
    expect(offersHere(facts, key)).toEqual(['code-only'])
    expect(offersHere(facts, { ...key, deviceId: 'dev-other999' })).toEqual(['enrol'])
    expect(offersHere(facts, null)).toEqual(['enrol'])
  })
  test('a passkey over https', () => expect(offersHere({ ...facts, passkeys: 1, devices: [] }, null)).toEqual(['passkey']))
})

describe('the device key in storage', () => {
  test('round-trips a well-formed key and refuses anything else', () => {
    expect(parseDeviceKey(JSON.stringify(key))).toEqual(key)
    expect(parseDeviceKey(null)).toBeNull()
    expect(parseDeviceKey('{')).toBeNull()
    expect(parseDeviceKey(JSON.stringify({ deviceId: 'x', deviceSecret: key.deviceSecret }))).toBeNull()
    expect(parseDeviceKey(JSON.stringify({ deviceId: key.deviceId, deviceSecret: 'short' }))).toBeNull()
  })
})

describe('the PRF output', () => {
  test('32 bytes come back as base64url; anything else is "no PRF"', () => {
    expect(prfFirst({ prf: { results: { first: new Uint8Array(32).buffer } } })).toBe('A'.repeat(43))
    expect(prfFirst({ prf: { results: { first: new Uint8Array(32) } } })).toBe('A'.repeat(43))
    expect(prfFirst({ prf: { results: { first: new Uint8Array(16).buffer } } })).toBeNull()
    expect(prfFirst({ prf: { enabled: true } })).toBeNull()
    expect(prfFirst({})).toBeNull()
    expect(prfFirst(null)).toBeNull()
  })
})

describe('a locked vault, as other parts of the product say it', () => {
  test('the vault codes and the engine\'s vault_* codes', () => {
    for (const c of ['locked', 'vault-locked', 'auto-locked', 'vault_locked', 'vault_auto_locked']) expect(isVaultLockedRefusal(c)).toBe(true)
    for (const c of ['vault_uninitialized', 'stepup-required', '', null, undefined]) expect(isVaultLockedRefusal(c)).toBe(false)
  })
})
