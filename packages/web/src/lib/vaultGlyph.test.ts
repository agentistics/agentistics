import { describe, expect, test } from 'bun:test'
import { VAULT_ICON, vaultLockOf, vaultLockWord } from './vaultGlyph'

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
  test('the icon is one of the offered names', () => {
    expect(['vault', 'lock-keyhole', 'key-round']).toContain(VAULT_ICON)
  })
})
