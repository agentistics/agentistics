/**
 * provider/emit.ts — each provider ATTEMPT becomes `model.invoked`, then `model.completed` or
 * `model.failed`, in the canonical journal (B1 spec §7, §15 B1.6). The join between the runtime
 * track (A1: the journal, the event envelope, `deriveEventId`) and the provider track (B1).
 *
 * ## Two appends per attempt, and why the first one comes first
 *
 * `model.invoked` is written BEFORE the request leaves, so a crash mid-call still leaves a record
 * that a billable call was outstanding. The terminal event is written when the outcome is known.
 * A retry is a NEW attempt (the runtime owns the retry, master §22.1.1), so it gets its own pair.
 *
 * ## The keys (`deriveEventId`, P1 §4.1 and O-8)
 *
 * - `model.completed` is keyed on the provider's OWN response id (Anthropic's `msg_…`), passed as
 *   `providerRequestId`, so the same billed response reached by another reader later (a gateway, a
 *   transcript) is ONE event — the `usage-dedupe.ts` rule, applied at the source.
 * - `model.invoked` and `model.failed` have no response id and are keyed on `(invocationId,
 *   attempt)` through `sourceRef` — NEVER on the `request-id` header, which can be absent, and never
 *   on anything minted here. The same attempt emitted twice therefore hashes to the same id and the
 *   journal counts the second as a duplicate: replay converges instead of doubling.
 * - A "completed" outcome with an EMPTY message id is keyed like a failure, on `(invocationId,
 *   attempt)`. Keyed on the empty id, every such response would collapse into one event.
 *
 * ## No confident zero
 *
 * - A failed attempt carries NO usage — `ModelFailedData` has no field for one, and nothing here
 *   invents it. A zeroed failure would be a confident 0 for a call that may have been billed
 *   (master §22.1.1).
 * - A completed attempt whose provider did not state every counter (`ProviderUsage.missing`) still
 *   writes the four numbers the event shape requires, but the placeholder zeros are GUESSWORK, so
 *   the event's confidence drops from `exact` to `inferred` (D17). The canonical shape has no
 *   `missing` field yet — recorded as an open item in the B1.6 handback, not decided here.
 * - Nothing is priced: Anthropic returns no money, so `costUSD` is absent and a projection prices
 *   through `calcCost` with `modelServed`, saying the figure is the table's.
 *
 * ## What never reaches an event
 *
 * Conversation text, content blocks, a prompt, a tool input, an error message and a credential.
 * The inputs below simply have no field for most of them; the ones that do (`content` on a real
 * client result, `userCode` on an error) are never read.
 *
 * ## A journal that fails never fails the call (P1 §4.2)
 *
 * Every method resolves, never rejects. An event the journal did not take (absent, disabled,
 * rejected, a write that threw) is counted in `lost` by type — the loss is visible, the call goes on.
 */

import {
  deriveEventId,
  CANONICAL_EVENT_SCHEMA,
  type AgentisticsEvent,
  type Confidence,
  type ModelCompletedData,
  type ModelFailedData,
  type ModelInvokedData,
  type ModelIterations,
  type ModelStopReason,
  type ProviderError,
  type ProviderId,
  type ProviderUsage,
  type StopReason,
} from '@agentistics/core'
import type { AppendResult, Journal } from '../journal/types'

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────
//
// Structural mirrors of B1 spec §4.1's `InvocationCommon` / `InvocationResult`, holding only what an
// event needs. The real client result (B1.4) must be assignable to these; `content` is deliberately
// absent, so it cannot be journaled by accident.

/** The ids the CALLER supplied (all optional in a bare B1 call — B1 invents no session or agent). */
export interface EmitScope {
  sessionId?: string
  runId?: string
  agentId?: string
  taskId?: string
}

/** What is known the moment before an attempt's request is dispatched. */
export interface AttemptStart {
  /** The grouping key of an invocation's attempts, minted by the caller (`inv_…`). */
  invocationId: string
  /** 1-based. */
  attempt: number
  provider: ProviderId
  requestedModel: string
  /** Wall clock, ISO — the `occurredAt` of `model.invoked`. */
  startedAt: string
}

interface AttemptEnd extends AttemptStart {
  /** Monotonic delta, never a wall-clock subtraction. */
  latencyMs: number
  /** Header `request-id`. Carried by the client for support; NEVER a key here. */
  requestId?: string
}

export interface AttemptCompleted extends AttemptEnd {
  status: 'completed'
  /** Body `id`, `msg_…` — the invocation's identity. */
  messageId: string
  servedModel: string
  usage: ProviderUsage
  stopReason: StopReason
  /** The provider's stop value as sent, when the client kept it. */
  stopReasonVerbatim?: string
}

