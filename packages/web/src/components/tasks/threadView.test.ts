import { describe, expect, test } from 'bun:test'
import { daysSince, liveSessionsOf, mixOf, participantState, replyReach } from './threadView'

const R = (id: string, state: string, o: { conversationId?: string; actionable?: boolean } = {}) =>
  ({ id, state, actionable: o.actionable ?? true, ...(o.conversationId ? { conversationId: o.conversationId } : {}) })

describe('liveSessionsOf', () => {
  test('counts running rows of the task by id or by conversation, once each', () => {
    const rows = [R('a', 'working'), R('b', 'exited'), R('c', 'waiting', { conversationId: 'cb' }), R('z', 'working')]
    const live = liveSessionsOf([{ id: 'a' }, { id: 'b', conversationId: 'cb' }], rows)
    expect(live.map(r => r.id)).toEqual(['a', 'c'])
  })
})

describe('mixOf', () => {
  test('shares by tokens, largest first, rounded down; unmeasured left out', () => {
    expect(mixOf([{ key: 'codex', tokens: 2 }, { key: 'claude', tokens: 998 }, { key: 'gemini', tokens: null }]))
      .toEqual([{ key: 'claude', pct: 99.8 }, { key: 'codex', pct: 0.2 }])
    expect(mixOf([{ key: 'x', tokens: null }])).toEqual([])
  })
})

describe('daysSince', () => {
  test('whole days, never negative, null on junk', () => {
    expect(daysSince('2026-10-01T00:00:00Z', Date.parse('2026-10-04T12:00:00Z'))).toBe(3)
    expect(daysSince('2026-10-05T00:00:00Z', Date.parse('2026-10-04T00:00:00Z'))).toBe(0)
    expect(daysSince('nope', 0)).toBeNull()
    expect(daysSince(undefined, 0)).toBeNull()
  })
})

describe('replyReach', () => {
  test('now vs on reopen vs not at all', () => {
    const ps = ['a', 'b', 'c', 'd'].map(s => ({ sessionId: s, joinedAt: '' }))
    const rows = [R('a', 'working'), R('b', 'exited'), R('c', 'working', { actionable: false }), R('d', 'waiting')]
    expect(replyReach(ps, rows, ['d'])).toEqual({ now: 1, queued: 1, total: 2 })
  })
  test('participantState reads the standing row', () => {
    expect(participantState({ sessionId: 'a', joinedAt: '' }, [R('a', 'waiting')])).toBe('waiting')
    expect(participantState({ sessionId: 'q', joinedAt: '' }, [])).toBeNull()
  })
})
