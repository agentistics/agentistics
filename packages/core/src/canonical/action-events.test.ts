/**
 * action-events.test.ts — ADAPTER.LIMITES A2: `action.claimed` / `action.settled`. Appended to the vocabulary,
 * typed, and carrying ids, a key, a hash and a receipt object — never conversation text (D5).
 */
import { describe, expect, test } from 'bun:test'
import type { ActionClaimedData, ActionSettledData, AgentisticsEvent } from './event'
import { ACTION_KINDS, CANONICAL_EVENT_SCHEMA, EVENT_TYPES, isEventType } from './event'

const envelope = {
  schema: CANONICAL_EVENT_SCHEMA, occurredAt: '2026-11-01T12:00:00.000Z', recordedAt: '2026-11-01T12:00:01.000Z',
  source: { kind: 'adapter' as const, id: 'sess_1' }, provenance: { mode: 'instrumented' as const, confidence: 'exact' as const, adapterVersion: '1.0.0' },
}

describe('ADAPTER.LIMITES action events', () => {
  test('both types are in the closed vocabulary, once, at the tail', () => {
    expect(EVENT_TYPES.slice(-2)).toEqual(['action.claimed', 'action.settled'] as never)
    expect(isEventType('action.claimed')).toBe(true)
    expect(isEventType('action.settled')).toBe(true)
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length)
  })
  test('the action kinds are the six the ledger keys', () => {
    expect([...ACTION_KINDS]).toEqual(['submit', 'amend', 'cancel', 'answer', 'set-mode', 'set-model'])
  })
  test('shapes: no text field exists to put a message in', () => {
    const claimed: AgentisticsEvent<'action.claimed'> = { ...envelope, eventId: 'a1', type: 'action.claimed', data: { key: 'call1:t2:1', kind: 'submit', requestId: 'r1', argsHash: 'ab'.repeat(32), harness: 'codex', driver: 'codex-app-server' } }
    const settled: AgentisticsEvent<'action.settled'> = { ...envelope, eventId: 'a2', type: 'action.settled', data: { key: 'call1:t2:1', result: { state: 'queued', requestId: 'r1', at: 'x' }, revision: 0 } }
    // @ts-expect-error — the point: an action outside the six is not a claim
    const badKind: ActionClaimedData = { key: 'k', kind: 'prompt', requestId: 'r', argsHash: 'h', harness: 'h', driver: 'd' }
    // @ts-expect-error — the point: a settlement is keyed, never carries `text`
    const badSettled: ActionSettledData = { key: 'k', result: {}, revision: 0, text: 'hi' }
    expect([claimed, settled, badKind, badSettled].length).toBe(4)
  })
})
