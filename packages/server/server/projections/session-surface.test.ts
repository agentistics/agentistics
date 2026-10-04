/**
 * session-surface.test.ts — LIVE.2's projection (spec 2026-10-02-live-sessions-from-journal §3, with the
 * owner's Q3: a deleted or expired transcript shows METRICS ONLY, so the projection holds NUMBERS and
 * attention marks, never a turn, a tool summary or any text). P1 §8's properties, plus the lookup key.
 */
import { describe, expect, test } from 'bun:test'
import { CANONICAL_EVENT_SCHEMA, deriveEventId, project, type AgentisticsEvent, type AnyAgentisticsEvent, type EventData, type EventType } from '@agentistics/core'
import { STORED_PROJECTIONS, SESSION_SURFACE } from './catalog'
import { fixtureEvents, groupBy, shuffled } from './synthetic-events'
import { SESSION_SURFACE_MAX_MARKS, sessionSurfaceKey, sessionSurfaceProjection } from './session-surface'
import { decodeState, encodeState } from './state-codec'

const EVENTS = await fixtureEvents()
const BY_SESSION = groupBy(EVENTS, e => e.sessionId ?? null)

function ev<T extends EventType>(n: number, type: T, data: EventData[T], at: string): AnyAgentisticsEvent {
  const e: AgentisticsEvent<T> = {
    eventId: deriveEventId({ sourceKind: 'harness', sourceId: 'claude-screen', sourceRef: `t:${type}:${n}`, type, ordinal: 0 }),
    schema: CANONICAL_EVENT_SCHEMA, type, occurredAt: at, recordedAt: at, sessionId: 'ses_a', runId: 'run_a',
    source: { kind: 'harness', id: 'claude-screen' },
    provenance: { mode: 'instrumented', confidence: 'exact', adapterVersion: 't/1', sourceRef: `t:${n}` },
    data,
  }
  return e as unknown as AnyAgentisticsEvent
}

const RUN = ev(0, 'run.started', { harness: 'claude', conversationId: 'conv-1', conversationLink: 'exact' } as unknown as EventData['run.started'], '2026-10-01T10:00:00.000Z')
const raised = (n: number, at: string, over: Partial<EventData['attention.raised']> = {}) =>
  ev(n, 'attention.raised', { kind: 'approval', optionCount: 3, via: 'screen', ...over }, at)
const cleared = (n: number, at: string, over: Partial<EventData['attention.cleared']> = {}) =>
  ev(n, 'attention.cleared', { how: 'answered-here', choice: 1, blockedMs: 4000, ...over }, at)

