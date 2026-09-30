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
 * - A completed attempt whose provider did not state every counter (`ProviderUsage.missing`) emits
 *   `data.usage` with ONLY the counters the source actually reported (D21, 2026-09-26) — a missing
 *   counter's key is absent from the object, never written as a placeholder 0. The counters that
 *   ARE present are exact statements about what the provider said, so the event's `confidence`
 *   stays `exact` regardless of what is missing; there is no `inferred` path for a missing counter
 *   any more (superseding B1.6's placeholder-zero-plus-`inferred` rule). `contextTokens` and
 *   `cacheWriteByTtl` inherit this for free — `usage.ts` already withholds both whenever the
 *   counters they depend on are missing, so nothing here has to re-check `missing` for them.
 * - Nothing is priced: Anthropic returns no money, so `costUSD` is absent and a projection prices
 *   through `calcCost` with `modelServed`, saying the figure is the table's.
 *
 * ## What never reaches an event
 *
 * Conversation text, content blocks, a prompt, a tool input, an error message and a credential.
 * The inputs below simply have no field for most of them; the ones that do (`content` on a real
 * client result, `userCode` on an error) are never read.
 *
 * ## The streamed path (B2.1): `model.started` is journaled, `model.delta` is not
 *
 * A streamed attempt writes THREE events: `model.invoked` (before the request leaves), `model.started`
 * (the provider accepted it — Anthropic's `message_start`), and the same terminal `model.completed` /
 * `model.failed` a non-streamed attempt writes, built from the stream's `end` result. `model.started`
 * is keyed on `(invocationId, attempt)` like `model.invoked` — never on the `msg_…` id it carries in
 * `data.providerRequestId`, because the key must exist for every started attempt and must not collide
 * with the `model.completed` keyed on that very id.
 *
 * **No `model.delta` is ever written.** A long answer is thousands of text deltas; journaling them
 * would put the size of every answer into the journal as rows that say almost nothing — the canonical
 * `ModelDeltaData` carries only `providerRequestId` + `outputTokensSoFar`, never the text, so the rows
 * would be a running token counter whose LAST value the terminal `model.completed` already states
 * exactly (`usage.output`, read from the final cumulative `message_delta`). A sampled delta ("one every
 * N") would buy a crash-time progress figure at the price of an arbitrary rate and a size budget that
 * grows with answer length, and a failed attempt deliberately carries no usage at all — a mid-stream
 * running count journaled beside it would be exactly the confident partial figure that rule forbids.
 * Deltas stay EPHEMERAL: they reach live readers through the stream hub (`stream.ts`) and nothing else.
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
  type ModelStartedData,
  type ModelStopReason,
  type ModelUsageCounters,
  type ProviderError,
  type ProviderId,
  type ProviderUsage,
  type StopReason,
} from '@agentistics/core'
import type { ProviderStreamEvent } from './client.ts'

// ── The sink (D23) ──────────────────────────────────────────────────────────────────────────────
//
// The runtime owns the SHAPE of what it appends to, never the journal itself: the host passes its
// own. agentop's A1 journal (`server/journal/types.ts` `Journal`) satisfies this structurally — its
// `append` resolves to an `AppendResult` carrying `written`, `duplicates` and more.

/** The part of an append's answer the emitter reads. A host's richer result is assignable to it. */
export interface ProviderAppendResult {
  /** Rows actually inserted. */
  written: number
  /** Events whose `eventId` was already there — a duplicate is NOT a loss. */
  duplicates: number
}

/** Where provider events go. Implemented by the host; the runtime never opens one. `R` lets a
 *  host's richer answer come back to it through the emitter unchanged. */
export interface ProviderJournalSink<R extends ProviderAppendResult = ProviderAppendResult> {
  append(events: readonly AgentisticsEvent[]): Promise<R>
}

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

/** What `model.started` states: the provider accepted the attempt and began answering. */
export interface AttemptStarted extends AttemptStart {
  /** Body `id` from `message_start`, when it carried one — carried in the data, never a key. */
  messageId?: string
  /** `message_start`'s `model`, when stated. */
  servedModel?: string
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

function envelopeOf<T extends EmittedType>(
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

/**
 * `model.started` — keyed on `(invocationId, attempt)` (module doc), so a replayed stream converges.
 * `model` is what ANSWERED when `message_start` said so, else what was asked for.
 */
export function startedEvent(
  s: AttemptStarted, scope: EmitScope, ctx: EmitContext, observedAt: string,
): AgentisticsEvent<'model.started'> {
  const data: ModelStartedData = {
    provider: s.provider,
    model: s.servedModel ?? s.requestedModel,
    attemptId: s.invocationId,
    attempt: s.attempt,
    modelRequested: s.requestedModel,
  }
  if (s.messageId !== undefined && s.messageId.length > 0) data.providerRequestId = s.messageId
  const ref = attemptRef(s.provider, s.invocationId, s.attempt)
  return { ...envelopeOf('model.started', s.provider, ref, undefined, observedAt, 'exact', scope, ctx), data }
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
  const missing = new Set(u.missing ?? [])
  // Only the counters the source actually reported (D21) — a missing one's key is omitted
  // entirely, never written as a placeholder 0.
  const usage: ModelUsageCounters = {}
  if (!missing.has('input')) usage.input = u.input
  if (!missing.has('output')) usage.output = u.output
  if (!missing.has('cacheRead')) usage.cacheRead = u.cacheRead
  if (!missing.has('cacheWrite')) usage.cacheWrite = u.cacheWrite
  const data: ModelCompletedData = {
    provider: o.provider,
    // The event is ABOUT what answered; that is also the only id that prices the call.
    model: o.servedModel,
    deployment: DEPLOYMENT,
    usage,
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
  // D21: every counter that made it into `usage` is an exact statement from the source — a missing
  // counter is omitted above, not guessed at, so there is nothing left here for `inferred` to mean.
  const confidence: Confidence = 'exact'
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

export type EmittedType = 'model.invoked' | 'model.started' | 'model.completed' | 'model.failed'

export interface EmitCounters {
  /** Events the journal did not take, by type (`journal.provider_events_lost`, B1 spec §7). */
  lost: Record<EmittedType, number>
}

export interface EmitterOptions<R extends ProviderAppendResult = ProviderAppendResult> {
  /** `null` when there is no journal at all — every event is then counted lost, and the call goes on. */
  journal: ProviderJournalSink<R> | null
  adapterVersion: string
  sourceVersion?: string
  /** Injected clock. */
  now?: () => Date
}

export interface ProviderEmitter<R extends ProviderAppendResult = ProviderAppendResult> {
  /** Before the request leaves. Resolves to the journal's result, or `null` when nothing was appended. */
  invoked(start: AttemptStart, scope?: EmitScope): Promise<R | null>
  /** When a streamed attempt's provider began answering. `observedAt` defaults to the clock. */
  started(start: AttemptStarted, scope?: EmitScope, observedAt?: string): Promise<R | null>
  /** When the outcome is known. `observedAt` defaults to the clock. */
  terminal(outcome: AttemptOutcome, scope?: EmitScope, observedAt?: string): Promise<R | null>
  counters(): EmitCounters
}

export function createProviderEmitter<R extends ProviderAppendResult = ProviderAppendResult>(
  opts: EmitterOptions<R>,
): ProviderEmitter<R> {
  const now = opts.now ?? (() => new Date())
  const lost: Record<EmittedType, number> = { 'model.invoked': 0, 'model.started': 0, 'model.completed': 0, 'model.failed': 0 }
  const ctx = (): EmitContext => ({
    adapterVersion: opts.adapterVersion,
    recordedAt: now().toISOString(),
    ...(opts.sourceVersion === undefined ? {} : { sourceVersion: opts.sourceVersion }),
  })

  async function append(event: AgentisticsEvent<EmittedType>): Promise<R | null> {
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
    started: (start, scope = {}, observedAt) => {
      const c = ctx()
      return append(startedEvent(start, scope, c, observedAt ?? c.recordedAt))
    },
    terminal: (outcome, scope = {}, observedAt) => {
      const c = ctx()
      return append(terminalEvent(outcome, scope, c, observedAt ?? c.recordedAt))
    },
    counters: () => ({ lost: { ...lost } }),
  }
}

// ── The streamed path ───────────────────────────────────────────────────────────────────────────

/**
 * Journals one streamed attempt while passing every event through UNCHANGED, in order: `model.invoked`
 * before the first event is pulled (and so before the request leaves — a `ProviderStream` from an
 * async generator sends nothing until it is first iterated), `model.started` on the `started` event,
 * and the terminal event on `end`. Deltas are passed through and never written (module doc).
 *
 * Never throws: the emitter's methods never reject, and the source stream never throws by contract.
 * `start.startedAt` is the `model.invoked` occurredAt; the terminal event is built from the `end`
 * result itself, exactly as the retry hooks build it for a non-streamed attempt.
 */
export async function* journalProviderStream<R extends ProviderAppendResult>(
  source: AsyncIterable<ProviderStreamEvent>,
  emitter: ProviderEmitter<R>,
  start: AttemptStart,
  scope: EmitScope = {},
): AsyncGenerator<ProviderStreamEvent, void, undefined> {
  await emitter.invoked(start, scope)
  for await (const ev of source) {
    if (ev.type === 'started') {
      const s: AttemptStarted = { ...start }
      if (ev.messageId !== undefined) s.messageId = ev.messageId
      if (ev.servedModel !== undefined) s.servedModel = ev.servedModel
      await emitter.started(s, scope)
    } else if (ev.type === 'end') {
      await emitter.terminal(ev.result, scope)
    }
    yield ev
  }
}
