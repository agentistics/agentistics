/**
 * d20-additive.test.ts — decision D20 (2026-09-25) widened the canonical `model.*` shapes, and this
 * file is the proof that it widened them ONLY.
 *
 * D20 added `attemptId` / `attempt` / `modelRequested` (every `model.*` terminal-or-opening event),
 * `modelServed` / `stopReason` / `iterations` (`model.completed`), and made `ModelInvocation.agentId`
 * optional (O-6). The rule the decision was taken under is "optional and additive: nothing A1/A2
 * already built breaks". Most of the proof is COMPILE-TIME: the literals below are written in
 * A1.1's exact shapes (no D20 field anywhere) and must keep type-checking under `tsc --noEmit`,
 * which the pre-commit hook runs over this file. The `@ts-expect-error` lines prove the new fields
 * are TYPED rather than loose — a field nobody types is a field nobody validates, which is why the
 * untyped `extra` bag was rejected.
 */

import { describe, expect, test } from 'bun:test'
import type {
  AgentisticsEvent,
  ModelAttemptFacts,
  ModelCompletedData,
  ModelFailedData,
  ModelInvokedData,
} from './event'
import { CANONICAL_EVENT_SCHEMA } from './event'
import type { ModelInvocation, ReasoningBilling } from './entities'
import type { ReasoningUsage } from '../provider/usage'

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

const envelope = {
  schema: CANONICAL_EVENT_SCHEMA,
  occurredAt: '2026-09-25T12:00:00.000Z',
  recordedAt: '2026-09-25T12:00:01.000Z',
  source: { kind: 'harness' as const, id: 'claude', version: '2.1.263' },
  provenance: { mode: 'observed' as const, confidence: 'exact' as const, adapterVersion: '1.0.0' },
}

// ── A1.1's shapes, unchanged: none of these literals names a D20 field ──────────────────────────

const a1Invoked: AgentisticsEvent<'model.invoked'> = {
  ...envelope, eventId: 'e1', type: 'model.invoked',
  data: { provider: 'anthropic', model: 'claude-opus-5' },
}
const a1Completed: AgentisticsEvent<'model.completed'> = {
  ...envelope, eventId: 'e2', type: 'model.completed', agentId: 'agt_1',
  data: {
    providerRequestId: 'msg_1', provider: 'anthropic', model: 'claude-opus-5', deployment: 'direct',
    usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 1 },
    cacheWriteByTtl: { ephemeral_5m: 1 },
    reasoning: { tokens: 3, billing: 'additive' },
    contextTokens: 16, contextWindow: 200000, costUSD: 0.01, costSource: 'harness', latencyMs: 900,
    status: 'completed',
  },
}
const a1Failed: AgentisticsEvent<'model.failed'> = {
  ...envelope, eventId: 'e3', type: 'model.failed',
  data: { provider: 'anthropic', model: 'claude-opus-5', status: 'failed', errorClass: 'overloaded', latencyMs: 40 },
}
const a1Invocation: ModelInvocation = {
  id: 'inv_1', agentId: 'agt_1', provider: 'anthropic', model: 'claude-opus-5',
  startedAt: '2026-09-25T12:00:00.000Z',
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  status: 'completed',
}

// ── The widened shapes ──────────────────────────────────────────────────────────────────────────

const d20Completed: ModelCompletedData = {
  ...a1Completed.data,
  attemptId: 'inv_1', attempt: 2, modelRequested: 'claude-opus-5', modelServed: 'claude-opus-5-20260901',
  stopReason: { normalised: { kind: 'refusal', category: 'cyber' }, verbatim: 'refusal' },
  iterations: { relation: 'unmeasured', items: [{ kind: 'compaction', model: 'claude-haiku-4-5' }] },
}
/** O-6: an invocation no agent made is representable, with no invented agent. */
const orphanInvocation: ModelInvocation = { ...a1Invocation, agentId: undefined, attemptId: 'inv_1', attempt: 1 }

// @ts-expect-error — `attempt` is a number, not a free-form value
const badAttempt: ModelAttemptFacts = { attempt: '1' }
// @ts-expect-error — the normalised stop reason is B1.1's closed vocabulary, not any string
const badStop: ModelCompletedData = { ...a1Completed.data, stopReason: { normalised: { kind: 'finished' } } }
// @ts-expect-error — `iterations.relation` can only state what is known today: 'unmeasured'
const badIterations: ModelCompletedData = { ...a1Completed.data, iterations: { relation: 'included', items: [] } }
void badAttempt; void badStop; void badIterations

describe('D20 — additive only', () => {
  test('every D20 field is optional on all three model.* data shapes and on ModelInvocation', () => {
    const noFacts: ModelAttemptFacts = {}
    const allOptional: [
      Equal<Partial<ModelAttemptFacts>, ModelAttemptFacts>,
      Equal<Pick<ModelCompletedData, 'modelServed' | 'stopReason' | 'iterations'>,
        Partial<Pick<ModelCompletedData, 'modelServed' | 'stopReason' | 'iterations'>>>,
      Equal<Pick<ModelInvocation, 'agentId'>, Partial<Pick<ModelInvocation, 'agentId'>>>,
    ] = [true, true, true]
    expect(noFacts).toEqual({})
    expect(allOptional).toEqual([true, true, true])
  })

  test('ModelAttemptFacts is carried by invoked, completed and failed alike', () => {
    const carried: [
      ModelAttemptFacts extends Pick<ModelInvokedData, keyof ModelAttemptFacts> ? true : false,
      ModelAttemptFacts extends Pick<ModelCompletedData, keyof ModelAttemptFacts> ? true : false,
      ModelAttemptFacts extends Pick<ModelFailedData, keyof ModelAttemptFacts> ? true : false,
    ] = [true, true, true]
    expect(carried).toEqual([true, true, true])
  })

  test("A1.1's literals still hold their values (they compiled — tsc is the real assertion)", () => {
    expect(a1Invoked.data).toEqual({ provider: 'anthropic', model: 'claude-opus-5' })
    expect(a1Completed.data.usage).toEqual({ input: 10, output: 20, cacheRead: 5, cacheWrite: 1 })
    expect(a1Failed.data.status).toBe('failed')
    expect(a1Invocation.agentId).toBe('agt_1')
    expect(orphanInvocation.agentId).toBeUndefined()
    expect(d20Completed.stopReason?.normalised.kind).toBe('refusal')
  })

  test('reasoning billing is ONE vocabulary: B1.1 imports the canonical ReasoningBilling', () => {
    const same: Equal<ReasoningUsage['billing'], ReasoningBilling> = true
    expect(same).toBe(true)
  })
})
