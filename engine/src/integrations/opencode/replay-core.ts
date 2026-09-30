/**
 * integrations/opencode/replay-core.ts — PURE. What every part of the opencode replay fold shares:
 * the adapter version, the deterministic entity ids, and the one function that builds an envelope.
 *
 * opencode's own store is a SQLite database (`~/.local/share/opencode/opencode.db`), not a
 * transcript directory, so this replay's shape differs from Claude/Codex/Kimi's line-oriented ones
 * in one respect only: there is no "adding a harness" adapter behind it at all (CLAUDE.md step 4 is
 * marked "skipped by scope" — opencode has no `adapters/opencode.ts` / `opencode-parse.ts`, and
 * therefore never appears in `SessionMeta` on any surface). This module still follows the shape
 * `integrations/codex/replay-core.ts` set, because the P2 half of the checklist (steps 11-19) does
 * not depend on a legacy adapter existing:
 *
 * 1. **Ids are DERIVED, never minted.** An entity id is a prefix plus a hash of what the entity IS —
 *    the opencode `session.id` for its Session, Run and main Agent (opencode's own session already
 *    has NO concept broader than one conversation: `Session 1:1 Run` here, same as codex's D1 — and
 *    its own `part.id` for a tool execution). Re-reading the same session re-derives the identical
 *    ids, which is what lets the journal dedupe a cold re-read instead of doubling it.
 * 2. **`sourceRef` names the RECORD**: `opencode:<sessionId>:<ordinal>`, where `ordinal` is this
 *    fold's own STABLE reading order over the session's rows (see `replay.ts`'s `orderedRecords`) —
 *    never a SQLite `rowid`, which the database does not guarantee is stable across a VACUUM and
 *    which a read-only, `{readonly:true}` connection has no way to page through predictably anyway.
 *    The ordinal is 0-based over EVERY message and EVERY part of the session it read, in the fixed
 *    order `orderedRecords` establishes — `sed -n` cannot re-open a SQL row the way it can a JSONL
 *    line, so `sourceRef` here is a POINTER FOR HUMANS AND TESTS, not a literal re-open command; the
 *    fixture rebuilds the same ordinal sequence from the redacted rows to check it.
 * 3. **No conversation text** (D5): counters, ids, names, model ids. A shell command enters only as
 *    `redactSecrets(commandSummary(cmd))`, exactly as every other replay in this repo does it.
 *
 * ## Changelog — bump `OPENCODE_ADAPTER_VERSION` whenever what an event SAYS about the same session changes
 *
 * - 1.0.0 — session/run/main-agent lifecycle; one `model.completed` per opencode `message` row of
 *   role `assistant` (opencode does not repeat one billed response across several rows the way
 *   Claude does — verified against the real store: `session.tokens_*` equals the straight sum of
 *   every assistant message's own `tokens{…}`, which equals the sum of its `part` rows'
 *   `step-finish.tokens` — so there is no dedupe rule to apply here, unlike Claude/Kimi/agy);
 *   `tool.requested`/`tool.completed`/`tool.failed` per `part` row of `type: "tool"`;
 *   `turn.started` per `message` row of role `user` (D22), `turn.ended` at the point
 *   `activeTime.ts`'s D25 rule closes it (`'measured'` off the LAST assistant message's own
 *   `time.completed` within the turn — every assistant message carries one — never `'last-line'`,
 *   since a turn with any assistant reply always has a measured close here).
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

export const OPENCODE_ADAPTER_VERSION = '1.0.0'

/** `source.id` on every event — the key the projection's `*_SINCE` tables are read by. */
export const OPENCODE_SOURCE_ID = 'opencode'

