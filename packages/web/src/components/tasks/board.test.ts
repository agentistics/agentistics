import { describe, expect, it } from 'bun:test'
import { capList, fmtDateTime, NA } from './board'

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

describe('fmtDateTime', () => {
  // Built from LOCAL components and read back through the same machine's local getters
  // (`fmtDateTime` itself uses `getDate`/`getMonth`/`getFullYear`/`getHours`/`getMinutes`), so the
  // assertion holds whatever timezone the test runner is in — a fixed `…Z` string would not.
  const local = (y: number, m: number, d: number, hh = 16, min = 31): string =>
    new Date(y, m - 1, d, hh, min).toISOString()
  const nowInYear = (y: number): number => new Date(y, 5, 1).getTime()

  it('renders PT as DD/MM HH:mm (24h), no year, when the date falls in the current year', () => {
    expect(fmtDateTime(local(2026, 9, 25), 'pt', nowInYear(2026))).toBe('25/09 16:31')
  })

  it('renders EN as MM/DD h:mm AM/PM, no year, when the date falls in the current year', () => {
    expect(fmtDateTime(local(2026, 9, 25), 'en', nowInYear(2026))).toBe('09/25 4:31 PM')
  })

  it('shows the year, PT DD/MM/AAAA, when the date falls in a DIFFERENT year from "now"', () => {
    expect(fmtDateTime(local(2025, 9, 25), 'pt', nowInYear(2026))).toBe('25/09/2025 16:31')
  })

  it('shows the year, EN MM/DD/YYYY, when the date falls in a DIFFERENT year from "now"', () => {
    expect(fmtDateTime(local(2025, 9, 25), 'en', nowInYear(2026))).toBe('09/25/2025 4:31 PM')
  })

  it('pads a single-digit day, month, hour (PT) and minute on both locales', () => {
    expect(fmtDateTime(local(2026, 1, 5, 4, 3), 'pt', nowInYear(2026))).toBe('05/01 04:03')
    expect(fmtDateTime(local(2026, 1, 5, 4, 3), 'en', nowInYear(2026))).toBe('01/05 4:03 AM')
  })

  it('reads midnight as 12 AM and noon as 12 PM, never "0"', () => {
    expect(fmtDateTime(local(2026, 9, 25, 0, 0), 'en', nowInYear(2026))).toBe('09/25 12:00 AM')
    expect(fmtDateTime(local(2026, 9, 25, 12, 0), 'en', nowInYear(2026))).toBe('09/25 12:00 PM')
  })

  it('absent input renders the board\'s N/A convention, never "Invalid Date"', () => {
    expect(fmtDateTime(undefined, 'pt', nowInYear(2026))).toBe(NA)
    expect(fmtDateTime(undefined, 'en', nowInYear(2026))).toBe(NA)
  })

  it('an unparsable string renders N/A too', () => {
    expect(fmtDateTime('not a date', 'pt', nowInYear(2026))).toBe(NA)
    expect(fmtDateTime('not a date', 'en', nowInYear(2026))).toBe(NA)
  })

  it('an empty string renders N/A', () => {
    expect(fmtDateTime('', 'pt', nowInYear(2026))).toBe(NA)
  })
})
