import { describe, expect, test } from 'bun:test'
import { loginNeedsRelogin } from './usePlanAgentUse'

describe('loginNeedsRelogin', () => {
  test('only a broken login that a re-login fixes', () => {
    expect(loginNeedsRelogin({ login: 'expired', relogin: true })).toBe(true)
    expect(loginNeedsRelogin({ login: 'signed_out', relogin: true })).toBe(true)
    expect(loginNeedsRelogin({ login: 'ok' })).toBe(false)
    expect(loginNeedsRelogin({})).toBe(false)
    expect(loginNeedsRelogin({ login: 'expired', relogin: false })).toBe(false)
  })
})
