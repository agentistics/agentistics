/**
 * canonical/event.ts — the envelope and the closed vocabulary of the canonical journal.
 *
 * ## Why this file exists
 *
 * Every fact the runtime learns — from a transcript read after the fact, a hook, a gateway, the
 * runtime's own execution — becomes ONE `AgentisticsEvent`. The journal stores them, projections
 * derive every metric from them, and re-projection after a parser fix works only because each event
 * still says which code produced it. So this module is types and a few constant tuples, and nothing
 * else: no IO, no clock, no hashing (`deriveEventId` lives with the journal).
 *
 * ## The rules it encodes, each of which was a real defect first
 *
 * 1. **`provenance.adapterVersion` is REQUIRED.** `parse-cache.ts` carries no parser version, so a
 *    parser fix could never be forced through the cache; an event that cannot name the code that
 *    produced it cannot be re-projected either (master spec §45).
 * 2. **`occurredAt` and `recordedAt` are both required and never conflated.** Ingestion order is not
 *    execution order: a hook fires before the transcript line is flushed, a backfill lands days late.
 * 3. **`provenance.mode` and `provenance.confidence` are SEPARATE fields.** An `observed` event can
 *    be exact (a token counter read straight out of a file) and an `instrumented` one can be
 *    estimated (a cost priced from a table). Folding the two together is how "the harness said so"
 *    comes to mean "it is exact".
 * 4. **`data` is typed per `type`, and `EventData` is TOTAL over `EVENT_TYPES`.** A union with a
 *    loose payload is how a field that carries an instruction appears unnoticed; a type added to the
 *    vocabulary without a data shape fails the build (see `_EventDataIsTotal` below).
 *
 * ## The frontier (master spec §38)
 *
 * An event carries FACTS and never an instruction. No data shape and no envelope field is named after
 * a thing to do or a thing to say back — a lint greps this module's property names for exactly that,
 * the way `events-frontier.test.ts` guards the notification channel. Two consequences are visible in
 * the shapes: a side process carries its summarised invocation as `summary`, and a browser event
 * carries WHAT HAPPENED as `kind`. The `*.approved` / `*.denied` types record a decision somebody
 * already made; nothing here may make one.
 *
 * ## The vocabulary is closed
 *
 * Harness-specific facts do NOT get event types of their own — they travel as typed fields on the
 * event that carries them. A new harness therefore cannot widen the vocabulary silently; widening it
 * is an edit to `EVENT_TYPES`, which the compiler then forces through `EventData`.
 */

import type { ProviderId } from '../providers'
import type {
  AgentKind,
  AgentStatus,
  ArtifactKind,
  BrowserActionKind,
  BrowserImplementation,
  ConversationLink,
  Id,
  ModelInvocationStatus,
  ReasoningBilling,
  RunHarness,
  RunStatus,
  SessionOrigin,
  SideProcessKind,
  SideProcessEndedBy,
  ToolApproval,
  ToolKind,
  ToolStatus,
} from './entities'

// ── Confidence (D17) ────────────────────────────────────────────────────────────────────────────

/**
 * How certain a value is — THE one confidence vocabulary of the codebase (owner decision D17,
 * 2026-09-25). Defined here and nowhere else; `capabilities.ts` and every projection import it.
 *
 * There is deliberately no `derived`: that level described HOW a value was computed, not how sure
 * it is, and mixed the two questions. The rule instead:
 * - a value computed from exact inputs by a deterministic rule stays `exact`;
 * - it becomes `estimated` the moment the rule introduces an estimate (a price table, a token
 *   approximation, a blended rate);
 * - `inferred` is a value reached by correlation or guesswork (time-and-directory matching, a
 *   correlation by `(agentId, startedAt, model)` where no provider id exists).
 * A value is as confident as its WEAKEST input — see `weakestConfidence`.
 */
export type Confidence = 'exact' | 'estimated' | 'inferred'

/** Every `Confidence`, ordered STRONGEST to WEAKEST. `weakestConfidence` relies on this order. */
export const CONFIDENCES = ['exact', 'estimated', 'inferred'] as const satisfies readonly Confidence[]

