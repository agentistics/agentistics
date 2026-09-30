/**
 * integrations/antigravity/replay-core.ts — PURE. What every part of the Antigravity (agy) replay
 * shares: the adapter version, the deterministic entity ids, the contexts and the one function that
 * builds an envelope. The shape is `integrations/claude/replay-core.ts`'s, on purpose.
 *
 * ## What agy writes, and where each event comes from
 *
 * One agy conversation is TWO records (CLAUDE.md, "Antigravity (agy)"):
 * - `brain/<conv>/.system_generated/logs/transcript_full.jsonl` (`transcript.jsonl` the fallback) —
 *   one JSON STEP per line. The lifecycle, the human turns, the tool calls and the error steps are
 *   read from it (`replay.ts`).
 * - `conversations/<conv>.db`, table `gen_metadata` — one protobuf blob per LLM CALL. Every
 *   `model.completed` is read from it (`replay-genmeta.ts`), one per decoded row.
 *
 * An `invoke_subagent` CHILD conversation is a CHILD `Agent` under its parent's run — never a second
 * run (P2 §2). Its own transcript and its own `gen_metadata` rows are read under that child agent,
 * once each, so the parent's totals never contain them and nothing is counted twice.
 *
 * ## Ids are DERIVED from the harness's own record
 *
 * Session and run: the conversation id of the RUN (the top-level conversation). Main agent: the same.
 * A child agent: the run's conversation id plus the child's own conversation id. A tool execution:
 * the conversation it was read from plus the transcript's own `step_index` (and the call's position
 * within that step) — agy writes no id on a tool call, so the step index, which the transcript itself
 * dedupes on, is the only stable key there is. Re-reading re-derives every id.
 *
 * ## No conversation text (D5)
 *
 * Nothing here copies a prompt, a reply, a thinking block, a tool argument or a tool output into an
 * event. A shell command enters only through `commandSummary` + `redactSecrets`, and a file path only
 * as a NAME on a completed edit (the Claude replay's rule).
 *
 * ## Changelog (`ANTIGRAVITY_ADAPTER_VERSION`)
 *
 * - 1.0.0 — session/run/agent lifecycle (main + one child agent per `invoke_subagent` child
 *   conversation), `turn.started` per USER_INPUT legacy counts, `turn.ended` (`last-line`) per turn
 *   close, one `model.completed` per `gen_metadata` row (no cache-write counter: ABSENT, D21),
 *   `tool.requested` / `tool.completed` / `tool.failed`, and `model.failed` per ERROR_MESSAGE step.
 */
import { createHash } from 'node:crypto'
import {
  CANONICAL_EVENT_SCHEMA,
  EVENT_ID_LENGTH,
  eventIdPreimage,
  type AgentisticsEvent,
  type Confidence,
  type EventData,
  type EventIdInput,
  type EventType,
  type Id,
} from '@agentistics/core'

export const ANTIGRAVITY_ADAPTER_VERSION = '1.0.0'

