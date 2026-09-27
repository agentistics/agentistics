/**
 * integrations/copilot/replay-core.ts — PURE. The pieces every part of the Copilot replay fold
 * shares: the adapter version, the deterministic entity ids, and the one function that builds an
 * envelope. Mirrors `integrations/claude/replay-core.ts` — same shapes, same rules, a different
 * harness's own record underneath.
 *
 * ## Ids are DERIVED, like event ids
 *
 * A replay is a writer that must produce the SAME id every time it reads the same session, or a
 * second replay would describe a second run. Copilot has no subagents (`HARNESS_CAPABILITIES.
 * copilot.agents === false`, and confirmed on every real session read for this integration: no
 * agent-launch shape exists in `events.jsonl` at all), so there is exactly one Agent per Run — the
 * main one — and every id below is keyed on the session directory's own name (`<uuid>`, the
 * harness's own identifier, read verbatim off `~/.copilot/session-state/<id>/`).
 *
 * ## No conversation text (D5)
 *
 * Nothing here or in the folds that use it copies a message body, a tool's arguments or a tool's
 * result text into an event. A shell command enters only through `commandSummary` plus
 * `redactSecrets`, exactly as the Claude replay does it.
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
 * The `adapterVersion` on every event this integration emits.
 *
 * - 1.0.0 — session/run/agent lifecycle (one Run, one Agent — Copilot has no subagents), tool
 *   executions (`tool.execution_start` / `tool.execution_complete`), MCP calls (`mcp.tool_call`,
 *   unverified shape — see `replay.ts`'s header), and ONE `model.completed` per model named in
 *   `session.shutdown.modelMetrics` — Copilot's only token report, cumulative, written once (P2 §2:
 *   "tokens and lines exist ONLY at session.shutdown"). A session with no `session.shutdown` line
 *   (a crash) emits `run.ended`/`agent.ended` with `status: 'failed'` and NO model invocation at
 *   all — never a zero-token one (D21).
 */
export const COPILOT_ADAPTER_VERSION = '1.0.0'

/** `source.id` on every event. */
export const COPILOT_SOURCE_ID = 'copilot'

/** SHA-256 of the UTF-8 bytes of `text`, hex — the native counterpart of core's dependency-free
 *  `sha256Hex`, computed the same way `replay-core.ts` (claude) does for the same reason: this
 *  module is server-only, so `node:crypto` is available and considerably faster. */
export function sha256HexNative(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `deriveEventId`, over the same preimage, through `sha256HexNative`. */
export function copilotEventId(input: EventIdInput): string {
  return sha256HexNative(eventIdPreimage(input)).slice(0, EVENT_ID_LENGTH)
}

function idOf(prefix: string, ...parts: string[]): Id {
  return `${prefix}${sha256HexNative(JSON.stringify(['agentistics.copilot-entity/v1', ...parts])).slice(0, 24)}`
}

export const sessionIdOf = (copilotSessionId: string): Id => idOf('ses_', 'session', copilotSessionId)
export const runIdOf = (copilotSessionId: string): Id => idOf('run_', 'run', copilotSessionId)
export const mainAgentIdOf = (copilotSessionId: string): Id => idOf('agt_', 'main', copilotSessionId)
/** A tool execution, by the harness's own `data.toolCallId`, which the start and complete records
 *  both carry. */
export const toolExecutionIdOf = (copilotSessionId: string, toolCallId: string): Id =>
  idOf('tex_', 'tool', copilotSessionId, toolCallId)
/** An MCP call has no start/end pair of its own (one atomic `mcp.tool_call` record) — keyed on its
 *  ordinal within the session so two calls to the same tool never collide. */
export const mcpExecutionIdOf = (copilotSessionId: string, ordinal: number): Id =>
  idOf('tex_', 'mcp', copilotSessionId, String(ordinal))
/** The synthetic execution representing `session.shutdown.data.codeChanges` — a SESSION-WIDE
 *  aggregate with no tool call of its own to attribute it to (see `replay.ts`'s header). One per
 *  session, so no ordinal is needed. */
export const shutdownEditsToolExecutionId = (copilotSessionId: string): Id =>
  idOf('tex_', 'shutdown-edits', copilotSessionId)

/** Which transcript a fold is reading, and on whose behalf — one context per session (Copilot has
 *  exactly one file per session, unlike Claude's main-plus-subagents). */
export interface CopilotReplayContext {
  /** The harness's own session id (the `session-state/<id>` directory name). */
  copilotSessionId: string
  /** The prefix of every `sourceRef` read from this file: `copilot:<id>`; the record is then
   *  `<prefix>:<lineNo>`, which a person can re-open with `sed -n <lineNo>p`. */
  sourceRefBase: string
  sessionId: Id
  runId: Id
  agentId: Id
  /** `recordedAt` on every event — the caller's clock, so the fold stays pure. */
  recordedAt: string
}

export function mainContext(copilotSessionId: string, recordedAt: string): CopilotReplayContext {
  return {
    copilotSessionId,
    sourceRefBase: `copilot:${copilotSessionId}`,
    sessionId: sessionIdOf(copilotSessionId),
    runId: runIdOf(copilotSessionId),
    agentId: mainAgentIdOf(copilotSessionId),
    recordedAt,
  }
}

/** The record a line is: `<sourceRefBase>:<lineNo>`. */
export const lineRef = (ctx: CopilotReplayContext, lineNo: number): string => `${ctx.sourceRefBase}:${lineNo}`

export interface EventOptions {
  /** The record this event was read from — see `lineRef`. */
  sourceRef: string
  occurredAt: string
  confidence: Confidence
  /** Several events of ONE type from ONE record (e.g. several models in one `session.shutdown`). */
  ordinal?: number
  /** Only for `model.*`: the provider's response id — Copilot's local files carry none, so this is
   *  always omitted and the event falls back to the source path (O-8). */
  providerRequestId?: string
  /** Defaults to the context's agent; `null` for a session/run-level event that names none. */
  agentId?: Id | null
}

/** The emit callback every fold writes through. Events are never collected by the fold itself. */
export type EmitEvent = (event: AgentisticsEvent) => void

/** One envelope. The id is `deriveEventId`'s (computed by `copilotEventId`); nothing here mints one. */
export function makeEvent<T extends EventType>(
  ctx: CopilotReplayContext, type: T, data: EventData[T], o: EventOptions,
): AgentisticsEvent<T> {
  const agentId = o.agentId === undefined ? ctx.agentId : o.agentId
  const event: AgentisticsEvent<T> = {
    eventId: copilotEventId({
      sourceKind: 'harness',
      sourceId: COPILOT_SOURCE_ID,
      sourceRef: o.sourceRef,
      type,
      ...(o.ordinal !== undefined ? { ordinal: o.ordinal } : {}),
      ...(o.providerRequestId ? { providerRequestId: o.providerRequestId } : {}),
    }),
    schema: CANONICAL_EVENT_SCHEMA,
    type,
    occurredAt: o.occurredAt,
    recordedAt: ctx.recordedAt,
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    source: { kind: 'harness', id: COPILOT_SOURCE_ID },
    provenance: {
      mode: 'replayed',
      confidence: o.confidence,
      adapterVersion: COPILOT_ADAPTER_VERSION,
      sourceRef: o.sourceRef,
    },
    data,
  }
  if (agentId !== null) event.agentId = agentId
  return event
}

/** A string field of a record, or undefined — a Copilot event's fields are never trusted. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** A finite non-negative number, or undefined (D21: a counter that is not a real number is ABSENT,
 *  never a 0 standing in for "not reported"). */
export function counter(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}
