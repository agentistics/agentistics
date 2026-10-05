import { describe, expect, test } from 'bun:test'
import { vaultLockOf, vaultLockWord } from './vaultGlyph'

describe('vaultLockOf', () => {
  test('open is open, any other word is locked, no word is unknown', () => {
    expect(vaultLockOf('open')).toBe('open')
    expect(vaultLockOf('locked')).toBe('locked')
    expect(vaultLockOf('uninitialized')).toBe('locked')
    expect(vaultLockOf(undefined)).toBe('unknown')
    expect(vaultLockOf('')).toBe('unknown')
  })
  test('words exist in both languages', () => {
    for (const s of ['open', 'locked', 'unknown'] as const) {
      expect(vaultLockWord(s, true)).not.toBe(vaultLockWord(s, false))
    }
  })
})

import { vaultBadgeOf } from './vaultGlyph'
describe('the header badge follows the vault', () => {
  test('locked is a red circle with a closed padlock', () => {
    expect(vaultBadgeOf('locked')).toEqual({ color: '#ef4444', shape: 'closed' })
  })
  test('open is a green circle with an open padlock', () => {
    expect(vaultBadgeOf('open')).toEqual({ color: '#22c55e', shape: 'open' })
  })
  test('an unreadable state draws no badge at all', () => {
    expect(vaultBadgeOf('unknown')).toBeNull()
  })
  test('the badge follows /api/vault words end to end', () => {
    expect(vaultBadgeOf(vaultLockOf('open'))?.shape).toBe('open')
    expect(vaultBadgeOf(vaultLockOf('locked'))?.shape).toBe('closed')
    expect(vaultBadgeOf(vaultLockOf(undefined))).toBeNull()
  })
})
