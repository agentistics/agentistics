/**
 * integrations/claude/replay-core.ts — PURE. The pieces every part of the Claude replay fold shares:
 * the adapter version, the deterministic entity ids, and the one function that builds an envelope.
 *
 * It exists as its own module so `replay-model.ts`, `replay-tools.ts` and `replay-agents.ts` can each
 * build events without importing `replay.ts` (which imports all three) — the dependency runs one way.
 *
 * ## Ids are DERIVED, like event ids
 *
 * `entities.ts` says an entity id is minted by the writer with a type prefix. A replay is a writer
 * that must produce the SAME id every time it reads the same conversation, or a second replay would
 * describe a second session. So each id is the prefix plus a hash of what the entity IS: the
 * conversation for its Session and its Run (D1: legacy data projects 1 Session -> 1 Run), the
 * conversation plus the harness's own agent id for a subagent, the conversation plus the harness's
 * own `tool_use.id` for a tool execution. Opaque to every reader, as the entity contract requires.
 *
 * ## No conversation text
 *
 * P1 stores counters, ids, names and summaries only (D5, strictest reading). Nothing in this module
 * or the folds that use it copies a message body, a thinking block, a tool input or a tool output
 * into an event. A shell command enters only through `commandSummary` plus `redactSecrets`.
 */
import {
  CANONICAL_EVENT_SCHEMA,
  deriveEventId,
  sha256Hex,
  type AgentisticsEvent,
  type Confidence,
  type EventData,
  type EventType,
  type Id,
} from '@agentistics/core'

/**
 * The `adapterVersion` on every event this integration emits. Bump it whenever what an event SAYS
 * about the same transcript changes, so a projection can tell which events predate a parser fix.
 *
 * - 1.0.0 — session/run/agent lifecycle, model invocations, tool executions.
 * - 1.1.0 — adds `context.compacted`. A transcript replayed at 1.0.0 carries no compaction events,
 *   which a projection must read as "not recorded by this version", never as "never compacted".
 */
export const CLAUDE_ADAPTER_VERSION = '1.1.0'

/** `source.id` on every event. */
export const CLAUDE_SOURCE_ID = 'claude'

function idOf(prefix: string, ...parts: string[]): Id {
  return `${prefix}${sha256Hex(JSON.stringify(['agentistics.claude-entity/v1', ...parts])).slice(0, 24)}`
}

export const sessionIdOf = (conversationId: string): Id => idOf('ses_', 'session', conversationId)
export const runIdOf = (conversationId: string): Id => idOf('run_', 'run', conversationId)
export const mainAgentIdOf = (conversationId: string): Id => idOf('agt_', 'main', conversationId)
/** A subagent, by the harness's own `agentId` (the `agent-<agentId>.jsonl` name). */
export const subagentIdOf = (conversationId: string, harnessAgentId: string): Id =>
  idOf('agt_', 'subagent', conversationId, harnessAgentId)
/** A tool execution, by the harness's own `tool_use.id`, which request and result both carry. */
export const toolExecutionIdOf = (conversationId: string, toolUseId: string): Id =>
  idOf('tex_', 'tool', conversationId, toolUseId)

/**
 * Which transcript a fold is reading, and on whose behalf. One context per FILE: the main
 * transcript and every subagent transcript get their own, sharing the conversation's session and run.
 */
export interface ClaudeReplayContext {
  /** The harness's own conversation id (the transcript's basename). */
  conversationId: string
  /**
   * The prefix of every `sourceRef` read from this file. `claude:<conversationId>` for the main
   * transcript, `claude:<conversationId>/subagents/<agentId>` for a subagent's; the record is then
   * `<prefix>:<lineNo>`, which a person can re-open with `sed -n <lineNo>p`.
   */
  sourceRefBase: string
  sessionId: Id
  runId: Id
  /** The agent every model and tool event read from this file belongs to. */
  agentId: Id
  /** `recordedAt` on every event — the caller's clock, so the fold stays pure. */
  recordedAt: string
}

export function mainContext(conversationId: string, recordedAt: string): ClaudeReplayContext {
  return {
    conversationId,
    sourceRefBase: `claude:${conversationId}`,
    sessionId: sessionIdOf(conversationId),
    runId: runIdOf(conversationId),
    agentId: mainAgentIdOf(conversationId),
    recordedAt,
  }
}

export function subagentContext(
  conversationId: string, harnessAgentId: string, recordedAt: string,
): ClaudeReplayContext {
  return {
    conversationId,
    sourceRefBase: `claude:${conversationId}/subagents/${harnessAgentId}`,
    sessionId: sessionIdOf(conversationId),
    runId: runIdOf(conversationId),
    agentId: subagentIdOf(conversationId, harnessAgentId),
    recordedAt,
  }
}

/** The record a line is: `<sourceRefBase>:<lineNo>`. */
export const lineRef = (ctx: ClaudeReplayContext, lineNo: number): string => `${ctx.sourceRefBase}:${lineNo}`

export interface EventOptions {
  /** The record this event was read from — see `lineRef`. */
  sourceRef: string
  occurredAt: string
  confidence: Confidence
  /** Several events of ONE type from ONE record. */
  ordinal?: number
  /** Only for `model.*`: the provider's response id, which then keys the event (O-8). */
  providerRequestId?: string
  /** Defaults to the context's agent; `null` for a session/run-level event that names none. */
  agentId?: Id | null
  /** The Claude Code version the line was written by (`entry.version`), when stated. */
  harnessVersion?: string
}

/** The emit callback every fold writes through. Events are never collected by the fold itself. */
export type EmitEvent = (event: AgentisticsEvent) => void

/** One envelope. The id comes from `deriveEventId`; nothing here mints one. */
export function makeEvent<T extends EventType>(
  ctx: ClaudeReplayContext, type: T, data: EventData[T], o: EventOptions,
): AgentisticsEvent<T> {
  const agentId = o.agentId === undefined ? ctx.agentId : o.agentId
  const event: AgentisticsEvent<T> = {
    eventId: deriveEventId({
      sourceKind: 'harness',
      sourceId: CLAUDE_SOURCE_ID,
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
    source: {
      kind: 'harness',
      id: CLAUDE_SOURCE_ID,
      ...(o.harnessVersion ? { version: o.harnessVersion } : {}),
    },
    provenance: {
      mode: 'replayed',
      confidence: o.confidence,
      adapterVersion: CLAUDE_ADAPTER_VERSION,
      sourceRef: o.sourceRef,
    },
    data,
  }
  if (agentId !== null) event.agentId = agentId
  return event
}

/** A string field of an entry, or undefined — a transcript line's types are never trusted. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** A finite non-negative number, or 0. */
export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}
