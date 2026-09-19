import { describe, expect, test } from 'bun:test'
import { decodeUtf8Lossless } from './editor-text'

/** The contract, stated over BYTES: whatever decodes must re-encode to exactly what it came from. */
const roundTrips = (bytes: number[]): boolean => {
  const s = decodeUtf8Lossless(Buffer.from(bytes))
  return s !== null && Buffer.compare(Buffer.from(s, 'utf8'), Buffer.from(bytes)) === 0
}

describe('decodeUtf8Lossless', () => {
  test('Latin-1 "café" is refused — the byte that motivated this module', () => {
    expect(decodeUtf8Lossless(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))).toBeNull()
  })

  test('cp1252 smart quotes, a truncated sequence, an overlong form and a lone surrogate are refused', () => {
    expect(decodeUtf8Lossless(Buffer.from([0x93, 0x68, 0x69, 0x94]))).toBeNull()
    expect(decodeUtf8Lossless(Buffer.from([0x61, 0xe2, 0x82]))).toBeNull()
    expect(decodeUtf8Lossless(Buffer.from([0xc0, 0xaf]))).toBeNull()
    expect(decodeUtf8Lossless(Buffer.from([0xed, 0xa0, 0x80]))).toBeNull()
  })

  test('valid UTF-8 round-trips byte for byte — multi-byte, astral, CRLF, empty', () => {
    expect(roundTrips([...Buffer.from('café ✓ 😀\r\nlinha\n', 'utf8')])).toBe(true)
    expect(roundTrips([])).toBe(true)
  })

  test('a byte-order mark is KEPT in the string, so the save writes it back', () => {
    const bom = [0xef, 0xbb, 0xbf, 0x61, 0x0a]
    expect(decodeUtf8Lossless(Buffer.from(bom))).toBe('﻿a\n')
    expect(roundTrips(bom)).toBe(true)
  })

  test('the lenient decode this replaced really is lossy — the defect the refusal exists for', () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])
    const back = Buffer.from(latin1.toString('utf8'), 'utf8')
    expect([...back]).toEqual([0x63, 0x61, 0x66, 0xef, 0xbf, 0xbd, 0x0a])
  })
})