/**
 * The confidence of a value built from these inputs: the weakest of them.
 *
 * At least one input is REQUIRED by the signature. With zero inputs there is no honest answer —
 * returning `exact` would certify a number nothing vouched for, and returning `inferred` would
 * understate one for no reason — so the case is made unrepresentable instead of decided.
 */
export function weakestConfidence(first: Confidence, ...rest: Confidence[]): Confidence {
  let weakest = first
  for (const c of rest) {
    if (CONFIDENCES.indexOf(c) > CONFIDENCES.indexOf(weakest)) weakest = c
  }
  return weakest
}

// ── Provenance ──────────────────────────────────────────────────────────────────────────────────

/**
 * HOW the event reached us — never how certain it is (that is `Confidence`).
 * - `native`: the runtime executed the thing itself.
 * - `instrumented`: a hook, a gateway or telemetry reported it as it happened.
 * - `observed`: read off a harness's own artifact (a transcript, a db row) while it was live.
 * - `inferred`: reconstructed by correlation where no source states it.
 * - `replayed`: read back after the fact from a stored source (a backfill of old transcripts).
 */
export type ProvenanceMode = 'native' | 'instrumented' | 'observed' | 'inferred' | 'replayed'

/** Which KIND of producer an event came from. `source.id` then names the specific one. */
export type SourceKind = 'harness' | 'provider' | 'gateway' | 'runtime' | 'alm' | 'adapter'

/**
 * The envelope's version (master spec §45). Bumped on any breaking change to the envelope; the
 * journal rejects an event whose `schema` is newer than this (`schema-too-new`), and a reader
 * tolerates every schema it has ever written.
 */
export const CANONICAL_EVENT_SCHEMA = 1

// ── The vocabulary ──────────────────────────────────────────────────────────────────────────────

/**
 * The §14.1 types every adapter claiming the capability at all MUST emit. A subset of
 * `EVENT_TYPES` (checked below), so it can never name a type the vocabulary lacks.
 */
export const REQUIRED_EVENT_TYPES = [
  'session.started', 'session.ended',
  'run.started', 'run.ended',
  'agent.started', 'agent.ended',
  'model.invoked', 'model.completed', 'model.failed',
  'tool.requested', 'tool.completed', 'tool.failed',
] as const

/**
 * Every event type there is. §14.1's required and optional lists, PLUS `process.started` /
 * `process.ended`: §14.1's list omits them, but §13.4 states a `SideProcess`'s lifecycle IS events,
 * so "what is still running because of this task" is a projection rather than a `ps` at render time.
 * Leaving them out would make that section unimplementable without widening the vocabulary later.
 */
export const EVENT_TYPES = [
  ...REQUIRED_EVENT_TYPES,
  // streaming
  'model.started', 'model.delta',
  // tool lifecycle detail
  'tool.approved', 'tool.denied', 'tool.progress',
  // MCP
  'mcp.requested', 'mcp.completed',
  // browser
  'browser.session.started', 'browser.tab.created', 'browser.tab.focused', 'browser.navigation',
  'browser.click', 'browser.input', 'browser.scroll', 'browser.screenshot', 'browser.download',
  'browser.tab.closed',
  // context
  'context.compacted', 'context.window.observed',
  // policy
  'policy.requested', 'policy.approved', 'policy.denied',
  // ALM
  'alm.task.created', 'alm.task.updated', 'alm.task.completed', 'alm.evidence.attached',
  // side processes (§13.4)
  'process.started', 'process.ended',
] as const

export type EventType = typeof EVENT_TYPES[number]
export type RequiredEventType = typeof REQUIRED_EVENT_TYPES[number]

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(EVENT_TYPES)

/**
 * Whether a string names a type in the vocabulary. The journal rejects the rest as `unknown-type`
 * rather than storing an event no projection can read.
 */
export function isEventType(x: string): x is EventType {
  return EVENT_TYPE_SET.has(x)
}

