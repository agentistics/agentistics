import { describe, expect, it } from 'bun:test'
import { LEADER_METER_TONE, leaderMeterState, leaderMeterStateLabel } from './leaderMeter'

describe('leader meter state', () => {
  it('follows the live handoff level', () => {
    expect(leaderMeterState('normal', 117_000)).toBe('normal')
    expect(leaderMeterState('near', 180_000)).toBe('attention')
    expect(leaderMeterState('due', 200_000)).toBe('critical')
    expect(leaderMeterState('overdue', 260_000)).toBe('critical')
  })
  it('says "no reading" when there is no gauge, whatever the level claims — null is not zero', () => {
    for (const level of ['normal', 'near', 'due', 'overdue'] as const) expect(leaderMeterState(level, null)).toBe('none')
    expect(leaderMeterState('normal', 0)).toBe('normal')
  })
  it('paints every state in a distinct app colour token, never a raw hex', () => {
    const tones = Object.values(LEADER_METER_TONE)
    expect(new Set(tones).size).toBe(4)
    for (const t of tones) expect(t).toMatch(/^var\(--[a-z-]+\)$/)
  })
  it('names the four states distinctly in both languages', () => {
    for (const pt of [true, false]) expect(new Set((['normal', 'attention', 'critical', 'none'] as const).map(s => leaderMeterStateLabel(s, pt))).size).toBe(4)
  })
})
