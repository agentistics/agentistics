import { describe, expect, test } from 'bun:test'
import { OSC52_MAX_CHARS, base64Utf8, charCount, osc52 } from './clipboard'

describe('OSC 52 (CD-19)', () => {
  test('ESC ] 52 ; c ; <base64 of the UTF-8> BEL', () => {
    expect(osc52('hi')).toBe('\x1b]52;c;aGk=\x07')
  })

  test('UTF-8, not UTF-16: accents and emoji round-trip', () => {
    for (const s of ['ação ✓', '漢字', '🙂 ok', 'x'.repeat(70_000)]) {
      const bytes = Uint8Array.from(atob(base64Utf8(s)), c => c.charCodeAt(0))
      expect(new TextDecoder().decode(bytes)).toBe(s)
    }
  })

  test('characters are counted as a person counts them', () => {
    expect(charCount('🙂ok')).toBe(3)
    expect(OSC52_MAX_CHARS).toBe(100_000)
  })
})
