import { describe, expect, it } from 'bun:test'
import { activeCapProviders, awayUntilLabel, untilFromChoice } from './awayMode'

describe('away mode helpers', () => {
  const now = new Date(2026, 9, 11, 23, 50).getTime()
  it('maps choices to instants on the local clock', () => {
    expect(untilFromChoice('back', now)).toBeNull()
    expect(Date.parse(untilFromChoice('2h', now)!)).toBe(now + 2 * 3_600_000)
    const t = new Date(untilFromChoice('tomorrow9', now)!)
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([12, 9, 0])
  })
  it('labels the until', () => {
    expect(awayUntilLabel({ on: true, since: '', until: null, authorised: [], maxWorkers: 6, topCaps: {} }, 'en', now)).toBe("until you're back")
    expect(awayUntilLabel({ on: true, since: '', until: new Date(now + 3_600_000).toISOString(), authorised: [], maxWorkers: 6, topCaps: {} }, 'pt', now)).toMatch(/^até /)
  })
})

describe('activeCapProviders', () => {
  const order = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode', 'agentistics']
  it('lists only providers with an active plan or a stored ceiling, in display order', () => {
    expect(activeCapProviders(order, [{ harness: 'codex' }], [{ harness: 'claude' }], {})).toEqual(['claude', 'codex'])
    expect(activeCapProviders(order, null, [], { gemini: 1 })).toEqual(['gemini'])
    expect(activeCapProviders(order, [], [], {})).toEqual([])
  })
  it('never lists a harness no ceiling can name', () => {
    expect(activeCapProviders(order, [{ harness: 'agentistics' }], [], {})).toEqual([])
  })
})