export interface AttemptFailed extends AttemptEnd {
  status: 'failed'
  error: ProviderError
}

export type AttemptOutcome = AttemptCompleted | AttemptFailed

export interface EmitContext {
  /** `ProviderClient.adapterVersion` — the re-projection lever; bumped on any mapping change. */
  adapterVersion: string
  /** The SDK/provider package version, when known (`EventSource.version`). */
  sourceVersion?: string
  /** Journal write time. */
  recordedAt: string
}

// ── Pure builders ───────────────────────────────────────────────────────────────────────────────

/** Anthropic answers directly; routing through a cloud vendor is a later phase's `deployment`. */
const DEPLOYMENT = 'direct'

function attemptRef(provider: ProviderId, invocationId: string, attempt: number): string {
  return `${provider}:inv:${invocationId}:${attempt}`
}

function envelopeOf<T extends 'model.invoked' | 'model.completed' | 'model.failed'>(
  type: T,
  provider: ProviderId,
  sourceRef: string,
  providerRequestId: string | undefined,
  occurredAt: string,
  confidence: Confidence,
  scope: EmitScope,
  ctx: EmitContext,
): Omit<AgentisticsEvent<T>, 'data'> {
  const e: Omit<AgentisticsEvent<T>, 'data'> = {
    eventId: deriveEventId({ sourceKind: 'provider', sourceId: provider, sourceRef, type, providerRequestId }),
    schema: CANONICAL_EVENT_SCHEMA,
    type,
    occurredAt,
    recordedAt: ctx.recordedAt,
    source: ctx.sourceVersion === undefined
      ? { kind: 'provider', id: provider }
      : { kind: 'provider', id: provider, version: ctx.sourceVersion },
    provenance: { mode: 'native', confidence, adapterVersion: ctx.adapterVersion, sourceRef },
  }
  // Only the ids the caller supplied — an absent one stays absent, never `undefined`-valued.
  if (scope.sessionId !== undefined) e.sessionId = scope.sessionId
  if (scope.runId !== undefined) e.runId = scope.runId
  if (scope.agentId !== undefined) e.agentId = scope.agentId
  if (scope.taskId !== undefined) e.taskId = scope.taskId
  return e
}

export function invokedEvent(start: AttemptStart, scope: EmitScope, ctx: EmitContext): AgentisticsEvent<'model.invoked'> {
  const data: ModelInvokedData = {
    provider: start.provider,
    model: start.requestedModel,
    deployment: DEPLOYMENT,
    attemptId: start.invocationId,
    attempt: start.attempt,
    modelRequested: start.requestedModel,
  }
  const ref = attemptRef(start.provider, start.invocationId, start.attempt)
  return { ...envelopeOf('model.invoked', start.provider, ref, undefined, start.startedAt, 'exact', scope, ctx), data }
}

function stopReasonOf(o: AttemptCompleted): ModelStopReason {
  const verbatim = o.stopReasonVerbatim
    ?? (o.stopReason.kind === 'other' && o.stopReason.raw !== null ? o.stopReason.raw : undefined)
  return verbatim === undefined ? { normalised: o.stopReason } : { normalised: o.stopReason, verbatim }
}

function iterationsOf(u: ProviderUsage): ModelIterations | undefined {
  if (!u.iterations || u.iterations.length === 0) return undefined
  return {
    relation: 'unmeasured',
    // Kind and model only: the counters inside an iteration are not pinned by any fixture (O-3),
    // so they stay in the raw capture rather than being read under guessed key names.
    items: u.iterations.map(it => (it.model === undefined ? { kind: it.kind } : { kind: it.kind, model: it.model })),
  }
}

