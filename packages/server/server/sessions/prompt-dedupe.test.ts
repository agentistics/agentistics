import { describe, expect, it } from 'bun:test'
import { dedupeRepeatedPrompt } from './prompt-dedupe'

describe('dedupeRepeatedPrompt', () => {
  it('shows a path repeated by title and location once', () => {
    const p = '/home/u/.cache/x/proj/hello.txt'
    expect(dedupeRepeatedPrompt(`${p} ${p}`)).toBe(p)
  })
  it('keeps a prompt whose second part differs', () => {
    expect(dedupeRepeatedPrompt('Edit a.txt a.txt.bak')).toBe('Edit a.txt a.txt.bak')
    expect(dedupeRepeatedPrompt('Allow this command to run?')).toBe('Allow this command to run?')
  })
  it('does not merge a repeat with no separator', () => {
    expect(dedupeRepeatedPrompt('abab')).toBe('abab')
  })
  it('is total on empty text', () => {
    expect(dedupeRepeatedPrompt('')).toBe('')
  })
})
