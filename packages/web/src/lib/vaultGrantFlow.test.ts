import { describe, expect, test } from 'bun:test'
import { grantStep, UNLOCK_FIRST_LINE } from './vaultGrantFlow'

describe('grantStep', () => {
  test('open on this computer → no gesture', () => expect(grantStep({ loopback: true, locked: false })).toBe('direct'))
  test('locked on this computer → say why, unlock once', () => expect(grantStep({ loopback: true, locked: true })).toBe('unlock-first'))
  test('a phone keeps its own path, open or locked', () => {
    expect(grantStep({ loopback: false, locked: false })).toBe('remote')
    expect(grantStep({ loopback: false, locked: true })).toBe('remote')
  })
  test('the line names Hello + code and exists in both languages', () => {
    expect(UNLOCK_FIRST_LINE.pt).toContain('Windows Hello + código')
    expect(UNLOCK_FIRST_LINE.en).toContain('Windows Hello + code')
  })
})
