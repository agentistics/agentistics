/**
 * The fold-state codec: what the store persists between catch-up passes must fold and finish exactly
 * like the state it came from.
 *
 * The real-SessionMetaState case below used to run over the redacted Claude/Codex replay fixtures
 * (`p3-fixture-events.ts`), replayed through `../integrations/claude` and `../integrations/codex` —
 * both FROZEN engine code, absent from the public tree (CLAUDE.md "FROZEN PATHS"). It now runs over
 * `synthetic-events.ts`'s hand-built canonical stream instead, which exercises the same property
 * (persist half, restore, fold the rest, compare with folding whole) without any integration.
 */
import { describe, expect, test } from 'bun:test'
import { project } from '@agentistics/core'
import { fixtureEvents, groupBy } from './synthetic-events'
import { sessionMetaProjection } from './session-meta'
import { decodeState, encodeState } from './state-codec'

describe('state-codec', () => {
  test('Maps and Sets survive, nested, with non-string keys and values', () => {
    const s = { a: new Map<string, unknown>([['k', new Set([1, 2])], ['m', new Map([[3, { x: [1, null] }]])]]), b: [new Set(['z'])], c: null }
    const back = decodeState<typeof s>(encodeState(s))
    expect(back.a.get('k')).toEqual(new Set([1, 2]))
    expect((back.a.get('m') as Map<number, unknown>).get(3)).toEqual({ x: [1, null] })
    expect(back.b[0]).toEqual(new Set(['z']))
    expect(back.c).toBeNull()
  })

  test('an ordinary object carrying a tag key is escaped, never read back as a collection', () => {
    const s = { weird: { $m: [['a', 1]] }, weirder: { $s: [1], other: 2 } }
    expect(decodeState<typeof s>(encodeState(s))).toEqual(s)
  })

  test('undefined properties are dropped (read back as absent, which every state reads the same)', () => {
    const back = decodeState<{ a?: number; b: number }>(encodeState({ a: undefined, b: 1 }))
    expect('a' in back).toBe(false)
    expect(back.b).toBe(1)
  })

  test('a non-finite number is REFUSED rather than persisted as null', () => {
    expect(() => encodeState({ x: Number.NaN })).toThrow()
    expect(() => encodeState({ x: new Map([['k', Number.POSITIVE_INFINITY]]) })).toThrow()
  })

  test('a real SessionMetaState: fold half, persist, restore, fold the rest == fold whole', async () => {
    const events = await fixtureEvents()
    for (const [, evs] of groupBy(events, e => e.sessionId ?? null)) {
      const whole = project(sessionMetaProjection, evs)
      const st = sessionMetaProjection.empty()
      const cut = Math.floor(evs.length / 2)
      sessionMetaProjection.fold(st, evs.slice(0, cut))
      const restored = decodeState<typeof st>(encodeState(st))
      sessionMetaProjection.fold(restored, evs.slice(cut))
      expect(sessionMetaProjection.finish(restored)).toEqual(whole)
    }
  })
})
