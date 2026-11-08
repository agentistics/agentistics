import { describe, expect, test } from 'bun:test'
import { isUnlockMethod, unlockMethodsFor, type UnlockMethodEnv } from './unlock-methods'
import { withoutAuthenticator, PRESENCE_IDS, type VaultJson } from './vault'

const env = (o: Partial<UnlockMethodEnv>): UnlockMethodEnv => ({ platform: 'linux', wsl: false, fido2Tools: false, webauthnVerified: false, ...o })
const ids = (e: UnlockMethodEnv) => unlockMethodsFor(e).map(m => m.advanced ? `${m.id}*` : m.id)

describe('unlockMethodsFor — what this machine offers (owner, 2026-11-07)', () => {
  test('macOS WITHOUT libfido2 (the owner\'s Mac): Touch ID / the Mac password, then the vault password — and no key', () => {
    expect(ids(env({ platform: 'darwin' }))).toEqual(['touchid', 'password'])
  })
  test('macOS WITH libfido2: the key appears, as ADVANCED, after the others', () => {
    expect(ids(env({ platform: 'darwin', fido2Tools: true }))).toEqual(['touchid', 'password', 'fido2*'])
  })
  test('Windows: Windows Hello, then the vault password; the key only once its bridge is verified', () => {
    expect(ids(env({ platform: 'win32' }))).toEqual(['hello', 'password'])
    expect(ids(env({ platform: 'win32', webauthnVerified: true }))).toEqual(['hello', 'password', 'fido2*'])
    expect(ids(env({ platform: 'win32', fido2Tools: true }))).toEqual(['hello', 'password']) // libfido2 says nothing on Windows
  })
  test('WSL counts as Windows (Hello through interop)', () => {
    expect(ids(env({ platform: 'linux', wsl: true }))).toEqual(['hello', 'password'])
    expect(ids(env({ platform: 'linux', wsl: true, webauthnVerified: true }))).toEqual(['hello', 'password', 'fido2*'])
  })
  test('Linux: the vault password; the key with libfido2', () => {
    expect(ids(env({ platform: 'linux' }))).toEqual(['password'])
    expect(ids(env({ platform: 'linux', fido2Tools: true }))).toEqual(['password', 'fido2*'])
  })
  test('anything else: the vault password — never an empty list', () => {
    expect(ids(env({ platform: 'other' }))).toEqual(['password'])
    for (const platform of ['darwin', 'win32', 'linux', 'other'] as const) {
      for (const fido2Tools of [true, false]) expect(unlockMethodsFor(env({ platform, fido2Tools })).length).toBeGreaterThan(0)
    }
  })
  test('no method is ever the authenticator, and every offer is a presence kind the vault knows', () => {
    for (const platform of ['darwin', 'win32', 'linux', 'other'] as const) {
      for (const m of unlockMethodsFor(env({ platform, fido2Tools: true, webauthnVerified: true }))) {
        expect(isUnlockMethod(m.id)).toBe(true)
        expect(PRESENCE_IDS).toContain(m.id)
      }
    }
    expect(isUnlockMethod('authenticator')).toBe(false)
    expect(isUnlockMethod('totp')).toBe(false)
  })
})

describe('withoutAuthenticator — the migration\'s pure half', () => {
  const base: VaultJson = { v: 2, scope: 'human', kid: '0123456789abcdef', createdAt: 'x', wrappers: [{ type: 'hello', createdAt: 'x' }] }
  test('drops the authenticator record and its unlock policy, and nothing else', () => {
    const v = withoutAuthenticator({ ...base, stepup: { enrolledAt: 'x', digits: 6, period: 30 }, unlockPolicy: { mode: 'always', hours: 24 }, autoLock: { minutes: 10 } })
    expect(v.stepup).toBeUndefined()
    expect(v.unlockPolicy).toBeUndefined()
    expect(v).toEqual({ ...base, autoLock: { minutes: 10 } })
  })
  test('a vault with neither is returned untouched (the same object)', () => {
    expect(withoutAuthenticator(base)).toBe(base)
  })
})
