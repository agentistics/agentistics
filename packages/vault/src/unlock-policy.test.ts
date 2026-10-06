import { describe, expect, it } from 'bun:test'
import { DEFAULT_UNLOCK_POLICY, effectiveUnlockPolicy, parseUnlockPolicy, unlockNeedsCode, unlockWindowEndsMs } from './unlock-policy'
import { parseVaultJson, serializeVaultJson, type VaultJson } from './vault'

const H = 3_600_000

describe('the unlock policy (owner decision 2026-10-02)', () => {
  it('the default is per day, 24 hours', () => {
    expect(DEFAULT_UNLOCK_POLICY).toEqual({ mode: 'daily', hours: 24 })
    expect(effectiveUnlockPolicy(undefined)).toEqual({ mode: 'daily', hours: 24 })
  })
  it('always → the code every time; hello-only → never at unlock', () => {
    for (const anchor of [null, 0]) {
      expect(unlockNeedsCode({ mode: 'always', hours: 12 }, anchor, 1)).toBe(true)
      expect(unlockNeedsCode({ mode: 'hello-only', hours: 12 }, anchor, 1)).toBe(false)
    }
  })
  it('daily → the code with no window, none inside it, the code again at N hours exactly', () => {
    const p = { mode: 'daily' as const, hours: 12 }
    expect(unlockNeedsCode(p, null, 5)).toBe(true)
    expect(unlockNeedsCode(p, 0, 12 * H - 1)).toBe(false)
    expect(unlockNeedsCode(p, 0, 12 * H)).toBe(true)
    expect(unlockNeedsCode(p, 10 * H, 5)).toBe(true) // a clock that went backwards never extends a window
    expect(unlockWindowEndsMs(p, 0)).toBe(12 * H)
    expect(unlockWindowEndsMs(p, null)).toBeNull()
    expect(unlockWindowEndsMs({ mode: 'always', hours: 12 }, 0)).toBeNull()
  })
  it('parses only a real policy: three modes, 1–24 whole hours', () => {
    expect(parseUnlockPolicy({ mode: 'daily', hours: 1 })).toEqual({ mode: 'daily', hours: 1 })
    expect(parseUnlockPolicy({ mode: 'daily', hours: 24 })).toEqual({ mode: 'daily', hours: 24 })
    expect(parseUnlockPolicy({ mode: 'hello-only' })).toEqual({ mode: 'hello-only', hours: 24 })
    for (const bad of [null, {}, { mode: 'never' }, { mode: 'daily', hours: 0 }, { mode: 'daily', hours: 25 }, { mode: 'daily', hours: 2.5 }, { mode: 'daily', hours: '3' }]) {
      expect(parseUnlockPolicy(bad)).toBeNull()
    }
  })
  it('round-trips through vault.json (v2 only) and a junk policy makes the file unreadable rather than silently default', () => {
    const v: VaultJson = { v: 2, scope: 'human', kid: 'a'.repeat(16), createdAt: 'x', wrappers: [{ type: 'hello', createdAt: 'x' }], unlockPolicy: { mode: 'always', hours: 6 } }
    const back = parseVaultJson(serializeVaultJson(v))
    expect(back?.unlockPolicy).toEqual({ mode: 'always', hours: 6 })
    const raw = JSON.parse(new TextDecoder().decode(serializeVaultJson(v)))
    raw.unlockPolicy = { mode: 'never', hours: 6 }
    expect(parseVaultJson(JSON.stringify(raw))).toBeNull()
  })
})
