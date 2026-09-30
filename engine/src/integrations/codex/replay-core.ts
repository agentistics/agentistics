/**
 * integrations/codex/replay-core.ts — PURE. What every part of the Codex replay fold shares: the
 * adapter version, the deterministic entity ids, and the one function that builds an envelope.
 *
 * It is the Codex twin of `integrations/claude/replay-core.ts` and follows the same three rules:
 *
 * 1. **Ids are DERIVED, never minted.** An entity id is a prefix plus a hash of what the entity IS
 *    (the rollout for its Session, Run and main Agent — D1: legacy data projects 1 Session -> 1 Run —
 *    and the rollout plus Codex's own `call_id` for a tool execution), and an event id is
 *    `deriveEventId`'s over the record it was read from. Re-reading the same rollout re-derives the
 *    identical ids, which is what lets the journal dedupe a cold re-read instead of doubling it.
 * 2. **`sourceRef` names the RECORD**: `codex:<rolloutId>:<lineNo>`, 1-based over every raw line,
 *    blanks included — `sed -n <lineNo>p` on the rollout re-opens it.
 * 3. **No conversation text** (D5): counters, ids, names, model ids. A shell command enters only as
 *    `redactSecrets(commandSummary(cmd))`, exactly as the Claude replay does it.
 *
 * ## Changelog — bump `CODEX_ADAPTER_VERSION` whenever what an event SAYS about the same rollout changes
 *
 * - 1.0.0 — session/run/main-agent lifecycle; one `model.completed` per TURN carrying the DELTA of
 *   Codex's cumulative `total_token_usage` across that turn (P2 §2, the codex trap); `tool.requested`
 *   per `*_call` record; `turn.started` per `user_message` (D22) and `turn.ended` at the point
 *   `activeTime.ts` closes the turn (D25: `measured` on `task_complete.duration_ms`, `last-line`
 *   otherwise).
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

export const CODEX_ADAPTER_VERSION = '1.0.0'

/** `source.id` on every event — the key the projection's `*_SINCE` tables are read by. */
export const CODEX_SOURCE_ID = 'codex'

/** SHA-256 hex through `node:crypto` — the same function as core's `sha256Hex` (see Claude's twin). */
function sha256HexNative(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `deriveEventId`, over the same preimage. */
export function codexEventId(input: EventIdInput): string {
  return sha256HexNative(eventIdPreimage(input)).slice(0, EVENT_ID_LENGTH)
}

function idOf(prefix: string, ...parts: string[]): Id {
  return `${prefix}${sha256HexNative(JSON.stringify(['agentistics.codex-entity/v1', ...parts])).slice(0, 24)}`
}

export const sessionIdOf = (rolloutId: string): Id => idOf('ses_', 'session', rolloutId)
export const runIdOf = (rolloutId: string): Id => idOf('run_', 'run', rolloutId)
export const mainAgentIdOf = (rolloutId: string): Id => idOf('agt_', 'main', rolloutId)
/** A tool execution, by Codex's own `call_id` (or, when a record carries none, its line). */
export const toolExecutionIdOf = (rolloutId: string, callKey: string): Id => idOf('tex_', 'tool', rolloutId, callKey)

/**
 * Which rollout a fold is reading. `rolloutId` is the id the IO half DISCOVERED the file under (the
 * UUID in `rollout-<stamp>-<uuid>.jsonl`, else the basename) — known before a byte is read, so the
 * entity ids never depend on what the file turns out to say. The conversation id Codex states in
 * `session_meta` travels separately, on `run.started.conversationId`.
 */
export interface CodexReplayContext {
  rolloutId: string
  /** The legacy fallback id (`parseCodexRollout`'s second argument): the basename without `.jsonl`. */
  fallbackId: string
  sessionId: Id
  runId: Id
  agentId: Id
  /** `recordedAt` on every event — the caller's clock, so the fold stays pure. */
  recordedAt: string
}

export function codexContext(rolloutId: string, fallbackId: string, recordedAt: string): CodexReplayContext {
  return {
    rolloutId,
    fallbackId,
    sessionId: sessionIdOf(rolloutId),
    runId: runIdOf(rolloutId),
    agentId: mainAgentIdOf(rolloutId),
    recordedAt,
  }
}

/** The record a line is: `codex:<rolloutId>:<lineNo>`. */
export const lineRef = (ctx: CodexReplayContext, lineNo: number): string => `${CODEX_SOURCE_ID}:${ctx.rolloutId}:${lineNo}`

export interface EventOptions {
  sourceRef: string
  occurredAt: string
  confidence: Confidence
  ordinal?: number
  /** Defaults to the main agent; `null` for a session/run-level event. */
  agentId?: Id | null
  /** Codex's `cli_version`, when the rollout stated it. */
  harnessVersion?: string
}

export type EmitEvent = (event: AgentisticsEvent) => void

export function makeEvent<T extends EventType>(
  ctx: CodexReplayContext, type: T, data: EventData[T], o: EventOptions,
): AgentisticsEvent<T> {
  const agentId = o.agentId === undefined ? ctx.agentId : o.agentId
  const event: AgentisticsEvent<T> = {
    eventId: codexEventId({
      sourceKind: 'harness',
      sourceId: CODEX_SOURCE_ID,
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
    source: {
      kind: 'harness',
      id: CODEX_SOURCE_ID,
      ...(o.harnessVersion ? { version: o.harnessVersion } : {}),
    },
    provenance: {
      mode: 'replayed',
      confidence: o.confidence,
      adapterVersion: CODEX_ADAPTER_VERSION,
      sourceRef: o.sourceRef,
    },
    data,
  }
  if (agentId !== null) event.agentId = agentId
  return event
}

/** A non-empty string, or undefined — a rollout line's types are never trusted. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
