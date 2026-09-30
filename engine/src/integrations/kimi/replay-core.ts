/**
 * integrations/kimi/replay-core.ts — PURE. Ids, the envelope builder and small helpers shared by
 * every kimi fold module. Mirrors `integrations/claude/replay-core.ts`'s shape for the same reason:
 * a replay id must be DERIVED from what the event IS, never minted, so a second replay of the same
 * kimi session converges with the first instead of duplicating it (see `deriveEventId`'s own header
 * in `@agentistics/core/canonical/event-id.ts`).
 *
 * ## No conversation text (D5)
 * Nothing here or in the sibling fold modules (`replay-model.ts`, `replay-tools.ts`,
 * `replay-agents.ts`) copies a prompt, an answer or a tool's raw input/output into an event. A
 * shell command enters only through `commandSummary()` + `redactSecrets()`, exactly as the Claude
 * replay does.
 */
import { createHash } from 'node:crypto'
import {
  CANONICAL_EVENT_SCHEMA,
  EVENT_ID_LENGTH,
  eventIdPreimage,
  type AgentisticsEvent,
  type EventIdInput,
  type Confidence,
  type EventData,
  type EventType,
  type Id,
} from '@agentistics/core'

/**
 * `adapterVersion` on every event this integration emits.
 * - 1.0.0 — session/run/agent lifecycle (main agent + one per kimi agent id — P2 §2's
 *   "improvement": legacy folds every agent into ONE flat set of session totals with no per-agent
 *   breakdown at all), `model.completed` from `usage.record` ONLY (kimi-parse.ts's own trap: the
 *   nested `step.end` copy is never read), `tool.requested`/`tool.completed`/`tool.failed` from
 *   `context.append_loop_event`'s `tool.call`/`tool.result`. No `turn.started`/`turn.ended` in this
 *   version — see `replay.ts`'s header for why, and this integration's handback for what a later
 *   version would need to verify first.
 */
export const KIMI_ADAPTER_VERSION = '1.0.0'

/** `source.id` on every event. */
export const KIMI_SOURCE_ID = 'kimi'

/**
 * SHA-256 of the UTF-8 bytes of `text`, hex, computed natively — the same function as
 * `@agentistics/core`'s dependency-free `sha256Hex`, exactly as Claude's `replay-core.ts` explains
 * (core's own copy has to stay dependency-free because it is bundled into the web app, which has no
 * `node:crypto`; this module is server-only).
 */
export function sha256HexNative(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `deriveEventId`, over the same preimage, through `sha256HexNative`. */
export function kimiEventId(input: EventIdInput): string {
  return sha256HexNative(eventIdPreimage(input)).slice(0, EVENT_ID_LENGTH)
}

function idOf(prefix: string, ...parts: string[]): Id {
  return `${prefix}${sha256HexNative(JSON.stringify(['agentistics.kimi-entity/v1', ...parts])).slice(0, 24)}`
}

export const sessionIdOf = (kimiSessionId: string): Id => idOf('ses_', 'session', kimiSessionId)
export const runIdOf = (kimiSessionId: string): Id => idOf('run_', 'run', kimiSessionId)
/** One per kimi agent id (`main`, or a subagent's own id from `state.json`'s `agents` map). */
export const agentIdOf = (kimiSessionId: string, kimiAgentId: string): Id =>
  idOf('agt_', 'agent', kimiSessionId, kimiAgentId)
/** The main agent — kimi names it `main` in `state.json`. What the journal import's coarse set uses. */
export const mainAgentIdOf = (kimiSessionId: string): Id => agentIdOf(kimiSessionId, 'main')
/** A tool execution, by the harness's own `toolCallId` — carried by both `tool.call` and `tool.result`. */
export const toolExecutionIdOf = (kimiSessionId: string, toolCallId: string): Id =>
  idOf('tex_', 'tool', kimiSessionId, toolCallId)

/**
 * Which agent's wire is being folded, and on whose behalf. One context per AGENT FILE, sharing the
 * session's own Session and Run — mirrors `ClaudeReplayContext`.
 */
export interface KimiReplayContext {
  /** The harness's own session id (the `session_<uuid>` directory name, minus the prefix). */
  kimiSessionId: string
  /** The harness's own agent id (`main`, or a `state.json`-declared subagent id). */
  kimiAgentId: string
  /** The prefix of every `sourceRef` read from this agent's wire: `kimi:<sessionId>/agents/<agentId>`. */
  sourceRefBase: string
  sessionId: Id
  runId: Id
  agentId: Id
  /** `recordedAt` on every event — the caller's clock, so the fold stays pure. */
  recordedAt: string
}

export function agentContext(
  kimiSessionId: string, kimiAgentId: string, recordedAt: string,
): KimiReplayContext {
  return {
    kimiSessionId,
    kimiAgentId,
    sourceRefBase: `kimi:${kimiSessionId}/agents/${kimiAgentId}`,
    sessionId: sessionIdOf(kimiSessionId),
    runId: runIdOf(kimiSessionId),
    agentId: agentIdOf(kimiSessionId, kimiAgentId),
    recordedAt,
  }
}

/** The record a line is: `<sourceRefBase>:<lineNo>`. Line 0 is reserved for a fact `state.json`
 *  states about the agent as a whole (its `agent.started`/`agent.ended`), never a wire line. */
export const lineRef = (ctx: KimiReplayContext, lineNo: number): string => `${ctx.sourceRefBase}:${lineNo}`

/** The record `state.json` itself is: shared by every session/run-level event. */
export const stateRef = (kimiSessionId: string): string => `kimi:${kimiSessionId}/state`

export interface EventOptions {
  /** The record this event was read from — see `lineRef`/`stateRef`. */
  sourceRef: string
  occurredAt: string
  confidence: Confidence
  /** Several events of ONE type from ONE record. */
  ordinal?: number
  /** Defaults to the context's agent; `null` for a session/run-level event that names none. */
  agentId?: Id | null
}

/** The emit callback every fold writes through. Events are never collected by the fold itself. */
export type EmitEvent = (event: AgentisticsEvent) => void

/** One envelope. The id is `deriveEventId`'s (computed by `kimiEventId`); nothing here mints one. */
export function makeEvent<T extends EventType>(
  ctx: KimiReplayContext, type: T, data: EventData[T], o: EventOptions,
): AgentisticsEvent<T> {
  const agentId = o.agentId === undefined ? ctx.agentId : o.agentId
  const event: AgentisticsEvent<T> = {
    eventId: kimiEventId({
      sourceKind: 'harness',
      sourceId: KIMI_SOURCE_ID,
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
    source: { kind: 'harness', id: KIMI_SOURCE_ID },
    provenance: {
      mode: 'replayed',
      confidence: o.confidence,
      adapterVersion: KIMI_ADAPTER_VERSION,
      sourceRef: o.sourceRef,
    },
    data,
  }
  if (agentId !== null) event.agentId = agentId
  return event
}

/** A string field of an entry, or undefined — a wire entry's types are never trusted. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** A usage counter as the source reported it (D21, 2026-09-26) — absent, never a 0, when the field
 *  is missing, not a number, non-finite or negative. */
export function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** An entry's own `time` (epoch ms) as an ISO instant, or `undefined` when absent/invalid. */
export function timeOf(entry: Record<string, unknown>): string | undefined {
  const t = entry.time
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : undefined
}
