import { describe, expect, it } from 'bun:test'
import { DEFAULT_IDLE_PREFS, parseIdlePrefs } from './idleSessionsPrefs'

describe('parseIdlePrefs', () => {
  it('absent reads as the defaults (enabled, 120/30)', () => {
    expect(parseIdlePrefs(undefined)).toEqual(DEFAULT_IDLE_PREFS)
  })
  it('keeps valid values and repairs invalid ones field by field', () => {
    expect(parseIdlePrefs({ enabled: false, thresholdMin: 60, pressureThresholdMin: -5, kept: { a: 1, b: 'x' } }))
      .toEqual({ enabled: false, thresholdMin: 60, pressureThresholdMin: 30, replyCostThreshold: 300_000, kept: { a: 1 } })
  })
  it('reply-cost threshold: kept when valid (0 = off), repaired when not', () => {
    expect(parseIdlePrefs({ replyCostThreshold: 0 })?.replyCostThreshold).toBe(0)
    expect(parseIdlePrefs({ replyCostThreshold: 500000 })?.replyCostThreshold).toBe(500000)
    expect(parseIdlePrefs({ replyCostThreshold: -1 })?.replyCostThreshold).toBe(300_000)
  })
})
