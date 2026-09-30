/**
 * integrations/gemini/replay-core.ts — PURE. The pieces every part of the Gemini replay fold
 * shares: the adapter version, deterministic entity ids, and the one envelope builder.
 *
 * Mirrors the shape of `integrations/claude/replay-core.ts` (its own header explains WHY an id
 * must be derived rather than minted): every id here is a hash of what the entity IS, so reading
 * the same chat file twice re-derives the identical id and a replay converges instead of doubling.
 *
 * ## The session id is the SYNTHETIC path id, unconditionally
 *
 * Gemini has no harness-assigned conversation id — CLAUDE.md's "GEMINI HAS NO READER AND MAY NOT
 * GET ONE" section: gemini has neither `assignId` nor an id-taking `resume`, so the id this whole
 * product uses for a Gemini session is invented by `adapters/gemini.ts` itself, as
 * `${dirName}/${fileBase}` (the chat file's own path, two segments). That is `SessionMeta.session_id`
 * today, and it is `Run.conversationId` here too — never a UUID, and never anything derived from
 * the file's `sessionId` field (which is the CLI's own internal id and is not what the store keys
 * on). `conversationLink` is `'observed'`: this replay reads the harness's own file after the fact,
 * exactly the case master spec §13.1 names for `'observed'` and exactly what "every legacy row is"
 * (entities.ts's own comment on the union).
 *
 * ## No conversation text (D5)
 *
 * Nothing in this integration copies a message body, a thought or a tool's raw input/output into
 * an event. A shell command enters only through `commandSummary` + `redactSecrets`; a file path is
 * a NAME (allowed, like `ToolExecution.filesTouched` already permits) — and Gemini's own toolCalls
 * carry no file-path-bearing edits that need one (see `replay.ts`'s header).
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

/**
 * The `adapterVersion` on every event this integration emits.
 *
 * - 1.0.0 — session/run/agent lifecycle (both file shapes), model invocations + tool executions
 *   (rich-JSON shape only — see `replay.ts`'s header for why the append-journal shape carries
 *   neither). No incremental replay yet: every call re-reads and re-folds the WHOLE source (see
 *   `index.ts`), so there is no cursor format to version here.
 */
export const GEMINI_ADAPTER_VERSION = '1.0.0'

/** `source.id` on every event. */
export const GEMINI_SOURCE_ID = 'gemini'

/** SHA-256 of the UTF-8 bytes of `text`, hex. Native, same function `@agentistics/core`'s
 *  `sha256Hex` computes in dependency-free TypeScript — used here because this module is
 *  server-only and gemini chat files are small enough that the perf case `claude/replay-core.ts`
 *  documents (13% of a whole-store replay's CPU) does not apply. */
function sha256HexNative(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `deriveEventId`, over the same preimage, through `sha256HexNative`. */
export function geminiEventId(input: EventIdInput): string {
  return sha256HexNative(eventIdPreimage(input)).slice(0, EVENT_ID_LENGTH)
}

function idOf(prefix: string, ...parts: string[]): Id {
  return `${prefix}${sha256HexNative(JSON.stringify(['agentistics.gemini-entity/v1', ...parts])).slice(0, 24)}`
}

export const sessionIdOf = (conversationId: string): Id => idOf('ses_', 'session', conversationId)
export const runIdOf = (conversationId: string): Id => idOf('run_', 'run', conversationId)
export const mainAgentIdOf = (conversationId: string): Id => idOf('agt_', 'main', conversationId)
/** A tool execution, by the harness's own `toolCalls[].id` (the one field both the request and its
 *  inline result share on a Gemini rich-JSON message). */
export const toolExecutionIdOf = (conversationId: string, toolCallId: string): Id =>
  idOf('tex_', 'tool', conversationId, toolCallId)

/** One context per chat FILE — Gemini has no subagents (`HARNESS_CAPABILITIES.gemini.agents`
 *  is `false`), so unlike Claude's replay there is only ever the main role. */
export interface GeminiReplayContext {
  /** The synthetic path id — see this module's header. */
  conversationId: string
  /** The prefix of every `sourceRef` this file's events carry: `gemini:<conversationId>`. */
  sourceRefBase: string
  sessionId: Id
  runId: Id
  agentId: Id
  /** The project this chat belongs to (`adapters/gemini.ts`'s `projectMap` lookup), when known. */
  projectPath?: string
  /** `recordedAt` on every event — the caller's clock, so the fold stays pure. */
  recordedAt: string
}

export function geminiContext(conversationId: string, projectPath: string | undefined, recordedAt: string): GeminiReplayContext {
  return {
    conversationId,
    sourceRefBase: `gemini:${conversationId}`,
    sessionId: sessionIdOf(conversationId),
    runId: runIdOf(conversationId),
    agentId: mainAgentIdOf(conversationId),
    ...(projectPath ? { projectPath } : {}),
    recordedAt,
  }
}

export interface EventOptions {
  /** The record this event was read from — a message index, a line number, or an `:open`/`:close`
   *  marker for a lifecycle event with no single record to point at. */
  sourceRef: string
  occurredAt: string
  confidence: Confidence
  /** Several events of ONE type from ONE record (e.g. two tool calls on one message). */
  ordinal?: number
  /** `null` for a session/run-level event that names no agent; defaults to the context's agent. */
  agentId?: Id | null
}

/** The emit callback every fold writes through. Events are never collected by the fold itself. */
export type EmitEvent = (event: AgentisticsEvent) => void

/** One envelope. The id is `deriveEventId`'s (computed by `geminiEventId`); nothing here mints one. */
export function makeEvent<T extends EventType>(
  ctx: GeminiReplayContext, type: T, data: EventData[T], o: EventOptions,
): AgentisticsEvent<T> {
  const agentId = o.agentId === undefined ? ctx.agentId : o.agentId
  const event: AgentisticsEvent<T> = {
    eventId: geminiEventId({
      sourceKind: 'harness',
      sourceId: GEMINI_SOURCE_ID,
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
    source: { kind: 'harness', id: GEMINI_SOURCE_ID },
    provenance: {
      mode: 'replayed',
      confidence: o.confidence,
      adapterVersion: GEMINI_ADAPTER_VERSION,
      sourceRef: o.sourceRef,
    },
    data,
  }
  if (agentId !== null) event.agentId = agentId
  return event
}

/** A non-empty string field, or undefined — a chat file's fields are never trusted blindly. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** A usage counter as the source reported it (D21): a finite non-negative number, or absent —
 *  never a 0 standing in for "not stated". */
export function counter(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}