// ── Data shapes ─────────────────────────────────────────────────────────────────────────────────
//
// Minimal and factual: each carries what the envelope does not already say (the envelope holds the
// ids of the session/run/agent/task and both timestamps). No `unknown`, no `any`, no open record —
// a loose payload is where an unreviewed field would land.

/** An event whose occurrence IS the whole fact; `occurredAt` on the envelope says when. */
export type NoData = Record<string, never>

export interface SessionStartedData {
  origin: SessionOrigin
  title?: string
  subtaskId?: string
  /** `normalizeGitRemote()`; `''` is the "no linked repository" bucket, a real value. */
  repoKey?: string
  projectPath?: string
}

export interface RunStartedData {
  harness: RunHarness
  harnessVersion?: string
  /** The harness's OWN thread id — present only when the link is exact. */
  conversationId?: string
  conversationLink: ConversationLink
  cwd?: string
  /** The tmux-backed registry row, when agentop hosts the run. */
  managedSessionId?: string
}

export interface RunEndedData {
  /** A run that has ended cannot still be `running`. `lost` is a real end state, never a guess. */
  status: Exclude<RunStatus, 'running'>
}

export interface AgentStartedData {
  kind: AgentKind
  /** Absent for the run's main agent. */
  parentAgentId?: Id
  agentType?: string
  description?: string
  model?: string
}

export interface AgentEndedData {
  /** `unmeasured` is a status, never zeros: the figures could not be read, not "none were spent". */
  status: Exclude<AgentStatus, 'running'>
}

export interface ModelInvokedData {
  /** The correlation key across layers; absent where the source does not expose one. */
  providerRequestId?: string
  provider: ProviderId
  model: string
  deployment?: string
}

export interface ModelStartedData {
  providerRequestId?: string
  model: string
}

export interface ModelDeltaData {
  providerRequestId?: string
  /** Output tokens streamed so far, when the source states it. A running figure, never summed. */
  outputTokensSoFar?: number
}

/**
 * One billed response, completed — master spec §14.2, EXACTLY. The whole cost model rests on it.
 *
 * Normalisation rules, applied on the way IN (per provider), never by a reader:
 * - `usage` carries ALL FOUR counters. `input + output` alone measured 0,34 % of real volume.
 * - `usage.input` EXCLUDES the cache counters. Anthropic already reports it that way; OpenAI, Google
 *   and OpenRouter include the cached portion in their prompt count and the client subtracts it —
 *   otherwise `input + cacheRead` double-counts on three providers of four.
 * - A SUBSET is never inferred into a total: a source reporting three counters reports three, and
 *   the projection says the figure is partial.
 * - `reasoning` is never a bare number: a reader may add it on top of output only when `billing` is
 *   `additive` (Google's `thoughtsTokenCount`); `included-in-output` is already counted and
 *   `unknown` is never summed.
 * - `contextTokens` is a GAUGE (the context size at this call), never summed.
 * - `contextWindow` and `costUSD` appear only when the SOURCE states them. Otherwise the projection
 *   prices through `calcCost` and marks the result as the table's.
 */
export interface ModelCompletedData {
  providerRequestId?: string
  provider: ProviderId
  model: string
  deployment?: string
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Anthropic reports cache writes per TTL (`ephemeral_5m` / `ephemeral_1h`). */
  cacheWriteByTtl?: Record<string, number>
  reasoning?: { tokens: number; billing: ReasoningBilling }
  contextTokens?: number
  contextWindow?: number
  costUSD?: number
  costSource?: 'provider' | 'harness'
  latencyMs?: number
  status: 'completed' | 'failed'
}

export interface ModelFailedData {
  providerRequestId?: string
  provider: ProviderId
  model: string
  deployment?: string
  status: Exclude<ModelInvocationStatus, 'completed'>
  errorClass?: string
  latencyMs?: number
}

/** Every `tool.*` / `mcp.*` event names the execution it belongs to. */
interface ToolRef {
  toolExecutionId: Id
}

