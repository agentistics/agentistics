/**
 * chat-web-surface.test.ts — LIVE.2 through the chat payload: C2 (without an engine, or with the flag
 * off, the payload is the legacy object ITSELF), C3 (every answer keeps its sentence or its turns),
 * and the owner's Q3 (a gone transcript gets numbers only — never turns, tool summaries or text).
 */
import { describe, expect, test } from 'bun:test'
import type { TranscriptAvailability } from '@agentistics/core'
import { mergeSessionSurface, type ChatPayload } from './chat-web'
import { liveSessionSurfaceDeps, type SessionSurfaceDeps } from './session-surface-deps'
import type { SessionSurfaceRow } from '../projections/session-surface'

const WHO = { harness: 'claude', conversationId: 'conv-1' }
const row = (over: Partial<SessionSurfaceRow> = {}): SessionSurfaceRow => ({
  key: 'claude:conv-1', sessionId: 'ses_a', harness: 'claude', conversationId: 'conv-1',
  firstAt: '2026-08-01T10:00:00.000Z', lastAt: '2026-08-02T10:00:00.000Z', turns: 12, toolCalls: 40, toolsFailed: 2, toolsDenied: 1,
  models: ['claude-opus-5-5'], tokens: { input: 10, output: 20 },
  attention: [{ at: '2026-08-01T10:05:00.000Z', kind: 'approval', via: 'screen', how: 'answered-here', blockedMs: 3000 }],
  ...over,
})
const deps = (r: SessionSurfaceRow | null, ready = true): SessionSurfaceDeps => ({ lookup: async () => ({ ready, row: r }) })
const present: TranscriptAvailability = { state: 'present', reason: 'resolved' }
const withText = (): ChatPayload => ({ turns: [{ role: 'user', text: 'the real words' } as never], live: false, transcript: present })
const gone = (state: 'expired' | 'deleted'): ChatPayload => ({
  turns: [], unavailable: 'The transcript is gone.', live: false,
  transcript: { state, reason: state === 'expired' ? 'past-retention' : 'no-file-found' },
})

describe('C2 — no engine / flag off: the legacy object itself', () => {
  test('deps absent → the same reference back, nothing asked', async () => {
    const base = withText()
    expect(await mergeSessionSurface(base, WHO, undefined)).toBe(base)
  })
  test('the deps factory opens nothing and answers undefined unless engine AND projections AND `sessions` are all on', async () => {
    const on = { AGENTISTICS_PROJECTIONS: '1', AGENTISTICS_PROJECTIONS_SURFACES: 'sessions' }
    expect(await liveSessionSurfaceDeps(on, () => false)).toBeUndefined()                                   // community build
    expect(await liveSessionSurfaceDeps({ ...on, AGENTISTICS_PROJECTIONS_SURFACES: 'mcp,web' }, () => true)).toBeUndefined() // `sessions` not named
    expect(await liveSessionSurfaceDeps({ ...on, AGENTISTICS_PROJECTIONS: '0' }, () => true)).toBeUndefined()           // projections off
    expect(await liveSessionSurfaceDeps({}, () => true)).toBeUndefined()
    expect(await liveSessionSurfaceDeps(on, () => true)).toBeDefined()
  })
})

describe('a PRESENT transcript always wins; the journal only adds attention markers', () => {
  test('marks are added, the turns are untouched', async () => {
    const base = withText()
    const out = await mergeSessionSurface(base, WHO, deps(row()))
    expect(out.turns).toBe(base.turns)
    expect(out.attention).toEqual(row().attention)
    expect(out.recorded).toBeUndefined()
  })
  test('no marks, or the journal does not know the conversation, or it is not ready: the same reference', async () => {
    for (const d of [deps(row({ attention: [] })), deps(null), deps(row(), false)]) {
      const base = withText()
      expect(await mergeSessionSurface(base, WHO, d)).toBe(base)
    }
  })
})

describe('Q3 — a gone transcript shows METRICS ONLY', () => {
  for (const state of ['expired', 'deleted'] as const) {
    test(`${state}: numbers + the sentence it already had; no turns, no text`, async () => {
      const out = await mergeSessionSurface(gone(state), WHO, deps(row()))
      expect(out.turns).toEqual([])
      expect(out.unavailable).toBe('The transcript is gone.')
      expect(out.recorded).toEqual({
        firstAt: '2026-08-01T10:00:00.000Z', lastAt: '2026-08-02T10:00:00.000Z', turns: 12, toolCalls: 40, toolsFailed: 2, toolsDenied: 1,
        models: ['claude-opus-5-5'], tokens: { input: 10, output: 20 },
      })
      expect(out.attention).toEqual(row().attention)
      // the closed key set: nothing a person or a model wrote can ride in `recorded`
      expect(Object.keys(out.recorded!).sort()).toEqual(['firstAt', 'lastAt', 'models', 'tokens', 'toolCalls', 'toolsDenied', 'toolsFailed', 'turns'])
    })
    test(`${state}: the journal does not know it → legacy, its sentence unchanged`, async () => {
      const base = gone(state)
      expect(await mergeSessionSurface(base, WHO, deps(null))).toBe(base)
    })
  }
})

describe('C3 — never a blank pane, never a throw', () => {
  test('a lookup that throws, or a payload with no transcript fact, leaves the legacy payload', async () => {
    const base = gone('expired')
    expect(await mergeSessionSurface(base, WHO, { lookup: async () => { throw new Error('store died') } })).toBe(base)
    const noFact: ChatPayload = { turns: [], unavailable: 'No linked conversation.', live: false }
    expect(await mergeSessionSurface(noFact, WHO, deps(row()))).toBe(noFact)
    expect(await mergeSessionSurface(gone('expired'), null, deps(row()))).toMatchObject({ unavailable: 'The transcript is gone.' })
  })
})