export function completedEvent(
  o: AttemptCompleted, scope: EmitScope, ctx: EmitContext, observedAt: string,
): AgentisticsEvent<'model.completed'> {
  const u = o.usage
  const data: ModelCompletedData = {
    provider: o.provider,
    // The event is ABOUT what answered; that is also the only id that prices the call.
    model: o.servedModel,
    deployment: DEPLOYMENT,
    usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
    latencyMs: o.latencyMs,
    status: 'completed',
    attemptId: o.invocationId,
    attempt: o.attempt,
    modelRequested: o.requestedModel,
    modelServed: o.servedModel,
    stopReason: stopReasonOf(o),
  }
  const hasId = o.messageId.length > 0
  if (hasId) data.providerRequestId = o.messageId
  if (u.cacheWriteByTtl) {
    data.cacheWriteByTtl = { ephemeral_5m: u.cacheWriteByTtl.ephemeral5m, ephemeral_1h: u.cacheWriteByTtl.ephemeral1h }
  }
  if (u.reasoning) data.reasoning = { tokens: u.reasoning.tokens, billing: u.reasoning.billing }
  if (u.contextTokens !== undefined) data.contextTokens = u.contextTokens
  const iterations = iterationsOf(u)
  if (iterations) data.iterations = iterations

  const ref = hasId ? `${o.provider}:msg:${o.messageId}` : attemptRef(o.provider, o.invocationId, o.attempt)
  const confidence: Confidence = u.missing && u.missing.length > 0 ? 'inferred' : 'exact'
  return {
    ...envelopeOf('model.completed', o.provider, ref, hasId ? o.messageId : undefined, observedAt, confidence, scope, ctx),
    data,
  }
}

export function failedEvent(
  o: AttemptFailed, scope: EmitScope, ctx: EmitContext, observedAt: string,
): AgentisticsEvent<'model.failed'> {
  const data: ModelFailedData = {
    provider: o.provider,
    model: o.requestedModel,
    deployment: DEPLOYMENT,
    status: o.error.kind === 'aborted' ? 'cancelled' : 'failed',
    errorClass: o.error.kind,
    latencyMs: o.latencyMs,
    attemptId: o.invocationId,
    attempt: o.attempt,
    modelRequested: o.requestedModel,
  }
  // Deliberately no `providerRequestId`: the only id a failure has is the `request-id` header,
  // and `deriveEventId` would key on it — an id that can be absent is not an identity.
  const ref = attemptRef(o.provider, o.invocationId, o.attempt)
  return { ...envelopeOf('model.failed', o.provider, ref, undefined, observedAt, 'exact', scope, ctx), data }
}

export function terminalEvent(
  o: AttemptOutcome, scope: EmitScope, ctx: EmitContext, observedAt: string,
): AgentisticsEvent<'model.completed'> | AgentisticsEvent<'model.failed'> {
  return o.status === 'completed' ? completedEvent(o, scope, ctx, observedAt) : failedEvent(o, scope, ctx, observedAt)
}

// ── The emitter (the one impure part: it appends) ───────────────────────────────────────────────

export type EmittedType = 'model.invoked' | 'model.completed' | 'model.failed'

export interface EmitCounters {
  /** Events the journal did not take, by type (`journal.provider_events_lost`, B1 spec §7). */
  lost: Record<EmittedType, number>
}

export interface EmitterOptions {
  /** `null` when there is no journal at all — every event is then counted lost, and the call goes on. */
  journal: Journal | null
  adapterVersion: string
  sourceVersion?: string
  /** Injected clock. */
  now?: () => Date
}

export interface ProviderEmitter {
  /** Before the request leaves. Resolves to the journal's result, or `null` when nothing was appended. */
  invoked(start: AttemptStart, scope?: EmitScope): Promise<AppendResult | null>
  /** When the outcome is known. `observedAt` defaults to the clock. */
  terminal(outcome: AttemptOutcome, scope?: EmitScope, observedAt?: string): Promise<AppendResult | null>
  counters(): EmitCounters
}

export function createProviderEmitter(opts: EmitterOptions): ProviderEmitter {
  const now = opts.now ?? (() => new Date())
  const lost: Record<EmittedType, number> = { 'model.invoked': 0, 'model.completed': 0, 'model.failed': 0 }
  const ctx = (): EmitContext => ({
    adapterVersion: opts.adapterVersion,
    recordedAt: now().toISOString(),
    ...(opts.sourceVersion === undefined ? {} : { sourceVersion: opts.sourceVersion }),
  })

  async function append(event: AgentisticsEvent<EmittedType>): Promise<AppendResult | null> {
    if (!opts.journal) { lost[event.type] += 1; return null }
    try {
      const r = await opts.journal.append([event])
      // A duplicate is not a loss — the fact is already in the journal. Anything else not written
      // (rejected, or dropped by a disabled journal) is.
      if (r.written + r.duplicates < 1) lost[event.type] += 1
      return r
    } catch {
      lost[event.type] += 1
      return null
    }
  }

  return {
    invoked: (start, scope = {}) => append(invokedEvent(start, scope, ctx())),
    terminal: (outcome, scope = {}, observedAt) => {
      const c = ctx()
      return append(terminalEvent(outcome, scope, c, observedAt ?? c.recordedAt))
    },
    counters: () => ({ lost: { ...lost } }),
  }
}