/** `source.id` on every event. */
export const ANTIGRAVITY_SOURCE_ID = 'antigravity'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `deriveEventId`, over the same preimage (the Claude replay's `claudeEventId`, natively hashed). */
export function antigravityEventId(input: EventIdInput): string {
  return sha256(eventIdPreimage(input)).slice(0, EVENT_ID_LENGTH)
}

function idOf(prefix: string, ...parts: string[]): Id {
  return `${prefix}${sha256(JSON.stringify(['agentistics.antigravity-entity/v1', ...parts])).slice(0, 24)}`
}

export const sessionIdOf = (runConversationId: string): Id => idOf('ses_', 'session', runConversationId)
export const runIdOf = (runConversationId: string): Id => idOf('run_', 'run', runConversationId)
export const mainAgentIdOf = (runConversationId: string): Id => idOf('agt_', 'main', runConversationId)
/** A child conversation, as an agent of the run it was dispatched under. */
export const childAgentIdOf = (runConversationId: string, childConversationId: string): Id =>
  idOf('agt_', 'child', runConversationId, childConversationId)
/** A tool execution, by the conversation it was read from, its step index and its call position. */
export const toolExecutionIdOf = (conversationId: string, stepKey: string): Id =>
  idOf('tex_', 'tool', conversationId, stepKey)

/**
 * Which record a fold is reading, and on whose behalf. One context per CONVERSATION: the run's own
 * conversation and every child conversation get their own, sharing the run's session and run.
 */
export interface AntigravityReplayContext {
  /** The conversation THIS context reads (the run's own, or a child's). */
  conversationId: string
  /** The run's (top-level) conversation id. */
  runConversationId: string
  /** `antigravity:<conv>` for the run's own records, `antigravity:<run>/subagent/<child>` for a child's. */
  sourceRefBase: string
  sessionId: Id
  runId: Id
  agentId: Id
  /** Resolved by the IO half from `history.jsonl` / `conversation_summaries.db`, as legacy does. */
  projectPath?: string
  /**
   * The conversation's dominant `gen_metadata` model (`readAntigravityTokens`'s rule: the most
   * frequent `1.19`). The only model an ERROR_MESSAGE step can be attributed to — agy links an error
   * step to no call — so a `model.failed` carrying it is `estimated`, never `exact`.
   */
  modelHint?: string
  /** For a child context: the agent that dispatched it. */
  parentAgentId?: Id
  /** `recordedAt` on every event — the caller's clock, so the fold stays pure. */
  recordedAt: string
}

export function mainContext(conversationId: string, recordedAt: string, projectPath?: string): AntigravityReplayContext {
  return {
    conversationId,
    runConversationId: conversationId,
    sourceRefBase: `antigravity:${conversationId}`,
    sessionId: sessionIdOf(conversationId),
    runId: runIdOf(conversationId),
    agentId: mainAgentIdOf(conversationId),
    ...(projectPath ? { projectPath } : {}),
    recordedAt,
  }
}

export function childContext(
  runConversationId: string, childConversationId: string, parentAgentId: Id, recordedAt: string,
): AntigravityReplayContext {
  return {
    conversationId: childConversationId,
    runConversationId,
    sourceRefBase: `antigravity:${runConversationId}/subagent/${childConversationId}`,
    sessionId: sessionIdOf(runConversationId),
    runId: runIdOf(runConversationId),
    agentId: childAgentIdOf(runConversationId, childConversationId),
    parentAgentId,
    recordedAt,
  }
}

/** A transcript line: `<base>:<lineNo>` — re-openable with `sed -n <lineNo>p`. */
export const lineRef = (ctx: AntigravityReplayContext, lineNo: number): string => `${ctx.sourceRefBase}:${lineNo}`
/** A `gen_metadata` row: `<base>/gen_metadata:<idx>` — re-openable with `WHERE idx = <idx>`. */
export const rowRef = (ctx: AntigravityReplayContext, idx: number): string => `${ctx.sourceRefBase}/gen_metadata:${idx}`

export interface EventOptions {
  sourceRef: string
  occurredAt: string
  confidence: Confidence
  /** Several events of ONE type from ONE record. */
  ordinal?: number
  /** Defaults to the context's agent; `null` for a session/run-level event. */
  agentId?: Id | null
}

export type EmitEvent = (event: AgentisticsEvent) => void

/** One envelope. The id is `deriveEventId`'s; nothing here mints one. */
export function makeEvent<T extends EventType>(
  ctx: AntigravityReplayContext, type: T, data: EventData[T], o: EventOptions,
): AgentisticsEvent<T> {
  const agentId = o.agentId === undefined ? ctx.agentId : o.agentId
  const event: AgentisticsEvent<T> = {
    eventId: antigravityEventId({
      sourceKind: 'harness',
      sourceId: ANTIGRAVITY_SOURCE_ID,
      sourceRef: o.sourceRef,
      type,
      ...(o.ordinal !== undefined ? { ordinal: o.ordinal } : {}),
    }),
    schema: CANONICAL_EVENT_SCHEMA,
    type,
    occurredAt: o.occurredAt,
    recordedAt: ctx.recordedAt,
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    source: { kind: 'harness', id: ANTIGRAVITY_SOURCE_ID },
    provenance: {
      mode: 'replayed',
      confidence: o.confidence,
      adapterVersion: ANTIGRAVITY_ADAPTER_VERSION,
      sourceRef: o.sourceRef,
    },
    data,
  }
  if (agentId !== null) event.agentId = agentId
  return event
}
