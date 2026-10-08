import { afterEach, describe, expect, test } from 'bun:test'
import {
  COMPOSER_MESSAGE_TTL_MS,
  isComposerMessage,
  normalizeComposerText,
  recordComposerMessage,
  resetComposerMessages,
} from './composer-message'

describe('composer message fingerprints', () => {
  afterEach(resetComposerMessages)

  test('matches the sent session text after Claude adds pasted_content tags', () => {
    recordComposerMessage('session-1', 'before\n> quoted\nafter', 1_000)
    expect(isComposerMessage('session-1', 'before\n<pasted_content id="abc">\n> quoted\n</pasted_content id="abc">\nafter', 2_000)).toBe(true)
  })

  test('does not match another session or after the short retention window', () => {
    recordComposerMessage('session-1', 'same text', 1_000)
    expect(isComposerMessage('session-2', 'same text', 2_000)).toBe(false)
    expect(isComposerMessage('session-1', 'same text', 1_000 + COMPOSER_MESSAGE_TTL_MS + 1)).toBe(false)
  })

  test('normalization does not expose or retain the original text', () => {
    expect(normalizeComposerText('  one\r\n\n two  ')).toBe('one\n two')
  })
})
