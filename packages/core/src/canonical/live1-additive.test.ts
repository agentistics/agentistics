/**
 * live1-additive.test.ts — LIVE.1 widened the vocabulary by exactly two types. D20-style: the
 * pre-LIVE types still compile as written, the new ones are typed and carry no text.
 */
import { describe, expect, test } from 'bun:test'
import type { AgentisticsEvent, AttentionClearedData, AttentionRaisedData } from './event'
import { CANONICAL_EVENT_SCHEMA, EVENT_TYPES } from './event'

const envelope = {
  schema: CANONICAL_EVENT_SCHEMA,
  occurredAt: '2026-10-02T12:00:00.000Z',
  recordedAt: '2026-10-02T12:00:01.000Z',
  source: { kind: 'harness' as const, id: 'claude-screen' },
  provenance: { mode: 'observed' as const, confidence: 'exact' as const, adapterVersion: '1.0.0' },
}

const raised: AgentisticsEvent<'attention.raised'> = {
  ...envelope, eventId: 'a1', type: 'attention.raised',
  data: { kind: 'select', optionCount: 3, hasFreeText: true, via: 'screen' },
}
const cleared: AgentisticsEvent<'attention.cleared'> = {
  ...envelope, eventId: 'a2', type: 'attention.cleared', data: { how: 'answered-here', choice: 2, blockedMs: 4000 },
}
// A pre-LIVE type still compiles exactly as before.
const old: AgentisticsEvent<'tool.approved'> = { ...envelope, eventId: 'o1', type: 'tool.approved', data: { by: 'user' } as never }

describe('LIVE.1 vocabulary', () => {
  test('exactly two new types, appended, none removed', () => {
    expect(EVENT_TYPES).toContain('attention.raised')
    expect(EVENT_TYPES).toContain('attention.cleared')
    expect(EVENT_TYPES.indexOf('attention.raised')).toBe(EVENT_TYPES.indexOf('policy.denied') + 1)
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length)
    expect(old.type).toBe('tool.approved')
  })
  test('shapes are typed and carry no text', () => {
    // @ts-expect-error — an option LABEL is not a field: no text crosses into the journal
    const bad: AttentionRaisedData = { kind: 'select', via: 'screen', label: 'x' }
    // @ts-expect-error — `via` is closed to 'screen'
    const bad2: AttentionRaisedData = { kind: 'select', via: 'hook' }
    // @ts-expect-error — `how` is a closed set
    const bad3: AttentionClearedData = { how: 'because' }
    expect([raised.data.kind, cleared.data.how, bad, bad2, bad3].length).toBe(5)
  })
})
