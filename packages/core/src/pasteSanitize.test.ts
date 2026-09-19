import { describe, expect, test } from 'bun:test'
import { sanitizePasteText } from './pasteSanitize'

describe('sanitizePasteText — bracketed-paste breakout', () => {
  test('the exact repro payload: a planted END marker followed by a shell command is neutralized', () => {
    // The live-reproduced exploit: `tmux paste-buffer -p` does not escape an END marker already
    // inside the buffer, so this plain string, pasted verbatim, closed bracketed paste early and
    // ran `touch /tmp/marker` as real, unconfirmed input.
    const payload = '\x1b[201~touch /tmp/marker\r'
    const out = sanitizePasteText(payload)
    expect(out).not.toContain('\x1b[201~')
    expect(out).not.toContain('\x1b')
    // The command text itself is ordinary printable content and a trailing \r is a legitimate paste
    // byte — both survive; only the marker and any stray control byte are stripped.
    expect(out).toBe('touch /tmp/marker\r')
  })

  test('nested and split markers: a marker that only exists because removing an inner one spliced two halves together', () => {
    // `"\x1b[20" + "\x1b[201~" + "1~"` contains no marker as three separate pieces, but deleting the
    // middle one leaves `"\x1b[20" + "1~"` = `"\x1b[201~"` — a fresh occurrence formed by the
    // removal itself. A naive single non-repeating replace would let this one through.
    const payload = '\x1b[20\x1b[201~1~'
    const out = sanitizePasteText(payload)
    expect(out).toBe('')
    expect(out).not.toContain('\x1b')
  })

  test('a doubly-nested split still leaves no marker and no ESC behind', () => {
    const payload = '\x1b[2\x1b[20\x1b[201~1~0\x1b[201~~'
    const out = sanitizePasteText(payload)
    expect(out).not.toContain('\x1b[200~')
    expect(out).not.toContain('\x1b[201~')
    expect(out).not.toContain('\x1b')
  })

  test('the START marker alone is also stripped, not only the END marker', () => {
    const payload = 'before\x1b[200~after'
    expect(sanitizePasteText(payload)).toBe('beforeafter')
  })

  test('a marker embedded in the middle of ordinary text is removed, the surrounding text kept', () => {
    const payload = 'echo hi\x1b[201~ && rm -rf /'
    expect(sanitizePasteText(payload)).toBe('echo hi && rm -rf /')
  })
})

describe('sanitizePasteText — other control bytes', () => {
  test('a raw, unpaired ESC (not part of any marker) is stripped', () => {
    expect(sanitizePasteText('hello\x1bworld')).toBe('helloworld')
  })

  test('Ctrl-C (\\x03) is stripped', () => {
    expect(sanitizePasteText('rm -rf /\x03echo safe')).toBe('rm -rf /echo safe')
  })

  test('Ctrl-D / EOF (\\x04) is stripped', () => {
    expect(sanitizePasteText('some text\x04more text')).toBe('some textmore text')
  })

  test('every other C0 control byte and DEL is stripped, except \\t \\n \\r', () => {
    const controls = ['\x00', '\x01', '\x02', '\x05', '\x06', '\x07', '\x08', '\x0b', '\x0c', '\x0e', '\x0f', '\x1a', '\x1f', '\x7f']
    for (const c of controls) {
      expect(sanitizePasteText(`a${c}b`)).toBe('ab')
    }
  })

  test('\\t \\n \\r survive untouched — these are what a legitimate paste carries', () => {
    expect(sanitizePasteText('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })
})

describe('sanitizePasteText — legitimate content is never altered', () => {
  test('a legitimate multi-line paste arrives byte-for-byte unchanged', () => {
    const text = 'PASTE_LINE_A\nPASTE_LINE_B\nPASTE_LINE_C'
    expect(sanitizePasteText(text)).toBe(text)
  })

  test('printable non-ASCII (accents, emoji, CJK) is untouched', () => {
    const text = 'café 日本語 🎉 naïve'
    expect(sanitizePasteText(text)).toBe(text)
  })

  test('a plain single-line paste with no control bytes is untouched', () => {
    const text = 'the quick brown fox jumps over the lazy dog 123 !@#$%^&*()'
    expect(sanitizePasteText(text)).toBe(text)
  })

  test('an empty string stays empty', () => {
    expect(sanitizePasteText('')).toBe('')
  })
})

describe('sanitizePasteText — the 64 KiB boundary', () => {
  test('a clean payload exactly at the paste size ceiling is returned unchanged', () => {
    const atLimit = 'a'.repeat(65536)
    expect(sanitizePasteText(atLimit)).toBe(atLimit)
  })

  test('a 64 KiB payload saturated with the exploit marker is fully neutralized, not just truncated', () => {
    const marker = '\x1b[201~'
    const filler = marker.repeat(Math.floor(65536 / marker.length))
    const out = sanitizePasteText(filler)
    expect(out).toBe('')
  })

  test('a 64 KiB payload of alternating nested markers around real text is neutralized end to end', () => {
    const unit = '\x1b[20\x1b[201~1~X'
    const big = unit.repeat(Math.floor(65536 / unit.length))
    const out = sanitizePasteText(big)
    expect(out).not.toContain('\x1b')
    // Only the literal `X` filler survives, once per unit.
    expect(out).toBe('X'.repeat(Math.floor(65536 / unit.length)))
  })
})

test('the C1 control range is removed too, including the 8-bit CSI', () => {
  expect(sanitizePasteText('a\u009b201~touch /tmp/x\rb')).toBe('a201~touch /tmp/x\rb')
  expect(sanitizePasteText('x\u0080\u0085\u009fy')).toBe('xy')
  expect(sanitizePasteText('ação é ü ñ — “aspas” 日本')).toBe('ação é ü ñ — “aspas” 日本')
})

