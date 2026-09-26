import { describe, expect, it } from 'bun:test'
import { DEFAULT_IDLE_PREFS, parseIdlePrefs } from './idleSessionsPrefs'

describe('parseIdlePrefs', () => {
  it('absent reads as the defaults (enabled, 120/30)', () => {
    expect(parseIdlePrefs(undefined)).toEqual(DEFAULT_IDLE_PREFS)
  })
  it('keeps valid values and repairs invalid ones field by field', () => {
    expect(parseIdlePrefs({ enabled: false, thresholdMin: 60, pressureThresholdMin: -5, kept: { a: 1, b: 'x' } }))
      .toEqual({ enabled: false, thresholdMin: 60, pressureThresholdMin: 30, kept: { a: 1 } })
  })
})
