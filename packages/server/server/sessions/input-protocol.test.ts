import { describe, expect, test } from 'bun:test'
import {
  KEY_ALLOWLIST,
  MAX_INPUT_TEXT,
  MAX_PASTE_TEXT,
  ackFail,
  ackOk,
  encodeAck,
  parseInputMessage,
  wsInputOriginOk,
} from './input-protocol'

describe('parseInputMessage', () => {
  test('accepts a text message and keeps the literal data verbatim', () => {
    const r = parseInputMessage(JSON.stringify({ seq: 1, kind: 'text', data: 'h' }))
    expect(r).toEqual({ ok: true, msg: { seq: 1, kind: 'text', text: 'h' } })
  })

  test('a text message may carry a raw control byte (xterm.onData sends these)', () => {
    const r = parseInputMessage(JSON.stringify({ seq: 7, kind: 'text', data: '[A' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.msg).toEqual({ seq: 7, kind: 'text', text: '[A' })
  })

  test('accepts a named key from the closed set', () => {
    const r = parseInputMessage(JSON.stringify({ seq: 2, kind: 'key', name: 'C-c' }))
    expect(r).toEqual({ ok: true, msg: { seq: 2, kind: 'key', key: 'C-c' } })
  })

  test('rejects invalid JSON with bad_json and a null seq', () => {
    const r = parseInputMessage('{not json')
    expect(r).toEqual({ ok: false, seq: null, reason: 'bad_json' })
  })

  test('rejects a non-object payload', () => {
    expect(parseInputMessage('42')).toEqual({ ok: false, seq: null, reason: 'bad_message' })
    expect(parseInputMessage('null')).toEqual({ ok: false, seq: null, reason: 'bad_message' })
    expect(parseInputMessage('"a"')).toEqual({ ok: false, seq: null, reason: 'bad_message' })
  })

  test('rejects a missing or non-numeric seq — an ack needs a real seq to map', () => {
    expect(parseInputMessage(JSON.stringify({ kind: 'text', data: 'a' })))
      .toEqual({ ok: false, seq: null, reason: 'bad_message' })
    expect(parseInputMessage(JSON.stringify({ seq: 'x', kind: 'text', data: 'a' })))
      .toEqual({ ok: false, seq: null, reason: 'bad_message' })
    expect(parseInputMessage(JSON.stringify({ seq: Infinity, kind: 'text', data: 'a' })))
      .toEqual({ ok: false, seq: null, reason: 'bad_message' })
  })

  test('rejects an unknown kind but echoes the seq so the client can map the failure', () => {
    expect(parseInputMessage(JSON.stringify({ seq: 5, kind: 'nope', data: 'a' })))
      .toEqual({ ok: false, seq: 5, reason: 'bad_message' })
  })

  test('rejects empty text — an empty send that "succeeds" would be a lie', () => {
    expect(parseInputMessage(JSON.stringify({ seq: 3, kind: 'text', data: '' })))
      .toEqual({ ok: false, seq: 3, reason: 'empty_text' })
  })

  test('rejects text that is not a string', () => {
    expect(parseInputMessage(JSON.stringify({ seq: 3, kind: 'text', data: 9 })))
      .toEqual({ ok: false, seq: 3, reason: 'bad_message' })
  })

  test('rejects text over the length ceiling', () => {
    const big = 'a'.repeat(MAX_INPUT_TEXT + 1)
    expect(parseInputMessage(JSON.stringify({ seq: 4, kind: 'text', data: big })))
      .toEqual({ ok: false, seq: 4, reason: 'text_too_long' })
  })

  test('accepts text exactly at the ceiling', () => {
    const atLimit = 'a'.repeat(MAX_INPUT_TEXT)
    const r = parseInputMessage(JSON.stringify({ seq: 4, kind: 'text', data: atLimit }))
    expect(r.ok).toBe(true)
  })

  test('rejects a key name OUTSIDE the closed allowlist — defence in depth', () => {
    for (const name of ['C-c; rm', 'a b', 'F1', 'Home', 'M-Up', 'PageDown', '', 'C-x']) {
      const r = parseInputMessage(JSON.stringify({ seq: 6, kind: 'key', name }))
      expect(r).toEqual({ ok: false, seq: 6, reason: 'bad_key' })
    }
  })

  test('Escape is IN the set — a deliberate widening, with its reason', () => {
    // A soft keyboard has no Escape at all, so the mobile key strip is the only way to leave insert
    // mode in `vim` or dismiss a picker; and a Claude Code permission dialog's own footer says
    // `Esc to cancel`, which was unreachable from this channel for as long as the set excluded it.
    // It CANCELS — it does not control the process, which is the line this allowlist draws.
    expect(parseInputMessage(JSON.stringify({ seq: 9, kind: 'key', name: 'Escape' })))
      .toEqual({ ok: true, msg: { seq: 9, kind: 'key', key: 'Escape' } })
  })

  test('C-l is IN the set, and the server already knew what to do with it', () => {
    // `backend-tmux.ts` clears the pane's scrollback after a successful `C-l` — written before the
    // key could arrive from a browser at all, because this allowlist refused it as `bad_key`. It
    // CLEARS, it controls no process, and it is the shortcut people reach for most.
    expect(parseInputMessage(JSON.stringify({ seq: 9, kind: 'key', name: 'C-l' })))
      .toEqual({ ok: true, msg: { seq: 9, kind: 'key', key: 'C-l' } })
  })

  test('rejects a non-string key name', () => {
    expect(parseInputMessage(JSON.stringify({ seq: 6, kind: 'key', name: 3 })))
      .toEqual({ ok: false, seq: 6, reason: 'bad_key' })
  })

  test('accepts a paste message — a SEPARATE kind from text, with its own cap', () => {
    const r = parseInputMessage(JSON.stringify({ seq: 10, kind: 'paste', data: 'line one\nline two' }))
    expect(r).toEqual({ ok: true, msg: { seq: 10, kind: 'paste', text: 'line one\nline two' } })
  })

  test('a multi-line paste is never refused as an unsupported sequence — it is a whole message', () => {
    // The typed-keystroke allowlist (`terminalKeys.ts`, client-side) refuses a chunk with an
    // interior newline outright. `paste` is a different kind entirely and carries no such rule —
    // the point of it existing is that a paste's newlines are never judged as control bytes.
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const r = parseInputMessage(JSON.stringify({ seq: 11, kind: 'paste', data: text }))
    expect(r).toEqual({ ok: true, msg: { seq: 11, kind: 'paste', text } })
  })

  test('rejects empty paste text', () => {
    expect(parseInputMessage(JSON.stringify({ seq: 12, kind: 'paste', data: '' })))
      .toEqual({ ok: false, seq: 12, reason: 'empty_text' })
  })

  test('rejects paste text that is not a string', () => {
    expect(parseInputMessage(JSON.stringify({ seq: 12, kind: 'paste', data: 9 })))
      .toEqual({ ok: false, seq: 12, reason: 'bad_message' })
  })

  test('rejects a paste over ITS OWN (larger) length ceiling — refused, never truncated', () => {
    const big = 'a'.repeat(MAX_PASTE_TEXT + 1)
    expect(parseInputMessage(JSON.stringify({ seq: 13, kind: 'paste', data: big })))
      .toEqual({ ok: false, seq: 13, reason: 'paste_too_long' })
  })

  test('accepts a paste exactly at its own ceiling, which is larger than the typed-text one', () => {
    expect(MAX_PASTE_TEXT).toBeGreaterThan(MAX_INPUT_TEXT)
    const atLimit = 'a'.repeat(MAX_PASTE_TEXT)
    const r = parseInputMessage(JSON.stringify({ seq: 14, kind: 'paste', data: atLimit }))
    expect(r.ok).toBe(true)
  })

  test('a paste past MAX_INPUT_TEXT but within MAX_PASTE_TEXT is accepted — the caps are independent', () => {
    const between = 'a'.repeat(MAX_INPUT_TEXT + 1000)
    const r = parseInputMessage(JSON.stringify({ seq: 15, kind: 'paste', data: between }))
    expect(r.ok).toBe(true)
  })

  // C1 — a `paste` payload never reaches the tmux buffer with a bracketed-paste breakout,
  // an escape sequence, or a Ctrl-key byte still in it. `parseInputMessage` is the ONE place both
  // write channels (the Shell's `/api/shell/input` and the assistant terminal's `/api/fleet/input`)
  // route a paste through, so this is where the guarantee is proven.
  describe('C1 — the paste kind is sanitized, never accepted verbatim', () => {
    test('THE LIVE REPRO PAYLOAD: a planted bracketed-paste END marker is neutralized, not delivered', () => {
      // Reproduced live, end to end, against both the Shell and the assistant terminal: pasting
      // this exact string executed `touch /tmp/marker` as real, unconfirmed input, because
      // `tmux paste-buffer -p` does not escape an END marker already inside the buffer.
      const payload = '\x1b[201~touch /tmp/marker\r'
      const r = parseInputMessage(JSON.stringify({ seq: 20, kind: 'paste', data: payload }))
      expect(r).toEqual({ ok: true, msg: { seq: 20, kind: 'paste', text: 'touch /tmp/marker\r' } })
      if (r.ok) expect(r.msg.kind === 'paste' && r.msg.text).not.toContain('\x1b')
    })

    test('nested and split markers: a marker that only exists because removing an inner one spliced two halves together', () => {
      // `"\x1b[20" + "\x1b[201~" + "1~"` has no marker as three separate pieces, but deleting the
      // middle one leaves `"\x1b[20" + "1~"` = `"\x1b[201~"` — a fresh occurrence formed by the
      // removal itself, and the whole payload sanitizes down to nothing — so it is refused exactly
      // like an outright empty paste, never accepted as a silent no-op.
      const payload = '\x1b[20\x1b[201~1~'
      const r = parseInputMessage(JSON.stringify({ seq: 21, kind: 'paste', data: payload }))
      expect(r).toEqual({ ok: false, seq: 21, reason: 'empty_text' })
    })

    test('a raw, unpaired ESC never survives, even outside a full marker', () => {
      const r = parseInputMessage(JSON.stringify({ seq: 22, kind: 'paste', data: 'hello\x1bworld' }))
      expect(r).toEqual({ ok: true, msg: { seq: 22, kind: 'paste', text: 'helloworld' } })
    })

    test('\\x03 (Ctrl-C) does not reach the buffer', () => {
      const r = parseInputMessage(JSON.stringify({ seq: 23, kind: 'paste', data: 'rm -rf /\x03echo safe' }))
      expect(r).toEqual({ ok: true, msg: { seq: 23, kind: 'paste', text: 'rm -rf /echo safe' } })
    })

    test('\\x04 (Ctrl-D / EOF) does not reach the buffer', () => {
      const r = parseInputMessage(JSON.stringify({ seq: 24, kind: 'paste', data: 'some text\x04more text' }))
      expect(r).toEqual({ ok: true, msg: { seq: 24, kind: 'paste', text: 'some textmore text' } })
    })

    test('a legitimate multi-line paste arrives BYTE-FOR-BYTE unchanged — the sanitizer must never alter real content', () => {
      const text = 'PASTE_LINE_A\nPASTE_LINE_B\nPASTE_LINE_C'
      const r = parseInputMessage(JSON.stringify({ seq: 25, kind: 'paste', data: text }))
      expect(r).toEqual({ ok: true, msg: { seq: 25, kind: 'paste', text } })
    })

    test('the 64 KiB boundary: a clean payload exactly at the ceiling is accepted unchanged', () => {
      const atLimit = 'a'.repeat(MAX_PASTE_TEXT)
      const r = parseInputMessage(JSON.stringify({ seq: 26, kind: 'paste', data: atLimit }))
      expect(r).toEqual({ ok: true, msg: { seq: 26, kind: 'paste', text: atLimit } })
    })

    test('the 64 KiB boundary: still refused past the ceiling even though the payload would sanitize down under it', () => {
      // The length cap is checked on the RAW input, before sanitizing — a 64 KiB+1 payload of pure
      // markers is refused for being too long, not silently accepted because it would collapse to
      // nothing. The cap bounds what one WS message may carry, not what survives.
      const over = '\x1b[201~'.repeat(Math.ceil((MAX_PASTE_TEXT + 1) / '\x1b[201~'.length))
      expect(over.length).toBeGreaterThan(MAX_PASTE_TEXT)
      const r = parseInputMessage(JSON.stringify({ seq: 27, kind: 'paste', data: over }))
      expect(r).toEqual({ ok: false, seq: 27, reason: 'paste_too_long' })
    })
  })

  test('KEY_ALLOWLIST is exactly the agreed closed set', () => {
    expect([...KEY_ALLOWLIST].sort()).toEqual(
      ['BSpace', 'C-a', 'C-c', 'C-d', 'C-e', 'C-k', 'C-l', 'C-u', 'C-w', 'Down', 'Enter', 'Escape', 'Left', 'Right', 'Tab', 'Up'],
    )
    for (const k of KEY_ALLOWLIST) {
      expect(parseInputMessage(JSON.stringify({ seq: 1, kind: 'key', name: k })).ok).toBe(true)
    }
  })
})

describe('ack shapes', () => {
  test('ackOk / ackFail carry the seq and the outcome, and reason only on failure', () => {
    expect(ackOk(1)).toEqual({ seq: 1, ok: true })
    expect(ackFail(2, 'send_failed')).toEqual({ seq: 2, ok: false, reason: 'send_failed' })
    expect(ackFail(null, 'bad_json')).toEqual({ seq: null, ok: false, reason: 'bad_json' })
  })

  test('encodeAck is a valid JSON string echoing the seq', () => {
    expect(JSON.parse(encodeAck(ackOk(3)))).toEqual({ seq: 3, ok: true })
    expect(JSON.parse(encodeAck(ackFail(4, 'send_failed')))).toEqual({ seq: 4, ok: false, reason: 'send_failed' })
  })
})

describe('wsInputOriginOk — CSWSH protection', () => {
  const base = { host: 'localhost:47292', allowlist: [] as string[], dev: false }

  test('accepts the request’s own origin (same-origin dashboard), prod or dev', () => {
    expect(wsInputOriginOk({ ...base, origin: 'http://localhost:47292' })).toBe(true)
    expect(wsInputOriginOk({ ...base, origin: 'https://localhost:47292' })).toBe(true)
  })

  test('accepts an allowlisted origin', () => {
    expect(wsInputOriginOk({ ...base, origin: 'http://desk.example', allowlist: ['http://desk.example'] })).toBe(true)
  })

  test('accepts a localhost dev origin only in dev', () => {
    expect(wsInputOriginOk({ ...base, origin: 'http://localhost:5173', dev: true })).toBe(true)
    expect(wsInputOriginOk({ ...base, origin: 'http://localhost:5173', dev: false })).toBe(false)
  })

  test('rejects a foreign origin — the CSWSH case', () => {
    expect(wsInputOriginOk({ ...base, origin: 'http://evil.example' })).toBe(false)
  })

  test('accepts a missing Origin — a non-browser client; browsers always send one', () => {
    expect(wsInputOriginOk({ ...base, origin: null })).toBe(true)
  })
})
