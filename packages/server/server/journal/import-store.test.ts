import { describe, expect, test } from 'bun:test'
import { CAPABILITY_STATES, type CapabilityState, type SessionMeta } from '@agentistics/core'
import * as claudeCore from '../integrations/claude/replay-core'
import { sessionMetaProjection } from '../projections/session-meta'
import { rejectionOf } from './journal-plan'
import {
  coarseConfidence, IMPORT_STORE_ADAPTER_VERSION, IMPORT_STORE_SOURCE_ID, normaliseInstant, storedCounter,
  storeSessionEvents, type StoreEventContext,
} from './import-store'

const SUPPORTED: CapabilityState = { state: 'supported', exactness: 'exact' }
const PARTIAL: CapabilityState = { state: 'partial', exactness: 'exact', limit: 'x' }

function meta(extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: 'conv-1', harness: 'claude', project_path: '/work/p', start_time: '2026-01-02T03:04:05Z',
    end_time: '2026-01-02T04:00:00Z', model: 'claude-opus-5', first_prompt: 'SECRET PROMPT', title: 'SECRET TITLE',
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
    context_tokens: 1234, git_remote: 'github.com/o/r',
    ...extra,
  } as SessionMeta
}

const ctx = (extra: Partial<StoreEventContext> = {}): StoreEventContext => ({
  harness: 'claude', ids: claudeCore, tokens: SUPPORTED, sourceRef: 'consolidate:claude/conv-1.json',
  recordedAt: '2026-09-27T00:00:00.000Z', ...extra,
})

