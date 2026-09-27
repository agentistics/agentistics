/**
 * d21-absent-counters.test.ts — decision D21 (2026-09-26): a `model.completed` carries the REAL
 * counters, and a counter the source could not produce is ABSENT — never a 0 marked `inferred`.
 *
 * The change is a WIDENING of `usage` (four required numbers → four optional ones), so the proof is
 * mostly compile-time, the same technique `d20-additive.test.ts` uses: every literal below is
 * written in the shape events had BEFORE D21 (all four counters) and must keep type-checking under
 * `tsc --noEmit`. The `@ts-expect-error` lines prove the counters are still TYPED — optional is not
 * loose — and the runtime half pins `absentUsageCounters`, the one helper readers use to know a sum
 * over events is partial.
 */

import { describe, expect, test } from 'bun:test'
import type { AgentisticsEvent, ModelCompletedData } from './event'
import { absentUsageCounters, CANONICAL_EVENT_SCHEMA, USAGE_COUNTERS } from './event'
import type { ModelInvocation, ModelUsageCounters } from './entities'
import type { TokenBreakdown } from '../tokens'

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

const envelope = {
  schema: CANONICAL_EVENT_SCHEMA,
  occurredAt: '2026-09-26T12:00:00.000Z',
  recordedAt: '2026-09-26T12:00:01.000Z',
  source: { kind: 'provider' as const, id: 'anthropic', version: '1.0.0' },
  provenance: { mode: 'native' as const, confidence: 'exact' as const, adapterVersion: '1.0.0' },
}

// ── Pre-D21 shapes: all four counters, unchanged ─────────────────────────────────────────────────

const whole: AgentisticsEvent<'model.completed'> = {
  ...envelope, eventId: 'e1', type: 'model.completed',
  data: {
    provider: 'anthropic', model: 'claude-opus-5', status: 'completed',
    usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 1 },
  },
}
const wholeInvocation: ModelInvocation = {
  id: 'inv_1', provider: 'anthropic', model: 'claude-opus-5', startedAt: '2026-09-26T12:00:00.000Z',
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, status: 'completed',
}
/** A whole breakdown IS a usage, with no conversion. */
const fromBreakdown: ModelUsageCounters = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } satisfies TokenBreakdown

// ── D21 shapes: what the source did not report is simply not there ───────────────────────────────

const partial: ModelCompletedData = { ...whole.data, usage: { input: 10, output: 20 } }
const nothingReported: ModelCompletedData = { ...whole.data, usage: {} }

// @ts-expect-error — a counter is a number when present, never a marker string
const badCounter: ModelCompletedData = { ...whole.data, usage: { input: 'missing' } }
// @ts-expect-error — there is no fifth counter; reasoning has its own field with its billing
const badExtra: ModelCompletedData = { ...whole.data, usage: { input: 1, reasoning: 2 } }
// @ts-expect-error — `usage` itself stays required: an event with no usage object is not a completion
const noUsage: ModelCompletedData = { provider: 'anthropic', model: 'claude-opus-5', status: 'completed' }
void badCounter; void badExtra; void noUsage

describe('D21 — an unreported counter is absent', () => {
  test('every counter is individually optional, on the event and on ModelInvocation', () => {
    const optional: [
      Equal<ModelCompletedData['usage'], Partial<TokenBreakdown>>,
      Equal<ModelInvocation['usage'], Partial<TokenBreakdown>>,
    ] = [true, true]
    expect(optional).toEqual([true, true])
  })

  test('pre-D21 literals still compile and keep their four counters', () => {
    expect(whole.data.usage).toEqual({ input: 10, output: 20, cacheRead: 5, cacheWrite: 1 })
    expect(wholeInvocation.usage.cacheWrite).toBe(4)
    expect(fromBreakdown.input).toBe(1)
  })

  test('absentUsageCounters names exactly the counters that are not there, in USAGE_COUNTERS order', () => {
    expect(USAGE_COUNTERS).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(absentUsageCounters(whole.data.usage)).toEqual([])
    expect(absentUsageCounters(partial.usage)).toEqual(['cacheRead', 'cacheWrite'])
    expect(absentUsageCounters(nothingReported.usage)).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
  })

  test('a reported ZERO is present — a real 0 is a measurement, not an absence', () => {
    expect(absentUsageCounters({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual([])
  })
})
