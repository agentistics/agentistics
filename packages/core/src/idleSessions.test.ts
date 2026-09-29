import { describe, expect, it } from 'bun:test'
import { defaultGroupFor, freedBytes, idleCandidates, idleNotifyStep, suggestGroup, type IdleRowInput } from './idleSessions'

const H = 3_600_000
const NOW = 1_800_000_000_000
const row = (o: Partial<IdleRowInput> = {}): IdleRowInput => ({
  id: 'a', state: 'waiting', managed: true, lastUserMessageAt: NOW - 3 * H, ...o,
})
const opts = { now: NOW, thresholdMs: 2 * H, pressureThresholdMs: 0.5 * H, underPressure: false, openSessionId: null, kept: {} }

describe('idleCandidates', () => {
  it('takes a waiting managed session past the threshold', () => {
    expect(idleCandidates([row()], opts).map(c => c.row.id)).toEqual(['a'])
  })
  it('never takes working, waiting-approval or ended rows', () => {
    for (const state of ['working', 'waiting-approval', 'exited', 'lost', 'closed', 'unknown']) {
      expect(idleCandidates([row({ state })], opts)).toEqual([])
    }
  })
  it('never takes an external row', () => {
    expect(idleCandidates([row({ managed: false })], opts)).toEqual([])
  })
  it('never takes a row whose last message is unknown', () => {
    expect(idleCandidates([row({ lastUserMessageAt: undefined })], opts)).toEqual([])
  })
  it('respects the threshold, and the shorter one under pressure', () => {
    const r = row({ lastUserMessageAt: NOW - 1 * H })
    expect(idleCandidates([r], opts)).toEqual([])
    expect(idleCandidates([r], { ...opts, underPressure: true })).toHaveLength(1)
  })
  it('skips the session open on screen, matched by id or conversation id', () => {
    expect(idleCandidates([row()], { ...opts, openSessionId: 'a' })).toEqual([])
    expect(idleCandidates([row({ conversationId: 'c1' })], { ...opts, openSessionId: 'c1' })).toEqual([])
  })
  it('a keep silences until a newer message', () => {
    const r = row({ conversationId: 'c1' })
    expect(idleCandidates([r], { ...opts, kept: { c1: NOW - 1 * H } })).toEqual([])
    const later = row({ conversationId: 'c1', lastUserMessageAt: NOW - 2.5 * H })
    expect(idleCandidates([later], { ...opts, kept: { c1: NOW - 3 * H } })).toHaveLength(1)
  })
  it('orders delivered tasks first, then heaviest, then longest idle', () => {
    const out = idleCandidates([
      row({ id: 'light', rssBytes: 1 }),
      row({ id: 'heavy', rssBytes: 9 }),
      row({ id: 'done', rssBytes: 0, taskDone: true }),
      row({ id: 'unknownMem', rssBytes: null }),
    ], opts).map(c => c.row.id)
    expect(out).toEqual(['done', 'heavy', 'light', 'unknownMem'])
  })
  it('flags reasons', () => {
    const [c] = idleCandidates([row({ taskDone: true, contextFraction: 0.9 })], opts)
    expect(c!.reasons).toEqual(['task-delivered', 'context-full'])
  })
})

describe('suggestGroup', () => {
  const rows = [row({ id: 'a', taskId: 't1' }), row({ id: 'b', taskId: 't1' }), row({ id: 'c', taskId: 't1' })]
  const [cand] = idleCandidates([rows[0]!], opts)
  it('prefers the group holding the most sessions of the same task', () => {
    const groups = [
      { id: 'g1', name: 'one', sessionKeys: ['b'] },
      { id: 'g2', name: 'two', sessionKeys: ['b', 'c'] },
    ]
    // 'b' can only be in one group in reality; the pure function counts what it is given.
    expect(suggestGroup(cand!, groups, rows, 'Task one', '2026-09-25')).toEqual({ kind: 'existing', groupId: 'g2', name: 'two' })
  })
  it('falls back to a new group named after the task', () => {
    expect(suggestGroup(cand!, [], rows, 'Task one', '2026-09-25')).toEqual({ kind: 'new', name: 'Task one' })
  })
  it('falls back to a dated group, reusing it when it exists', () => {
    const [plain] = idleCandidates([row({ id: 'z' })], opts)
    expect(suggestGroup(plain!, [], [], undefined, '2026-09-25')).toEqual({ kind: 'new', name: 'Idle · 2026-09-25' })
    expect(suggestGroup(plain!, [{ id: 'gd', name: 'Idle · 2026-09-25', sessionKeys: [] }], [], undefined, '2026-09-25'))
      .toEqual({ kind: 'existing', groupId: 'gd', name: 'Idle · 2026-09-25' })
  })
})

describe('defaultGroupFor', () => {
  const rows = [row({ id: 'a', taskId: 't1' }), row({ id: 'b', taskId: 't1' })]
  const [cand] = idleCandidates([rows[0]!], opts)
  it('prefers the group already holding the candidate, ahead of the task rule', () => {
    const groups = [
      { id: 'g-current', name: 'Saved to later', sessionKeys: ['a'] },
      // Would win under `suggestGroup`'s own task rule (most sessions of the same task) — must lose.
      { id: 'g-task', name: 'Task group', sessionKeys: ['b'] },
    ]
    expect(defaultGroupFor(cand!, groups, rows, 'Task one', '2026-09-25'))
      .toEqual({ kind: 'existing', groupId: 'g-current', name: 'Saved to later' })
  })
  it('delegates to suggestGroup when the candidate is in no group', () => {
    const groups = [{ id: 'g-task', name: 'Task group', sessionKeys: ['b'] }]
    expect(defaultGroupFor(cand!, groups, rows, 'Task one', '2026-09-25'))
      .toEqual(suggestGroup(cand!, groups, rows, 'Task one', '2026-09-25'))
  })
  it('delegates all the way to the dated fallback when nothing else applies', () => {
    const [plain] = idleCandidates([row({ id: 'z' })], opts)
    expect(defaultGroupFor(plain!, [], [], undefined, '2026-09-25')).toEqual({ kind: 'new', name: 'Idle · 2026-09-25' })
  })
})

describe('idleNotifyStep', () => {
  const cs = idleCandidates([row({ id: 'a' }), row({ id: 'b' })], opts)
  it('notifies when a session joins, not on a repeat', () => {
    const first = idleNotifyStep(new Set(), cs)
    expect(first.notify).toBe(true)
    expect(idleNotifyStep(first.next, cs).notify).toBe(false)
  })
  it('does not notify when the batch only shrinks, and forgets the ones gone', () => {
    const r = idleNotifyStep(new Set(['a', 'b']), cs.slice(0, 1))
    expect(r.notify).toBe(false)
    expect([...r.next]).toEqual(['a'])
  })
})

describe('freedBytes', () => {
  it('sums the known and is null when none is known', () => {
    expect(freedBytes(idleCandidates([row({ rssBytes: 2 }), row({ id: 'b', rssBytes: 3 })], opts))).toBe(5)
    expect(freedBytes(idleCandidates([row({ rssBytes: null })], opts))).toBe(null)
  })
})
