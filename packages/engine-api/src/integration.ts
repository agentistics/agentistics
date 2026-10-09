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
import type { HarnessChat } from './chat'
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

/**
 * The entity-id derivations a harness's replay uses, so a conversation whose own files are gone can
 * still be imported from the consolidate store under the SAME ids its replay would have minted.
 */
export interface HarnessEntityIds {
  sessionIdOf(conversationId: string): string
  runIdOf(conversationId: string): string
  mainAgentIdOf(conversationId: string): string
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
  /** Absent = the store import skips this harness's orphaned conversations, and says so. */
  entityIds?: HarnessEntityIds
  /**
   * 1.9 — the chat channel (`chat.ts`): the conversation's turns, state and in-flight text, NOT
   * journaled. Optional here (an engine built against 1.8 has none, and a community build has no
   * integrations at all); an engine's own CI holds each entry to "`chat` XOR `chatAbsent`", exactly as
   * it holds `live`, so a harness can never be silently without one.
   */
  chat?: HarnessChat
  /** The one sentence saying why there is no `chat`. */
  chatAbsent?: string
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

/** PURE. Narrows an entry to one that serves its conversation (1.9). False is a declared absence. */
export function hasChat<E extends EngineEvent>(
  integration: HarnessIntegration<E>,
): integration is HarnessIntegration<E> & { chat: HarnessChat } {
  return integration.chat !== undefined
}
