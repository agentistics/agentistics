import { describe, expect, test } from 'bun:test'
import { DEFAULT_AWAY_DIGEST_SCHEDULE, awayDigestDurationLabel, mergeAwayDigestSchedule, parseAwayDigestSchedule } from './awayDigestSchedule'

describe('away digest schedule', () => {
  test('absent reads as the behaviour before the setting existed (5 h, every 15 min)', () => {
    expect(parseAwayDigestSchedule(undefined)).toEqual({ firstAfterMin: 300, everyMin: 15 })
    expect(DEFAULT_AWAY_DIGEST_SCHEDULE).toEqual({ firstAfterMin: 300, everyMin: 15 })
  })
  test('null turns the offer off; known options pass through', () => {
    expect(parseAwayDigestSchedule({ firstAfterMin: null, everyMin: 60 })).toEqual({ firstAfterMin: null, everyMin: 60 })
    expect(parseAwayDigestSchedule({ firstAfterMin: 720, everyMin: 180 })).toEqual({ firstAfterMin: 720, everyMin: 180 })
  })
  test('a value outside the closed lists reads as the default for that half, never as a tiny interval', () => {
    expect(parseAwayDigestSchedule({ firstAfterMin: 1, everyMin: 0 })).toEqual({ firstAfterMin: 300, everyMin: 15 })
    expect(parseAwayDigestSchedule({ firstAfterMin: '60', everyMin: -5 })).toEqual({ firstAfterMin: 300, everyMin: 15 })
  })
  test('a partial PUT merges with the stored value instead of resetting the other half', () => {
    const stored = { firstAfterMin: 120, everyMin: 180 }
    expect(mergeAwayDigestSchedule(stored, { firstAfterMin: 720 })).toEqual({ firstAfterMin: 720, everyMin: 180 })
    expect(mergeAwayDigestSchedule(stored, { everyMin: 30 })).toEqual({ firstAfterMin: 120, everyMin: 30 })
    expect(mergeAwayDigestSchedule(stored, { firstAfterMin: null })).toEqual({ firstAfterMin: null, everyMin: 180 })
    expect(mergeAwayDigestSchedule(stored, { firstAfterMin: 1, everyMin: 0 })).toEqual({ firstAfterMin: 300, everyMin: 15 })
    expect(mergeAwayDigestSchedule(undefined, { everyMin: 60 })).toEqual({ firstAfterMin: 300, everyMin: 60 })
  })
  test('labels', () => {
    expect(awayDigestDurationLabel(300)).toBe('5 h')
    expect(awayDigestDurationLabel(30)).toBe('30 min')
  })
})
