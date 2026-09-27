import { describe, expect, test } from 'bun:test'
import { boundText } from './output.ts'

describe('boundText', () => {
  test('text under the limit is returned whole, untruncated', () => {
    const r = boundText('hello', 100)
    expect(r).toEqual({ text: 'hello', truncated: false, originalBytes: 5 })
  })

  test('text over the limit is cut and reports the ORIGINAL size', () => {
    const text = 'a'.repeat(1000)
    const r = boundText(text, 100)
    expect(r.truncated).toBe(true)
    expect(r.originalBytes).toBe(1000)
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(100)
  })

  test('exactly at the limit is not truncated', () => {
    const text = 'a'.repeat(100)
    const r = boundText(text, 100)
    expect(r.truncated).toBe(false)
  })

  test('a multi-byte character straddling the cut does not throw', () => {
    const text = '€'.repeat(50) // each € is 3 bytes in UTF-8
    const r = boundText(text, 100) // cuts mid-character at byte 100
    expect(r.truncated).toBe(true)
    expect(() => r.text).not.toThrow()
  })
})
