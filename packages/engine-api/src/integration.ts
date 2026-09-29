/**
 * integration.ts — what turns one harness's own record into canonical events.
 *
 * The same contract the host's integration registry uses today, generic over the event type so this
 * package never names the host's canonical event (see mirrors.ts). An engine instantiates it with
 * the real event type; `E` defaults to the minimal mirror.
 *
 * **A missing `replay` is a DECLARED ABSENCE, never a crash.** An entry says either "here is my
 * replay" or, in one sentence, why it has none; an entry that says neither does not compile.
 */
import type { EngineCapabilityState, EngineEvent, HarnessId } from './mirrors'

/** One thing a replay can be pointed at — a transcript, a database, a session directory. */
export interface ReplaySource {
  /** The harness's own id for the conversation. */
  sessionId: string
  /** What `sourceRef` on every event read from it resolves to: something a person can re-open. */
  sourceRef: string
}

/** Where a replay stopped, opaque to all but the integration that issued it. `null` is the start. */
export type ReplayCursor = string | null

export interface ReplayBatch<E extends EngineEvent = EngineEvent> {
  events: E[]
  /** Pass back to `replay` to read only what is new. */
  cursor: ReplayCursor
}

export interface HarnessReplay<E extends EngineEvent = EngineEvent> {
  /** Every source this integration can currently replay. Total: an unreadable store yields `[]`. */
  discover(): Promise<ReplaySource[]>
  /** The events of `source` written since `cursor`. Folding it in N chunks equals folding it whole. */
  replay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch<E>>
}

/** Following a live harness as it writes. */
export interface HarnessLive<E extends EngineEvent = EngineEvent> {
  /** Starts delivering events; the returned function stops it. */
  watch(emit: (event: E) => void): () => void
}

interface IntegrationBase<E extends EngineEvent> {
  id: HarnessId
  /** The `adapterVersion` every event this integration emits carries. Non-empty. */
  version: string
  capabilities: Readonly<Record<string, EngineCapabilityState>>
  live?: HarnessLive<E>
}

export type HarnessIntegration<E extends EngineEvent = EngineEvent> = IntegrationBase<E> &
  (
    | { replay: HarnessReplay<E>; replayAbsent?: undefined }
    /** `replayAbsent` is the one sentence saying why there is no replay. */
    | { replay?: undefined; replayAbsent: string }
  )

/** PARTIAL on purpose: a community build has none, and the engine's own CI enforces totality. */
export type IntegrationRegistry<E extends EngineEvent = EngineEvent> = Partial<
  Record<HarnessId, HarnessIntegration<E>>
>

/** PURE. Narrows an entry to one that can replay. False is a declared absence, not an error. */
export function hasReplay<E extends EngineEvent>(
  integration: HarnessIntegration<E>,
): integration is IntegrationBase<E> & { replay: HarnessReplay<E>; replayAbsent?: undefined } {
  return integration.replay !== undefined
}