export interface ToolRequestedData extends ToolRef {
  /** The harness's own tool name. */
  name: string
  /** `canonicalTool()` — the shared vocabulary every chart and filter is written against. */
  canonicalName: string
  kind: ToolKind
  /** Only when the harness names the MCP server itself. */
  mcpServer?: string
  /** `commandSummary()` — never a raw first-line truncation. */
  summary?: string
}

export interface ToolApprovedData extends ToolRef {
  /** Who granted it: automatically, a person, or a policy. A record of a decision already made. */
  by: Exclude<ToolApproval, 'denied'>
}

export interface ToolDeniedData extends ToolRef {
  by: 'user' | 'policy'
}

export interface ToolProgressData extends ToolRef {
  summary?: string
}

export interface ToolCompletedData extends ToolRef {
  filesTouched?: string[]
  linesAdded?: number
  linesRemoved?: number
  durationMs?: number
}

export interface ToolFailedData extends ToolRef {
  /** `denied` has its own event; a failure is an error or a cancellation. */
  status: Extract<ToolStatus, 'failed' | 'cancelled' | 'unknown'>
  errorClass?: string
  exitCode?: number
}

export interface McpRequestedData extends ToolRef {
  server: string
  tool: string
}

export interface McpCompletedData extends ToolRef {
  server: string
  tool: string
  status: Extract<ToolStatus, 'completed' | 'failed' | 'cancelled'>
}

export interface BrowserSessionStartedData {
  browserSessionId: Id
  implementation: BrowserImplementation
}

export interface BrowserTabCreatedData {
  browserSessionId: Id
  tabId: Id
  /** The HOST only — a full URL can carry tokens in its query. */
  urlHost?: string
}

export interface BrowserTabData {
  tabId: Id
}

export interface BrowserNavigationData {
  tabId: Id
  urlHost?: string
}

/**
 * One thing that happened in a tab. `kind` repeats the event type's own suffix on purpose: it is
 * the `BrowserAction` entity's field, so a projection builds the entity without parsing the type.
 */
export interface BrowserEventData<K extends BrowserActionKind> {
  tabId: Id
  browserActionId?: Id
  kind: K
  detail?: string
  /** For a screenshot or a download: the evidence it produced, by reference, never bytes. */
  artifactId?: Id
}

export interface ContextCompactedData {
  /** Tokens the compaction removed from the context, when the harness records it. */
  droppedTokens?: number
  durationMs?: number
  trigger?: 'auto' | 'manual'
}

export interface ContextWindowObservedData {
  /** A GAUGE — the context size at this moment, never summed. */
  contextTokens: number
  /** Only when the source states it; never looked up from a model id here. */
  contextWindow?: number
  model?: string
}

export interface PolicyRequestedData {
  /** The policy that was consulted. */
  policy: string
  toolExecutionId?: Id
}

export interface PolicyDecidedData {
  policy: string
  toolExecutionId?: Id
  decidedBy: 'user' | 'policy'
}

export interface AlmTaskCreatedData {
  title: string
  subtaskId?: string
}

export interface AlmTaskUpdatedData {
  /** The NAMES of the task fields that changed — facts about the edit, not its contents. */
  fields: string[]
  subtaskId?: string
}

export interface AlmEvidenceAttachedData {
  artifactId: Id
  kind: ArtifactKind
}

export interface ProcessStartedData {
  processId: Id
  /** The tool call that spawned it — which has long since ended; the process outlives it. */
  startedByToolExecutionId: Id
  kind: SideProcessKind
  /** The invocation, SUMMARISED — never raw, since a raw one can carry secrets. */
  summary: string
  cwd: string
  pid?: number
  ports?: number[]
  url?: string
}

export interface ProcessEndedData {
  processId: Id
  /** `lost` is a real end state: the runtime restarted and cannot say whether it lives. */
  endedBy: SideProcessEndedBy
  exitCode?: number
}

/**
 * One data shape per event type. Its keys are checked against `EVENT_TYPES` in BOTH directions
 * below, so a type added without a shape — or a shape for a type that does not exist — fails the
 * build rather than reaching the journal with a payload nobody specified.
 */
