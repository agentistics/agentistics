/**
 * session/lifecycle.ts — PURE builders for the four transitions B4.1 journals (spec §3's table):
 * `session.started`, `session.ended`, `run.started`, `run.ended`. Provenance is always `native` /
 * `exact` — a session this runtime created and a run it executed are facts about its OWN execution,
 * never something read off a harness's artifact after the fact.
 *
 * Ids are DERIVED with `deriveEventId`, never minted here (same rule as `loop/emit.ts` and
 * `provider/emit.ts`): `sourceRef` is `session:<sessionId>` for a session event and `run:<runId>` for
 * a run event, so a re-emission of the same transition (a retried store write, a replay) hashes to
 * the same id and the journal counts it as a duplicate rather than a second fact.
 *
 * **The vocabulary is not widened.** There is no `session.resumed` / `run.queued` here — resuming a
 * session is a session with a new `run.started` (spec §3), which is exactly what `runtime.ts`'s
 * `run()` already builds through `runStartedEvent`.
 */

import {
  CANONICAL_EVENT_SCHEMA,
  deriveEventId,
  type AgentisticsEvent,
  type NoData,
  type RunEndedData,
  type RunStartedData,
  type RunStatus,
  type SessionStartedData,
} from '@agentistics/core'

/** `source.id` for every event this module builds — the runtime's own name (spec §1's `agentistics`). */
const SOURCE_ID = 'agentistics'

export interface LifecycleEventContext {
  /** The re-projection lever (`provenance.adapterVersion`) — the host's `runtimeVersion`. */
  adapterVersion: string
  /** When the transition happened, per the caller's own clock. */
  occurredAt: string
  /** When it was recorded — usually the same instant, computed once by the (impure) caller. */
  recordedAt: string
}

type LifecycleType = 'session.started' | 'session.ended' | 'run.started' | 'run.ended'

function envelope<T extends LifecycleType>(
  type: T,
  sourceRef: string,
  ctx: LifecycleEventContext,
): Omit<AgentisticsEvent<T>, 'data'> {
  return {
    eventId: deriveEventId({ sourceKind: 'runtime', sourceId: SOURCE_ID, sourceRef, type }),
    schema: CANONICAL_EVENT_SCHEMA,
    type,
    occurredAt: ctx.occurredAt,
    recordedAt: ctx.recordedAt,
    source: { kind: 'runtime', id: SOURCE_ID },
    provenance: { mode: 'native', confidence: 'exact', adapterVersion: ctx.adapterVersion, sourceRef },
  }
}

export function sessionStartedEvent(
  sessionId: string,
  data: SessionStartedData,
  ctx: LifecycleEventContext,
): AgentisticsEvent<'session.started'> {
  return { ...envelope('session.started', `session:${sessionId}`, ctx), sessionId, data }
}

export function sessionEndedEvent(
  sessionId: string,
  ctx: LifecycleEventContext,
): AgentisticsEvent<'session.ended'> {
  const data: NoData = {}
  return { ...envelope('session.ended', `session:${sessionId}`, ctx), sessionId, data }
}

export function runStartedEvent(
  sessionId: string,
  runId: string,
  data: RunStartedData,
  ctx: LifecycleEventContext,
): AgentisticsEvent<'run.started'> {
  return { ...envelope('run.started', `run:${runId}`, ctx), sessionId, runId, data }
}

export function runEndedEvent(
  sessionId: string,
  runId: string,
  status: Exclude<RunStatus, 'running'>,
  ctx: LifecycleEventContext,
): AgentisticsEvent<'run.ended'> {
  const data: RunEndedData = { status }
  return { ...envelope('run.ended', `run:${runId}`, ctx), sessionId, runId, data }
}