/** SHA-256 hex through `node:crypto` — the same function every other replay's `replay-core.ts` uses. */
function sha256HexNative(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `deriveEventId`, over the same preimage. */
export function opencodeEventId(input: EventIdInput): string {
  return sha256HexNative(eventIdPreimage(input)).slice(0, EVENT_ID_LENGTH)
}

function idOf(prefix: string, ...parts: string[]): Id {
  return `${prefix}${sha256HexNative(JSON.stringify(['agentistics.opencode-entity/v1', ...parts])).slice(0, 24)}`
}

/** opencode's own `session.id` (`ses_…`) — D1: one opencode session projects to one Session/Run. */
export const sessionIdOf = (opencodeSessionId: string): Id => idOf('ses_', 'session', opencodeSessionId)
export const runIdOf = (opencodeSessionId: string): Id => idOf('run_', 'run', opencodeSessionId)
export const mainAgentIdOf = (opencodeSessionId: string): Id => idOf('agt_', 'main', opencodeSessionId)
/** A tool execution, keyed by opencode's own `part.id` (unique per row, unlike a `callID`, which a
 *  retried tool call could repeat — no such repeat was observed, but the row id is exact either way). */
export const toolExecutionIdOf = (opencodeSessionId: string, partId: string): Id =>
  idOf('tex_', 'tool', opencodeSessionId, partId)

/**
 * Which opencode session a fold is reading. `sessionId` is opencode's own `session.id`, known before
 * a row is read (discovery lists it from the `session` table's `id` column), so the entity ids never
 * depend on what the rows turn out to say.
 */
export interface OpencodeReplayContext {
  sessionId: string
  entitySessionId: Id
  runId: Id
  agentId: Id
  /** `recordedAt` on every event — the caller's clock, so the fold stays pure. */
  recordedAt: string
}

export function opencodeContext(sessionId: string, recordedAt: string): OpencodeReplayContext {
  return {
    sessionId,
    entitySessionId: sessionIdOf(sessionId),
    runId: runIdOf(sessionId),
    agentId: mainAgentIdOf(sessionId),
    recordedAt,
  }
}

/** The record at reading-order position `ordinal`: `opencode:<sessionId>:<ordinal>`. */
export const recordRef = (ctx: OpencodeReplayContext, ordinal: number): string =>
  `${OPENCODE_SOURCE_ID}:${ctx.sessionId}:${ordinal}`

export interface EventOptions {
  sourceRef: string
  occurredAt: string
  confidence: Confidence
  ordinal?: number
  /** Defaults to the main agent; `null` for a session/run-level event. */
  agentId?: Id | null
  /** opencode's own `session.version` (the CLI build that wrote the row), when known. */
  harnessVersion?: string
}

export type EmitEvent = (event: AgentisticsEvent) => void

export function makeEvent<T extends EventType>(
  ctx: OpencodeReplayContext, type: T, data: EventData[T], o: EventOptions,
): AgentisticsEvent<T> {
  const agentId = o.agentId === undefined ? ctx.agentId : o.agentId
  const event: AgentisticsEvent<T> = {
    eventId: opencodeEventId({
      sourceKind: 'harness',
      sourceId: OPENCODE_SOURCE_ID,
      sourceRef: o.sourceRef,
      type,
      ...(o.ordinal !== undefined ? { ordinal: o.ordinal } : {}),
    }),
    schema: CANONICAL_EVENT_SCHEMA,
    type,
    occurredAt: o.occurredAt,
    recordedAt: ctx.recordedAt,
    sessionId: ctx.entitySessionId,
    runId: ctx.runId,
    source: {
      kind: 'harness',
      id: OPENCODE_SOURCE_ID,
      ...(o.harnessVersion ? { version: o.harnessVersion } : {}),
    },
    provenance: {
      mode: 'replayed',
      confidence: o.confidence,
      adapterVersion: OPENCODE_ADAPTER_VERSION,
      sourceRef: o.sourceRef,
    },
    data,
  }
  if (agentId !== null) event.agentId = agentId
  return event
}

/** A non-empty string, or undefined — a database row's types are never trusted (`data` columns are
 *  hand-parsed JSON, and a hand-parsed value is exactly as trustworthy as a hand-parsed line). */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** A finite number, or undefined. */
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
