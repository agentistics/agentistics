import { describe, expect, it } from 'bun:test'
import { awayUntilLabel, untilFromChoice } from './awayMode'

describe('away mode helpers', () => {
  const now = new Date(2026, 9, 11, 23, 50).getTime()
  it('maps choices to instants on the local clock', () => {
    expect(untilFromChoice('back', now)).toBeNull()
    expect(Date.parse(untilFromChoice('2h', now)!)).toBe(now + 2 * 3_600_000)
    const t = new Date(untilFromChoice('tomorrow9', now)!)
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([12, 9, 0])
  })
  it('labels the until', () => {
    expect(awayUntilLabel({ on: true, since: '', until: null, authorised: [], maxWorkers: 6, maxOpus: 2 }, 'en', now)).toBe("until you're back")
    expect(awayUntilLabel({ on: true, since: '', until: new Date(now + 3_600_000).toISOString(), authorised: [], maxWorkers: 6, maxOpus: 2 }, 'pt', now)).toMatch(/^até /)
  })
})
