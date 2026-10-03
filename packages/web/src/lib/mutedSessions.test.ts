import { describe, expect, it } from 'bun:test'
import { planMute } from './mutedSessions'

describe('planMute', () => {
  it('mutes and unmutes by key', () => {
    expect(planMute([], 'a', true)).toEqual(['a'])
    expect(planMute(['a', 'b'], 'a', false)).toEqual(['b'])
  })
  it('is idempotent', () => {
    expect(planMute(['a'], 'a', true)).toEqual(['a'])
    expect(planMute(['a'], 'z', false)).toEqual(['a'])
  })
  it('never mutates its input', () => {
    const cur = ['a']
    planMute(cur, 'b', true)
    expect(cur).toEqual(['a'])
  })
})