export interface EventData {
  'session.started': SessionStartedData
  'session.ended': NoData
  'run.started': RunStartedData
  'run.ended': RunEndedData
  'agent.started': AgentStartedData
  'agent.ended': AgentEndedData
  'model.invoked': ModelInvokedData
  'model.completed': ModelCompletedData
  'model.failed': ModelFailedData
  'tool.requested': ToolRequestedData
  'tool.completed': ToolCompletedData
  'tool.failed': ToolFailedData
  'model.started': ModelStartedData
  'model.delta': ModelDeltaData
  'tool.approved': ToolApprovedData
  'tool.denied': ToolDeniedData
  'tool.progress': ToolProgressData
  'mcp.requested': McpRequestedData
  'mcp.completed': McpCompletedData
  'browser.session.started': BrowserSessionStartedData
  'browser.tab.created': BrowserTabCreatedData
  'browser.tab.focused': BrowserTabData
  'browser.navigation': BrowserNavigationData
  'browser.click': BrowserEventData<'click'>
  'browser.input': BrowserEventData<'input'>
  'browser.scroll': BrowserEventData<'scroll'>
  'browser.screenshot': BrowserEventData<'screenshot'>
  'browser.download': BrowserEventData<'download'>
  'browser.tab.closed': BrowserTabData
  'context.compacted': ContextCompactedData
  'context.window.observed': ContextWindowObservedData
  'policy.requested': PolicyRequestedData
  'policy.approved': PolicyDecidedData
  'policy.denied': PolicyDecidedData
  'alm.task.created': AlmTaskCreatedData
  'alm.task.updated': AlmTaskUpdatedData
  'alm.task.completed': NoData
  'alm.evidence.attached': AlmEvidenceAttachedData
  'process.started': ProcessStartedData
  'process.ended': ProcessEndedData
}

// Compile-time totality. Each alias fails to type-check (`true` is not assignable to `never`) if the
// two key sets drift apart; the aliases are unexported and cost nothing at runtime.
type _Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
type _EventDataIsTotal = _Equal<keyof EventData, EventType>
const _eventDataIsTotal: _EventDataIsTotal = true
type _RequiredIsSubset = RequiredEventType extends EventType ? true : never
const _requiredIsSubset: _RequiredIsSubset = true
void _eventDataIsTotal
void _requiredIsSubset

// ── The envelope ────────────────────────────────────────────────────────────────────────────────

export interface EventSource {
  kind: SourceKind
  /** 'claude' | 'anthropic' | 'agentistics' | … */
  id: string
  /** The harness / adapter / gateway version that produced it, when known. */
  version?: string
}

export interface EventProvenance {
  /** HOW it reached us. Separate from `confidence` — see the header, rule 3. */
  mode: ProvenanceMode
  /** HOW CERTAIN it is. */
  confidence: Confidence
  /** REQUIRED — the re-projection lever. The journal rejects an event without it. */
  adapterVersion: string
  /** What can be re-read: `file:offset`, a db rowid, a hook id. */
  sourceRef?: string
}

/** One canonical event — master spec §14. */
export interface AgentisticsEvent<T extends EventType = EventType> {
  /** Deterministic, derived from the source (see `deriveEventId`) — never minted at ingest. */
  eventId: string
  /** `CANONICAL_EVENT_SCHEMA` at the time it was written. */
  schema: number
  type: T
  /** When it HAPPENED, per the source's own clock. Ordering within a run uses this. */
  occurredAt: string
  /** When WE learned it. Never used for ordering within a run. */
  recordedAt: string

  sessionId?: Id
  runId?: Id
  agentId?: Id
  taskId?: string

  source: EventSource
  provenance: EventProvenance

  data: EventData[T]
}

/**
 * The distributive union of every concrete event. `AgentisticsEvent` with its default parameter
 * pairs ANY type with ANY data; this one keeps each type with its own shape, so a
 * `switch (e.type)` narrows `e.data`.
 */
export type AnyAgentisticsEvent = { [K in EventType]: AgentisticsEvent<K> }[EventType]
