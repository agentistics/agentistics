import { describe, expect, test } from 'bun:test'
import { isSafeRev } from './rev.ts'

describe('isSafeRev', () => {
  test('accepts ordinary git revisions', () => {
    for (const rev of ['HEAD', 'HEAD~2', 'HEAD^', 'main', 'origin/main', 'refs/heads/main', 'v1.2.3', 'abc1234', '@{upstream}', 'v1.2.3^{}']) {
      expect(isSafeRev(rev)).toBe(true)
    }
  })

  test('refuses anything option-shaped', () => {
    for (const rev of ['--output=/tmp/x', '-x', '--upload-pack=evil', '-O/etc/passwd', '--']) {
      expect(isSafeRev(rev)).toBe(false)
    }
  })

  test('refuses whitespace', () => {
    expect(isSafeRev('HEAD extra')).toBe(false)
    expect(isSafeRev(' HEAD')).toBe(false)
    expect(isSafeRev('HEAD\n')).toBe(false)
  })

  test('refuses a shell metacharacter payload (not in the allowlist)', () => {
    expect(isSafeRev('HEAD;rm -rf /')).toBe(false)
    expect(isSafeRev('HEAD`whoami`')).toBe(false)
    expect(isSafeRev('HEAD$(whoami)')).toBe(false)
    expect(isSafeRev('HEAD|cat')).toBe(false)
  })

  test('refuses empty and overlong input', () => {
    expect(isSafeRev('')).toBe(false)
    expect(isSafeRev('a'.repeat(300))).toBe(false)
  })
})
