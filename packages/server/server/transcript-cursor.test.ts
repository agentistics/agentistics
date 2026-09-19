import { describe, expect, test } from 'bun:test'
import {
  ANCHOR_BYTES, anchorHex, completeLineEnd, consumedEnd, cursorFrom, evictTranscriptStates, planTranscriptRead,
  type TranscriptCursor,
} from './transcript-cursor'

const cursor = (over: Partial<TranscriptCursor> = {}): TranscriptCursor => ({
  offset: 1000, size: 1000, mtimeMs: 1_700_000_000_000, anchor: 'ab'.repeat(ANCHOR_BYTES),
  anchorBytes: ANCHOR_BYTES, ...over,
})

describe('planTranscriptRead', () => {
  test('nothing kept means the file is read whole, and says so', () => {
    expect(planTranscriptRead(null, { size: 10, mtimeMs: 1 })).toEqual({ mode: 'full', reason: 'no-cursor' })
    expect(planTranscriptRead(undefined, { size: 10, mtimeMs: 1 })).toEqual({ mode: 'full', reason: 'no-cursor' })
  })

  test('same size and same mtime is nothing to do', () => {
    const c = cursor()
    expect(planTranscriptRead(c, { size: c.size, mtimeMs: c.mtimeMs })).toEqual({ mode: 'unchanged' })
  })

  test('same size with a NEW mtime is read whole — the one shape a size check cannot see', () => {
    const c = cursor()
    expect(planTranscriptRead(c, { size: c.size, mtimeMs: c.mtimeMs + 1 }))
      .toEqual({ mode: 'full', reason: 'rewritten' })
  })

  test('a file that shrank is read whole, however recent its mtime', () => {
    const c = cursor()
    expect(planTranscriptRead(c, { size: c.size - 1, mtimeMs: c.mtimeMs })).toEqual({ mode: 'full', reason: 'shrank' })
  })

  test('a cursor past the end of the file is read whole', () => {
    // `offset` beyond `size` describes a file that is not there any more.
    const c = cursor({ offset: 5000, size: 5000 })
    expect(planTranscriptRead(c, { size: 400, mtimeMs: 2 })).toEqual({ mode: 'full', reason: 'shrank' })
  })

  test('a grown file is read from the cursor, with the anchor region in front of it', () => {
    const c = cursor({ offset: 1000, size: 1000 })
    expect(planTranscriptRead(c, { size: 4000, mtimeMs: c.mtimeMs + 10 })).toEqual({
      mode: 'append', readFrom: 1000 - ANCHOR_BYTES, verifyBytes: ANCHOR_BYTES, lineFrom: 1000, to: 4000,
    })
  })

  test('growth needs no mtime agreement — an unmoved mtime still resumes', () => {
    // A filesystem whose mtime granularity lags the write must not strand a live session.
    const c = cursor()
    const plan = planTranscriptRead(c, { size: c.size + 5, mtimeMs: c.mtimeMs })
    expect(plan.mode).toBe('append')
  })

  test('near the start of a file the anchor is only as long as what precedes the cursor', () => {
    const c = cursor({ offset: 10, size: 10, anchorBytes: 10 })
    expect(planTranscriptRead(c, { size: 900, mtimeMs: 2 })).toEqual({
      mode: 'append', readFrom: 0, verifyBytes: 10, lineFrom: 10, to: 900,
    })
  })

  test('a cursor at byte zero verifies nothing and reads from the start', () => {
    const c = cursor({ offset: 0, size: 0, anchor: '', anchorBytes: 0 })
    expect(planTranscriptRead(c, { size: 900, mtimeMs: 2 })).toEqual({
      mode: 'append', readFrom: 0, verifyBytes: 0, lineFrom: 0, to: 900,
    })
  })
})

describe('completeLineEnd', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)

  test('a chunk with no newline holds no complete line', () => {
    expect(completeLineEnd(bytes('{"a":1}'))).toBe(0)
    expect(completeLineEnd(bytes(''))).toBe(0)
  })

  test('a chunk ending in a newline is complete to its end', () => {
    expect(completeLineEnd(bytes('a\nb\n'))).toBe(4)
  })

  test('a chunk cut mid-line stops after the last newline', () => {
    // The half-written line is LEFT — the next read sees it whole.
    expect(completeLineEnd(bytes('{"a":1}\n{"b":2'))).toBe(8)
  })

  test('the answer is a BYTE count, not a character count', () => {
    // Two lines whose text is shorter than its bytes. A character count would put every later
    // read at the wrong offset, drifting further with each multi-byte character.
    const buf = bytes('{"t":"ação"}\n{"t":"é"}\n')
    expect(completeLineEnd(buf)).toBe(buf.length)
    expect(completeLineEnd(buf)).toBeGreaterThan('{"t":"ação"}\n{"t":"é"}\n'.length)
  })

  test('a cut inside a multi-byte character never becomes a line end', () => {
    // 0x0A cannot occur inside a UTF-8 continuation, so the cut can only land before the line.
    const full = bytes('{"t":"ação"}\n')
    for (let cut = 1; cut < full.length; cut++) {
      expect(completeLineEnd(full.subarray(0, cut))).toBe(0)
    }
  })
})

