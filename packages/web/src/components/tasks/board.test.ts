import { describe, expect, it } from 'bun:test'
import { capList, fmtDateOnly, NA } from './board'

describe('capList', () => {
  it('shows everything and reports no extra when the list already fits', () => {
    expect(capList(['claude', 'codex'], 4)).toEqual({ shown: ['claude', 'codex'], extra: 0 })
  })

  it('caps at max and reports the truthful remainder — this is the Repositories bug', () => {
    // Six harnesses, capped at 4: the column must draw 4 pills plus a "+2", never all six.
    const all = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi']
    expect(capList(all, 4)).toEqual({ shown: ['claude', 'codex', 'gemini', 'copilot'], extra: 2 })
  })

  it('an empty list stays empty with no extra', () => {
    expect(capList([], 4)).toEqual({ shown: [], extra: 0 })
  })

  it('never returns fewer than 1 slot even if max is given as 0 or negative', () => {
    expect(capList(['a', 'b'], 0)).toEqual({ shown: ['a'], extra: 1 })
    expect(capList(['a', 'b'], -3)).toEqual({ shown: ['a'], extra: 1 })
  })

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c']
    const { shown } = capList(input, 2)
    shown.push('z')
    expect(input).toEqual(['a', 'b', 'c'])
  })
})

describe('fmtDateOnly', () => {
  // Built from LOCAL components and read back through the same machine's local getters
  // (`fmtDateOnly` itself uses `getDate`/`getMonth`/`getFullYear`), so the assertion holds
  // whatever timezone the test runner is in — a fixed `…Z` string would not.
  const local = (y: number, m: number, d: number): string => new Date(y, m - 1, d, 12, 0).toISOString()

  it('renders PT as DD/MM/AAAA', () => {
    expect(fmtDateOnly(local(2026, 9, 25), 'pt')).toBe('25/09/2026')
  })

  it('renders EN as MM/DD/YYYY, with a leading zero on a single-digit month', () => {
    expect(fmtDateOnly(local(2026, 9, 25), 'en')).toBe('09/25/2026')
  })

  it('pads a single-digit day and month on both locales', () => {
    expect(fmtDateOnly(local(2026, 1, 5), 'pt')).toBe('05/01/2026')
    expect(fmtDateOnly(local(2026, 1, 5), 'en')).toBe('01/05/2026')
  })

  it('absent input renders the board\'s N/A convention, never "Invalid Date"', () => {
    expect(fmtDateOnly(undefined, 'pt')).toBe(NA)
    expect(fmtDateOnly(undefined, 'en')).toBe(NA)
  })

  it('an unparsable string renders N/A too', () => {
    expect(fmtDateOnly('not a date', 'pt')).toBe(NA)
    expect(fmtDateOnly('not a date', 'en')).toBe(NA)
  })

  it('an empty string renders N/A', () => {
    expect(fmtDateOnly('', 'pt')).toBe(NA)
  })
})
