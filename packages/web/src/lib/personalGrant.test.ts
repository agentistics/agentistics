import { afterEach, describe, expect, test } from 'bun:test'
import {
  PERSONAL_GRANT_HEADER, PERSONAL_GRANT_PROTOCOL, clearPersonalGrant, getPersonalGrant, personalGrantHeaders, personalInputProtocols,
  requestPersonalGrant, setPersonalGrant, subscribePersonalGrant, unlockSentence,
} from './personalGrant'

afterEach(() => clearPersonalGrant())

describe('the personal-browser grant (held in memory only)', () => {
  test('set / get / clear, and an expired grant reads as none', () => {
    expect(getPersonalGrant(0)).toBeNull()
    setPersonalGrant('tok', 1_000)
    expect(getPersonalGrant(999)).toBe('tok')
    expect(getPersonalGrant(1_000)).toBeNull()
    clearPersonalGrant()
    expect(getPersonalGrant(0)).toBeNull()
  })
  test('subscribers hear every change', () => {
    let n = 0
    const off = subscribePersonalGrant(() => { n++ })
    setPersonalGrant('a', Date.now() + 1000)
    clearPersonalGrant()
    off()
    setPersonalGrant('b', Date.now() + 1000)
    expect(n).toBe(2)
  })
  test('the header carries the grant, never a URL; absent grant = no header', () => {
    expect(personalGrantHeaders()).toEqual({})
    setPersonalGrant('tok', Date.now() + 10_000)
    expect(personalGrantHeaders()).toEqual({ [PERSONAL_GRANT_HEADER]: 'tok' })
  })
  test('the input socket offers the marker then the token as sub-protocols', () => {
    expect(personalInputProtocols()).toBeUndefined()
    setPersonalGrant('tok', Date.now() + 10_000)
    expect(personalInputProtocols()).toEqual([PERSONAL_GRANT_PROTOCOL, 'tok'])
  })
  test('the grant is never written to storage', () => {
    const writes: string[] = []
    const real = globalThis.localStorage
    ;(globalThis as { localStorage?: unknown }).localStorage = { setItem: (k: string, v: string) => writes.push(`${k}=${v}`), getItem: () => null, removeItem: () => {} }
    setPersonalGrant('secret-token', Date.now() + 10_000)
    ;(globalThis as { localStorage?: unknown }).localStorage = real
    expect(writes).toEqual([])
  })
})

describe('requestPersonalGrant', () => {
  test('a granted proof stores the grant and says ok', async () => {
    const r = await requestPersonalGrant(async () => ({ ok: true, personalGrant: 'tok2', expiresAt: Date.now() + 60_000 }), false)
    expect(r).toEqual({ ok: true })
    expect(getPersonalGrant()).toBe('tok2')
  })
  test('the vault unavailable: the Vault sentence in pt and the open-vault action; nothing stored', async () => {
    const r = await requestPersonalGrant(async () => ({ ok: false, code: 'owner-proof-unavailable', sentence: 'x' }), true)
    expect(r).toMatchObject({ ok: false, openVault: true })
    expect((r as { sentence: string }).sentence).toMatch(/Cofre/)
    expect(getPersonalGrant()).toBeNull()
  })
  test('a cancelled gesture is said in words, no Vault button', async () => {
    const r = await requestPersonalGrant(async () => ({ ok: false, code: 'presence-cancelled', sentence: '' }), false)
    expect(r).toMatchObject({ ok: false, openVault: false })
    expect((r as { sentence: string }).sentence.length).toBeGreaterThan(5)
  })
})

test('unlockSentence speaks both languages', () => {
  expect(unlockSentence(true)).toMatch(/Cofre/)
  expect(unlockSentence(false)).toMatch(/Vault/)
})