describe('cursorFrom', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)

  test('the anchor is the bytes ending AT the cursor', () => {
    const buf = bytes('0123456789')
    const c = cursorFrom(buf, 10, 8, { size: 10, mtimeMs: 5 })
    expect(c.offset).toBe(8)
    expect(c.anchorBytes).toBe(8)
    expect(c.anchor).toBe(anchorHex(bytes('01234567')))
  })

  test('a cursor at byte zero has no anchor to carry', () => {
    const c = cursorFrom(bytes('abc'), 3, 0, { size: 3, mtimeMs: 5 })
    expect(c).toMatchObject({ offset: 0, anchor: '', anchorBytes: 0 })
  })

  test('the anchor is capped, and is read from a buffer that starts before the cursor', () => {
    const buf = new Uint8Array(ANCHOR_BYTES * 3).fill(7)
    const c = cursorFrom(buf, 9000, 9000 - ANCHOR_BYTES, { size: 9000, mtimeMs: 1 })
    expect(c.anchorBytes).toBe(ANCHOR_BYTES)
    expect(c.anchor.length).toBe(ANCHOR_BYTES * 2)
  })
})

describe('evictTranscriptStates', () => {
  const use = (usedMs: number) => ({ usedMs })

  test('a walk nobody has asked for in the TTL is dropped', () => {
    const now = 1_000_000
    const rows = [['a', use(now - 1)], ['b', use(now - 60_000)]] as const
    expect(evictTranscriptStates(rows, now, { ttlMs: 30_000, max: 10 })).toEqual(['b'])
  })

  test('past the cap the least recently used go first', () => {
    const now = 1_000_000
    const rows = [['a', use(now - 3)], ['b', use(now - 1)], ['c', use(now - 2)]] as const
    expect(evictTranscriptStates(rows, now, { ttlMs: 30_000, max: 2 })).toEqual(['a'])
  })

  test('the cap counts only what the TTL has not already taken', () => {
    const now = 1_000_000
    const rows = [['old', use(now - 60_000)], ['a', use(now - 2)], ['b', use(now - 1)]] as const
    // Two live rows under a cap of two: the expired one is dropped and nothing else is.
    expect(evictTranscriptStates(rows, now, { ttlMs: 30_000, max: 2 }).sort()).toEqual(['old'])
  })

  test('nothing to drop is an empty list, never a throw', () => {
    expect(evictTranscriptStates([], 1, { ttlMs: 1, max: 1 })).toEqual([])
  })
})

describe('consumedEnd', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)

  test('a complete last line with NO newline after it is consumed', () => {
    // The file has stopped. Declining this line would lose the session's last turn, silently.
    const buf = bytes('{"a":1}\n{"b":2}')
    expect(consumedEnd(buf)).toBe(buf.length)
  })

  test('a HALF-written last line is left for the read that finishes it', () => {
    expect(consumedEnd(bytes('{"a":1}\n{"b":'))).toBe(8)
    expect(consumedEnd(bytes('{"a":1}\n{"b":2'))).toBe(8)
  })

  test('a line cut inside a multi-byte character is half-written', () => {
    const full = bytes('{"a":1}\n{"t":"ação"}')
    const cut = full.indexOf(0xc3) + 1 // inside the 'ç'
    expect(consumedEnd(full.subarray(0, cut))).toBe(8)
  })

  test('a trailing value that is not an OBJECT is not a transcript line', () => {
    // `12` is a valid JSON prefix of `123`, which is exactly the ambiguity the object rule avoids.
    expect(consumedEnd(bytes('{"a":1}\n12'))).toBe(8)
    expect(consumedEnd(bytes('{"a":1}\n"abc"'))).toBe(8)
    expect(consumedEnd(bytes('{"a":1}\nnull'))).toBe(8)
  })

  test('trailing whitespace is not a line', () => {
    expect(consumedEnd(bytes('{"a":1}\n  '))).toBe(8)
  })

  test('a chunk that ends on a newline is unaffected', () => {
    const buf = bytes('{"a":1}\n{"b":2}\n')
    expect(consumedEnd(buf)).toBe(buf.length)
  })
})