describe('what a row says', () => {
  test('numbers and marks, filed under the conversation key a reader looks up', () => {
    const r = project(sessionSurfaceProjection, [
      RUN,
      ev(1, 'turn.started', { by: 'user' }, '2026-10-01T10:00:05.000Z'),
      ev(2, 'model.completed', { provider: 'anthropic', model: 'claude-opus-5-5', usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 }, status: 'completed' } as EventData['model.completed'], '2026-10-01T10:00:09.000Z'),
      raised(3, '2026-10-01T10:00:10.000Z'),
      cleared(4, '2026-10-01T10:00:14.000Z'),
      ev(5, 'turn.started', { by: 'user' }, '2026-10-01T10:05:00.000Z'),
    ])
    expect(r?.key).toBe(sessionSurfaceKey('claude', 'conv-1'))
    expect(r).toMatchObject({
      harness: 'claude', conversationId: 'conv-1', firstAt: '2026-10-01T10:00:00.000Z', lastAt: '2026-10-01T10:05:00.000Z',
      turns: 2, models: ['claude-opus-5-5'], tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 },
      attention: [{ at: '2026-10-01T10:00:10.000Z', kind: 'approval', via: 'screen', optionCount: 3, how: 'answered-here', choice: 1, blockedMs: 4000 }],
    })
    expect(r?.openAttention).toBeUndefined()
  })

  test('absent is not zero: no model response → tokens is null; nothing is invented', () => {
    const r = project(sessionSurfaceProjection, [RUN])
    expect(r?.tokens).toBeNull()
    expect(r?.turns).toBe(0)
  })

  test('a raised with no clear is the OPEN one (history, never a button)', () => {
    const r = project(sessionSurfaceProjection, [RUN, raised(1, '2026-10-01T10:01:00.000Z', { kind: 'question' })])
    expect(r?.openAttention).toMatchObject({ at: '2026-10-01T10:01:00.000Z', kind: 'question' })
    expect(r?.attention).toHaveLength(1)
  })

  test('marks are capped to the most recent', () => {
    const evs = [RUN]
    for (let i = 0; i < SESSION_SURFACE_MAX_MARKS + 7; i++) {
      const at = new Date(Date.UTC(2026, 9, 1, 11, 0, i)).toISOString()
      evs.push(raised(100 + i * 2, at), cleared(101 + i * 2, new Date(Date.UTC(2026, 9, 1, 11, 0, i, 500)).toISOString()))
    }
    const r = project(sessionSurfaceProjection, evs)
    expect(r?.attention).toHaveLength(SESSION_SURFACE_MAX_MARKS)
    expect(r?.attention.at(-1)?.at).toBe(new Date(Date.UTC(2026, 9, 1, 11, 0, SESSION_SURFACE_MAX_MARKS + 6)).toISOString())
  })

  test('D5: no text of any kind is in a row (nothing but the closed key set below)', () => {
    const r = project(sessionSurfaceProjection, [RUN, raised(1, '2026-10-01T10:01:00.000Z'), cleared(2, '2026-10-01T10:01:05.000Z')])
    expect(Object.keys(r!).sort()).toEqual(['attention', 'conversationId', 'firstAt', 'harness', 'key', 'lastAt', 'models', 'sessionId', 'tokens', 'toolCalls', 'toolsDenied', 'toolsFailed', 'turns'])
  })

  test('a session whose events never named its conversation files no row (a reader could not look it up)', () => {
    const r = project(sessionSurfaceProjection, [ev(1, 'turn.started', { by: 'user' }, '2026-10-01T10:00:00.000Z')])
    expect(SESSION_SURFACE.rows(r)).toEqual([])
  })

  test('the stored row is filed by the lookup key in the `day` column', () => {
    const r = project(sessionSurfaceProjection, [RUN])
    expect(SESSION_SURFACE.rows(r)).toEqual([{ day: sessionSurfaceKey('claude', 'conv-1'), data: r }])
    expect(STORED_PROJECTIONS).toContain(SESSION_SURFACE)
  })
})

describe('P1 §8 properties over the synthetic stream', () => {
  test('every split point, through the state codec, equals folding whole; any order; a repeat changes nothing', () => {
    for (const [, evs] of BY_SESSION) {
      const whole = project(sessionSurfaceProjection, evs)
      for (const cut of [1, Math.floor(evs.length / 2), evs.length - 1]) {
        let st = sessionSurfaceProjection.empty()
        sessionSurfaceProjection.fold(st, evs.slice(0, cut))
        st = decodeState(encodeState(st))
        sessionSurfaceProjection.fold(st, evs.slice(cut))
        expect(sessionSurfaceProjection.finish(st)).toEqual(whole)
      }
      expect(project(sessionSurfaceProjection, shuffled(evs, 7))).toEqual(whole)
      expect(project(sessionSurfaceProjection, [...evs, ...evs])).toEqual(whole)
    }
  })

  test('the synthetic sessions each get a row with real counts', () => {
    const rows = [...BY_SESSION.values()].map(evs => project(sessionSurfaceProjection, evs)).filter(Boolean)
    expect(rows.length).toBeGreaterThanOrEqual(8)
    expect(rows.every(r => r!.turns >= 0 && r!.toolCalls >= 0)).toBe(true)
    expect(rows.some(r => r!.toolCalls > 0)).toBe(true)
  })
})
