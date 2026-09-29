import { describe, expect, test } from 'bun:test'
import { DICTATED_MARK, markDictated, stripDictatedMark } from './dictationMark'

describe('dictation mark', () => {
  test('appended on its own line, at the end — never in front of a quoted reply', () => {
    const sent = markDictated('> quoted\n\nmy words')
    expect(sent.startsWith('> quoted')).toBe(true)
    expect(sent.endsWith(`\n${DICTATED_MARK}`)).toBe(true)
  })
  test('round trip: what is shown is exactly what was said', () => {
    expect(stripDictatedMark(markDictated('fala do harness'))).toEqual({ text: 'fala do harness', dictated: true })
  })
  test('idempotent, and a message without it is untouched', () => {
    expect(markDictated(markDictated('x'))).toBe(`x\n${DICTATED_MARK}`)
    expect(stripDictatedMark('typed text')).toEqual({ text: 'typed text', dictated: false })
  })
  test('the mark is only recognised at the very end', () => {
    expect(stripDictatedMark('I wrote [dictated] in the middle').dictated).toBe(false)
  })
})