describe('storeSessionEvents', () => {
  test('lifecycle + one model.completed, all exact, replayed, carrying the harness entity ids', () => {
    const r = storeSessionEvents(meta(), ctx())
    if (!r.ok) throw new Error(r.reason)
    expect(r.events.map(e => e.type)).toEqual([
      'session.started', 'run.started', 'agent.started', 'model.completed', 'agent.ended', 'run.ended', 'session.ended',
    ])
    expect(r.runId).toBe(claudeCore.runIdOf('conv-1'))
    for (const e of r.events) {
      expect(e.provenance).toEqual({ mode: 'replayed', confidence: 'exact', adapterVersion: IMPORT_STORE_ADAPTER_VERSION, sourceRef: 'consolidate:claude/conv-1.json' })
      expect(e.source.id).toBe(IMPORT_STORE_SOURCE_ID)
      expect(e.runId).toBe(claudeCore.runIdOf('conv-1'))
      expect(e.sessionId).toBe(claudeCore.sessionIdOf('conv-1'))
    }
    const mc = r.events[3]!
    expect(mc.agentId).toBe(claudeCore.mainAgentIdOf('conv-1'))
    expect(mc.occurredAt).toBe('2026-01-02T04:00:00.000Z')
    expect(mc.data).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5', usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, contextTokens: 1234 })
    expect(r.events[0]!.occurredAt).toBe('2026-01-02T03:04:05.000Z')
  })

  test('D5: no conversation text reaches an event', () => {
    const r = storeSessionEvents(meta(), ctx())
    if (!r.ok) throw new Error(r.reason)
    const text = JSON.stringify(r.events)
    expect(text).not.toContain('SECRET')
  })

  test('ids are derived: a re-import (another clock) re-derives the same ids', () => {
    const a = storeSessionEvents(meta(), ctx())
    const b = storeSessionEvents(meta(), ctx({ recordedAt: '2030-01-01T00:00:00.000Z' }))
    if (!a.ok || !b.ok) throw new Error('refused')
    expect(a.events.map(e => e.eventId)).toEqual(b.events.map(e => e.eventId))
    expect(new Set(a.events.map(e => e.eventId)).size).toBe(a.events.length)
  })

  test('the journal plan accepts every event (timestamps normalised)', () => {
    const r = storeSessionEvents(meta(), ctx())
    if (!r.ok) throw new Error(r.reason)
    expect(r.events.map(rejectionOf)).toEqual(r.events.map(() => null))
  })

  test('D21: an absent counter stays absent; a partial capability turns a stored 0 into absent', () => {
    const r = storeSessionEvents(meta({ cache_read_input_tokens: undefined, cache_creation_input_tokens: 0 }), ctx({ tokens: PARTIAL }))
    if (!r.ok) throw new Error(r.reason)
    const usage = (r.events.find(e => e.type === 'model.completed')!.data as { usage: object }).usage
    expect(usage).toEqual({ input: 10, output: 20 })
    // supported: a 0 is a measurement
    const s = storeSessionEvents(meta({ cache_creation_input_tokens: 0 }), ctx())
    if (!s.ok) throw new Error(s.reason)
    expect((s.events.find(e => e.type === 'model.completed')!.data as { usage: { cacheWrite?: number } }).usage.cacheWrite).toBe(0)
  })

  test('no counter left → no model.completed at all, never a zero-token event', () => {
    const r = storeSessionEvents(meta({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), ctx({ tokens: PARTIAL }))
    if (!r.ok) throw new Error(r.reason)
    expect(r.events.some(e => e.type === 'model.completed')).toBe(false)
  })

  test('model_usage → one model.completed per model, in model order, gauge only on the session model', () => {
    const r = storeSessionEvents(meta({
      model: 'claude-opus-5',
      model_usage: {
        'gemini-3.6-flash': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 },
        'claude-opus-5': { inputTokens: 4, outputTokens: 5, cacheReadInputTokens: 6, cacheCreationInputTokens: 7, webSearchRequests: 0, costUSD: 0 },
      },
    }), ctx())
    if (!r.ok) throw new Error(r.reason)
    const mcs = r.events.filter(e => e.type === 'model.completed').map(e => e.data as { model: string; contextTokens?: number; provider: string })
    expect(mcs.map(m => m.model)).toEqual(['claude-opus-5', 'gemini-3.6-flash'])
    expect(mcs[0]!.contextTokens).toBe(1234)
    expect(mcs[1]!.contextTokens).toBeUndefined()
    expect(mcs[1]!.provider).toBe('google')
  })

  test('refusals are named: no session id, no parseable start', () => {
    expect(storeSessionEvents(meta({ session_id: '' }), ctx())).toEqual({ ok: false, reason: 'no-session-id' })
    expect(storeSessionEvents(meta({ start_time: 'garbage' }), ctx())).toEqual({ ok: false, reason: 'no-timestamps' })
  })

  test('an end before the start closes at the start', () => {
    const r = storeSessionEvents(meta({ end_time: '2020-01-01T00:00:00Z' }), ctx())
    if (!r.ok) throw new Error(r.reason)
    expect(r.events.at(-1)!.occurredAt).toBe('2026-01-02T03:04:05.000Z')
  })

  test('the session-meta projection reads the coarse set back as the store counters', () => {
    const r = storeSessionEvents(meta(), ctx())
    if (!r.ok) throw new Error(r.reason)
    const s = sessionMetaProjection.empty()
    sessionMetaProjection.fold(s, r.events as never)
    const p = sessionMetaProjection.finish(s)
    expect(p.meta.input_tokens).toBe(10)
    expect(p.meta.output_tokens).toBe(20)
    expect(p.meta.cache_read_input_tokens).toBe(30)
    expect(p.meta.cache_creation_input_tokens).toBe(40)
  })
})

describe('helpers', () => {
  test('coarseConfidence is D17', () => {
    expect(coarseConfidence('counter')).toBe('exact')
    expect(coarseConfidence('priced')).toBe('estimated')
  })
  test('normaliseInstant', () => {
    expect(normaliseInstant('2026-01-02T03:04:05Z')).toBe('2026-01-02T03:04:05.000Z')
    expect(normaliseInstant(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(normaliseInstant('')).toBeNull()
    expect(normaliseInstant(undefined)).toBeNull()
  })
  test('storedCounter', () => {
    expect(storedCounter(0, SUPPORTED)).toBe(0)
    expect(storedCounter(0, PARTIAL)).toBeUndefined()
    expect(storedCounter(-1, SUPPORTED)).toBeUndefined()
    expect(storedCounter(5, CAPABILITY_STATES.claude.tokens)).toBe(5)
    expect(storedCounter(5, { state: 'not_supported', reason: 'r', source: 's' })).toBeUndefined()
  })
})
