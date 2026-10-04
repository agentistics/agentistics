/**
 * tool-events-additive.test.ts — TOOL.1 and TOOL.3 widened the vocabulary by exactly four types (ES.6f).
 * D20-style: nothing was removed or moved, the new ones are appended, typed, and carry COUNTS only — never
 * the submitted value, a validation message, a plan step's text or the injected message.
 */
import { describe, expect, test } from 'bun:test'
import type { AgentisticsEvent, CompletionBlockedData, CompletionReleasedData, StructuredAttemptData } from './event'
import { CANONICAL_EVENT_SCHEMA, EVENT_TYPES } from './event'

const envelope = {
  schema: CANONICAL_EVENT_SCHEMA, occurredAt: '2026-10-03T12:00:00.000Z', recordedAt: '2026-10-03T12:00:01.000Z',
  source: { kind: 'harness' as const, id: 'agentistics' }, provenance: { mode: 'instrumented' as const, confidence: 'exact' as const, adapterVersion: '1.0.0' },
}

describe('TOOL.1 / TOOL.3 vocabulary', () => {
  test('exactly four new types, appended after the previous tail; unique; none removed', () => {
    const added = ['structured.attempt', 'structured.exhausted', 'completion.blocked', 'completion.released']
    for (const t of added) expect(EVENT_TYPES).toContain(t as never)
    // Appended: the four are the tail, in order, after every type that existed before them (the native
    // queue's H24/memory/ART.2 types landed in the same release, ahead of them).
    expect(EVENT_TYPES.slice(-added.length)).toEqual(added as never)
    expect(EVENT_TYPES.indexOf('turn.ended')).toBeLessThan(EVENT_TYPES.indexOf('structured.attempt' as never))
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length)
  })
  test('shapes are typed counts: no text field exists to put a value or a message in', () => {
    const attempt: AgentisticsEvent<'structured.attempt'> = { ...envelope, eventId: 's1', type: 'structured.attempt', data: { attempt: 1, ok: false, errorCount: 2, submitted: true, invocationId: 'inv_1' } }
    const exhausted: AgentisticsEvent<'structured.exhausted'> = { ...envelope, eventId: 's2', type: 'structured.exhausted', data: { attempts: 3 } }
    const blocked: AgentisticsEvent<'completion.blocked'> = { ...envelope, eventId: 'c1', type: 'completion.blocked', data: { openItems: 2, attempt: 1, rule: 'open-plan' } }
    const released: AgentisticsEvent<'completion.released'> = { ...envelope, eventId: 'c2', type: 'completion.released', data: { reason: 'forced-limit', openItems: 1 } }
    // @ts-expect-error — the point: this shape has no such field/word
    const badAttempt: StructuredAttemptData = { attempt: 1, ok: true, errorCount: 0, submitted: true, invocationId: 'i', value: 'x' }
    // @ts-expect-error — the point: this shape has no such field/word
    const badBlocked: CompletionBlockedData = { openItems: 1, attempt: 1, rule: 'because' }
    // @ts-expect-error — the point: this shape has no such field/word
    const badReleased: CompletionReleasedData = { reason: 'bored', openItems: 0 }
    expect([attempt, exhausted, blocked, released, badAttempt, badBlocked, badReleased].length).toBe(7)
  })
})
