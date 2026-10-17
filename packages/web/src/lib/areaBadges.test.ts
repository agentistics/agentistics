import { describe, expect, it } from 'bun:test'
import { areaBadges } from './areaBadges'

describe('areaBadges', () => {
  it('maps each source to its area', () => {
    expect(areaBadges({
      attention: 4,
      usageRows: [{ paceStatus: 'over' }, { status: 'hold' }, { paceStatus: 'under' }],
      checkinsOverdue: 2,
    })).toEqual({ sessions: 4, usage: 2, leadership: 2 })
  })
  it('leaves the key absent when the source did not answer or counts zero', () => {
    expect(areaBadges({})).toEqual({})
    expect(areaBadges({ attention: 0, usageRows: [{ paceStatus: 'under' }], checkinsOverdue: 0 })).toEqual({})
  })
})
