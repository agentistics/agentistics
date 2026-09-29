import { describe, expect, test } from 'bun:test'
import { highlightedRow, parseRewindMenu, rewindRowMatches } from './claude-rewind'

// Captured from claude 2.1.284 (2026-09-29).
const opened = [
  '▔'.repeat(40),
  '   Rewind',
  '   Restore and fork the conversation to the point before…',
  '     REWIND-ONE responda apenas: um',
  '     REWIND-TWO responda apenas: TWO',
  '     REWIND-THREE responda apenas: THREE',
  '   ❯ (current)',
  '   Enter to continue · Esc to cancel',
]
const scrolled = [
  '   Rewind',
  '   Restore and fork the conversation to the point before…',
  '     ↑ 4 more above',
  '     QUEUED-B responda apenas: B',
  '   ❯ Write a 900-word essay about the history of clocks. Output it directly.',
  '     QUEUED-C responda apenas: C',
  '     (current)',
  '   Enter to continue · Esc to cancel',
]

describe('parseRewindMenu', () => {
  test('lists the prompts oldest first, cursor on (current)', () => {
    const m = parseRewindMenu(opened)!
    expect(m.items).toEqual(['REWIND-ONE responda apenas: um', 'REWIND-TWO responda apenas: TWO', 'REWIND-THREE responda apenas: THREE'])
    expect(m.cursor).toBe(3)
    expect(highlightedRow(m)).toBeNull()
    expect(m.moreAbove).toBe(false)
  })
  test('a scrolled menu says so, and reads the highlighted row', () => {
    const m = parseRewindMenu(scrolled)!
    expect(m.moreAbove).toBe(true)
    expect(highlightedRow(m)).toBe('Write a 900-word essay about the history of clocks. Output it directly.')
  })
  test('anything else is not the menu', () => {
    expect(parseRewindMenu(['❯ ', '─'.repeat(20), '  ? for shortcuts'])).toBeNull()
    // The header alone, quoted in a conversation, without the menu's own footer.
    expect(parseRewindMenu(['Restore and fork the conversation to the point before…', 'text'])).toBeNull()
  })
})

describe('rewindRowMatches', () => {
  test('a row is the prompt\'s first line, possibly cut', () => {
    expect(rewindRowMatches('REWIND-TWO responda apenas: TWO', 'REWIND-TWO responda apenas: TWO')).toBe(true)
    expect(rewindRowMatches('Write a 900-word essay about the…', 'Write a 900-word essay about the history of clocks.')).toBe(true)
    expect(rewindRowMatches('linha um', 'linha um\nlinha dois')).toBe(true)
  })
  test('a different prompt, or an empty one, never matches', () => {
    expect(rewindRowMatches('REWIND-ONE', 'REWIND-TWO')).toBe(false)
    expect(rewindRowMatches('', 'x')).toBe(false)
  })
})
