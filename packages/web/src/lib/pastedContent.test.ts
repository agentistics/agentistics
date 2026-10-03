import { describe, expect, test } from 'bun:test'
import { hasPastedContent, pastePreview, splitPastedContent } from './pastedContent'

describe('splitPastedContent', () => {
  test('strips tags and id, keeps the body as a paste', () => {
    const s = splitPastedContent('<pasted_content id="9a5d">\nline1\nline2\n</pasted_content id="9a5d">')
    expect(s).toEqual([{ kind: 'paste', text: 'line1\nline2' }])
    expect(JSON.stringify(s)).not.toContain('9a5d')
  })
  test('prose before and after survives', () => {
    const s = splitPastedContent('look:\n<pasted_content id="x">A</pasted_content id="x">\nthanks')
    expect(s.map(x => x.kind)).toEqual(['text', 'paste', 'text'])
  })
  test('two pastes', () => {
    expect(splitPastedContent('<pasted_content id="1">a</pasted_content id="1"><pasted_content id="2">b</pasted_content id="2">')).toHaveLength(2)
  })
  test('unterminated runs to the end, no tag leaks', () => {
    const s = splitPastedContent('hi <pasted_content id="1">abc')
    expect(s).toEqual([{ kind: 'text', text: 'hi' }, { kind: 'paste', text: 'abc' }])
  })
  test('plain text is untouched', () => {
    expect(hasPastedContent('hello')).toBe(false)
    expect(splitPastedContent('hello')).toEqual([{ kind: 'text', text: 'hello' }])
  })
  test('preview', () => {
    expect(pastePreview('a\nb\nc\nd', 2)).toEqual({ head: 'a\nb', total: 4, truncated: true })
  })
})

import { stripInjectedBlocks } from './pastedContent'
describe('stripInjectedBlocks', () => {
  test('removes embedded reminder, keeps prose', () => {
    expect(stripInjectedBlocks('hi\n<system-reminder>secret ctx</system-reminder>')).toBe('hi')
  })
  test('bash output block removed', () => {
    expect(stripInjectedBlocks('a <bash-stdout>x</bash-stdout> b')).toBe('a  b')
  })
  test('unterminated untouched', () => {
    expect(stripInjectedBlocks('a <system-reminder>oops')).toBe('a <system-reminder>oops')
  })
})
