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
  WorkArtifactKind,
  BrowserActionKind,
  BrowserImplementation,
  ConversationLink,
  Id,
  ModelInvocationStatus,
  ModelIterations,
  ModelStopReason,
  ModelUsageCounters,
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
  // the native context manager's execution record (B4-CTX §3)
  'tool.executed',
  // MCP
  'mcp.requested', 'mcp.completed',
  // browser
  'browser.session.started', 'browser.tab.created', 'browser.tab.focused', 'browser.navigation',
  'browser.click', 'browser.input', 'browser.scroll', 'browser.screenshot', 'browser.download',
  'browser.tab.closed',
  // context
  'context.compacted', 'context.window.observed',
  // the native context manager reopening a recorded execution (B4-CTX §5, §9)
  'context.recalled',
  // policy
  'policy.requested', 'policy.approved', 'policy.denied',
  // attention (LIVE.1): a person is asked something and the session is blocked on it
  'attention.raised', 'attention.cleared',
  // ALM
  'alm.task.created', 'alm.task.updated', 'alm.task.completed', 'alm.evidence.attached',
  // side processes (§13.4)
  'process.started', 'process.ended',
  // human turns (D22) and their close (D25)
  'turn.started', 'turn.ended',
  // H24: a native session switched model (same provider) between runs
  'session.model.changed',
  // B6.6: memory — a fact noted (by the person, the model, or derived), and a fact forgotten
  'memory.noted', 'memory.forgotten',
  // ART.2: the artifact store's metadata (the content is a blob, never in an event)
  'artifact.created', 'artifact.versioned', 'artifact.blocked', 'artifact.pinned', 'artifact.unpinned', 'artifact.expired',
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
  /** H21: a native session forked from another — the source and the last message copied. */
  forkedFrom?: { sessionId: string; seq: number }
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

/**
 * The attempt facts D20 (2026-09-25) added to every `model.*` event that has a terminal outcome or
 * opens one. ALL OPTIONAL and additive: an A1.1 event without them still type-checks, and a source
 * that cannot state one leaves it ABSENT — never zero. See `ModelInvocation` for each field's rule.
 */
export interface ModelAttemptFacts {
  /** The grouping key shared by every attempt of one invocation (`inv_…`); `attempt` tells them apart. */
  attemptId?: Id
  /** 1-based. */
  attempt?: number
  /** What the caller asked for. `model` on the event stays what the event is ABOUT. */
  modelRequested?: string
  /**
   * INV.1 — the deterministic per-ATTEMPT id the runtime minted for this call:
   * `base32(sha256("agentistics/inv/v1"|sessionId|turnSeq|stepSeq|attempt))[:26]`, also sent to the
   * provider as `Agentistics-Invocation-Id`. The same turn/step/attempt after a resume gives the SAME
   * id; a retry gives a new one. Never secret. Not `attemptId` (that groups attempts and is random).
   */
  invocationId?: string
}

export interface ModelInvokedData extends ModelAttemptFacts {
  /** The correlation key across layers; absent where the source does not expose one. */
  providerRequestId?: string
  provider: ProviderId
  model: string
  deployment?: string
}

/**
 * The provider accepted the attempt and began answering (a streamed response's first event).
 * B2.1 (2026-09-27) added the D20 attempt facts and `provider`, all optional and additive, so a
 * `model.started` joins the `model.invoked` and the terminal event of the same attempt.
 */
export interface ModelStartedData extends ModelAttemptFacts {
  providerRequestId?: string
  provider?: ProviderId
  model: string
}

export interface ModelDeltaData {
  providerRequestId?: string
  /** Output tokens streamed so far, when the source states it. A running figure, never summed. */
  outputTokensSoFar?: number
}

/**
 * One billed response, completed — master spec §14.2, plus the optional D20 fields (2026-09-25).
 * The whole cost model rests on it.
 *
 * Normalisation rules, applied on the way IN (per provider), never by a reader:
 * - `usage` carries every counter the SOURCE reported, of the four (`input + output` alone measured
 *   0,34 % of real volume, so a source that reports all four is carried whole). D21 (2026-09-26): a
 *   counter the source did not report is ABSENT — never a 0, never a 0 marked `inferred`. The event's
 *   `confidence` speaks for the counters that ARE present.
 * - `usage.input` EXCLUDES the cache counters. Anthropic already reports it that way; OpenAI, Google
 *   and OpenRouter include the cached portion in their prompt count and the client subtracts it —
 *   otherwise `input + cacheRead` double-counts on three providers of four.
 * - A SUBSET is never inferred into a total: a source reporting three counters reports three, and
 *   the projection says the figure is partial (`absentUsageCounters`).
 * - `reasoning` is never a bare number: a reader may add it on top of output only when `billing` is
 *   `additive` (Google's `thoughtsTokenCount`); `included-in-output` is already counted and
 *   `unknown` is never summed.
 * - `contextTokens` is a GAUGE (the context size at this call), never summed.
 * - `contextWindow` and `costUSD` appear only when the SOURCE states them. Otherwise the projection
 *   prices through `calcCost` and marks the result as the table's.
 */
export interface ModelCompletedData extends ModelAttemptFacts {
  providerRequestId?: string
  provider: ProviderId
  model: string
  deployment?: string
  usage: ModelUsageCounters
  /** Anthropic reports cache writes per TTL (`ephemeral_5m` / `ephemeral_1h`). */
  cacheWriteByTtl?: Record<string, number>
  reasoning?: { tokens: number; billing: ReasoningBilling }
  contextTokens?: number
  contextWindow?: number
  costUSD?: number
  costSource?: 'provider' | 'harness'
  latencyMs?: number
  status: 'completed' | 'failed'
  /** INV.1 — the answer was replayed from the host's invocation cache after a resume: no new call, no new spend. */
  replayed?: boolean
  /** D20 — the id the provider says answered; the one that prices the call. */
  modelServed?: string
  /** D20 — normalised (B1.1's `StopReason`) plus the provider's verbatim value. */
  stopReason?: ModelStopReason
  /** D20 — server-side sub-calls the provider reported. Present means the price is PARTIAL (O-3). */
  iterations?: ModelIterations
}

/** The four usage counters by name, in the `TokenBreakdown` order. */
export const USAGE_COUNTERS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const satisfies readonly (keyof ModelUsageCounters)[]

export type UsageCounter = (typeof USAGE_COUNTERS)[number]

/**
 * The counters this response's source did NOT report (D21), in `USAGE_COUNTERS` order. Empty means
 * all four are present and the usage is a whole `TokenBreakdown`. A reader summing responses unions
 * these: a total that saw any absent counter is PARTIAL, never a measured sum.
 */
export function absentUsageCounters(u: ModelUsageCounters): UsageCounter[] {
  return USAGE_COUNTERS.filter(k => u[k] === undefined)
}

export interface ModelFailedData extends ModelAttemptFacts {
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

/**
 * A person is being asked something and the session is blocked on it. NO TEXT: option labels are
 * model-written and D5 forbids storing them for external harnesses — only the shape is recorded.
 */
export interface AttentionRaisedData {
  kind: 'approval' | 'question' | 'select' | 'confirm' | 'unknown'
  /** Only when the screen names a tool the journal already knows. */
  toolExecutionId?: Id
  optionCount?: number
  hasFreeText?: boolean
  /** `screen`: read off a terminal frame. `acp`: stated by the agent itself over ACP (A5.4). */
  via: 'screen' | 'acp'
}

export interface AttentionClearedData {
  how: 'answered-here' | 'answered-elsewhere' | 'session-ended' | 'unknown'
  /** The 1-based option index, only when agentop sent it. An index, never a label. */
  choice?: number
  blockedMs?: number
}

export interface ToolDeniedData extends ToolRef {
  by: 'user' | 'policy'
}

export interface ToolProgressData extends ToolRef {
  summary?: string
}

/**
 * Where a tool's RESULT text lives in the content store: `{sha256, bytes}` of what the model read
 * back. The text itself never enters an event (it is conversation content and can quote a file or a
 * line of output); a reader with access to the store resolves it by hash.
 */
export interface ToolResultRef {
  sha256: string
  bytes: number
}

export interface ToolCompletedData extends ToolRef {
  filesTouched?: string[]
  linesAdded?: number
  linesRemoved?: number
  durationMs?: number
  /** A process's exit status, when the tool ran one (a shell that exited 0 completes). */
  exitCode?: number
  /** The content-store copy of the result (native runtime only). Absent: not stored. */
  result?: ToolResultRef
}

export interface ToolFailedData extends ToolRef {
  /** `denied` has its own event; a failure is an error or a cancellation. */
  status: Extract<ToolStatus, 'failed' | 'cancelled' | 'unknown'>
  errorClass?: string
  exitCode?: number
  durationMs?: number
  /** The content-store copy of the error text the model read (native runtime only). */
  result?: ToolResultRef
}

/**
 * The native context manager's EXECUTION RECORD (context-manager design §3): one per tool call that
 * ran, after it settled. Facts and content-store references only — the model's declared intent, the
 * target and the output are conversation content and stay in the content store / the engine's record.
 */
export interface ToolExecutedData extends ToolRef {
  /** The session-scoped handle the model recalls it by (`#41`); its parts are `#41.1`, `#41.2`, … */
  handle: string
  /** How it entered the window: whole, or a preview + its index line. */
  entry: 'whole' | 'preview'
  bytes: number
  lines: number
  /** ESTIMATED (`ceil(bytes / 4)`), identical on every provider; the provider's own count is on `model.completed`. */
  tokens: number
  /** How many stored parts the output was cut into (line-aligned). */
  parts: number
  /** The whole output in the content store. */
  content: ToolResultRef
  /** The call's input in the content store (design §4.3). */
  input?: ToolResultRef
  /** Known to touch secrets (`.env`, `printenv`, credential paths) — excluded from every exit path (§8.4). */
  sensitive: boolean
}

/**
 * The model reopened a recorded execution (`context.recall`, design §5). `toolExecutionId` is the
 * recall call's own; `handle` is what it asked for. The pattern of a grep and the lines returned
 * are not carried — only how much entered the window and how much was not resent.
 */
export interface ContextRecalledData extends ToolRef {
  /** `#41` or `#41.2`, as asked. */
  handle: string
  mode: 'preview' | 'part' | 'lines' | 'grep' | 'whole'
  /** `already-resident`: nothing resent (it is in the window). `unavailable`: missing or hash mismatch. */
  outcome: 'returned' | 'already-resident' | 'unavailable' | 'unknown'
  /** Parts this answer put in the window. */
  partsReturned: number
  /** Parts not resent because the window already held them (design §5.4). */
  partsAlreadyResident: number
  /** Estimated size of the answer. */
  tokens: number
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

/**
 * H24: a session switched model between runs, on the SAME provider. The runs before it were priced on
 * `from`, the runs after it on `to`: every `model.completed` already names its own model, so cost per
 * model needs nothing else. Facts only.
 */
export interface SessionModelChangedData {
  provider: string
  from: string
  to: string
}

/** B6.6 (§24.6): which memory a fact belongs to — a repository's, or the person's own. */
export type MemoryScope = 'repo' | 'person'
export type MemoryCategory = 'decision' | 'convention' | 'pitfall' | 'preference' | 'other'

/**
 * B6.6: a fact noted. The STATEMENT is not in the event: it lives in the content store by reference,
 * so forgetting can delete it (§24.6 rule 6) while the journal keeps only a hash. A new version of a
 * fact names the one it `supersedes` and shares its `chainId`; the older one is closed, never
 * overwritten (rule 7).
 */
export interface MemoryNotedData {
  /** This version. */
  factId: string
  /** The fact across its versions: the first version's `factId`. */
  chainId: string
  /** The version this one closes. */
  supersedes?: string
  scope: MemoryScope
  /** `scope: 'repo'`: `memoryRepoKey()` — the normalised remote, or `path:<root>` without one. */
  repoKey?: string
  category: MemoryCategory
  statement: { sha256: string; bytes: number }
  /** Who noted it: the person (`/remember`), the model (`memory.note`, approved), or a derivation. */
  origin: 'person' | 'model' | 'derived'
  /** `derived`: the events it was derived from (rule 8: at least two). */
  derivedFrom?: string[]
}

/** B6.6: a fact forgotten — every version of the chain leaves memory, and its statements are deleted. */
export interface MemoryForgottenData { chainId: string }

/** ART.2: an artifact came to exist (its first version follows as `artifact.versioned`). No content. */
export interface ArtifactCreatedData {
  artifactId: string
  kind: WorkArtifactKind
  title: string
  slug: string
  createdBy: 'agent' | 'person'
}

/** ART.2: an immutable version — its blob by sha256, the event that produced it. No content. */
export interface ArtifactVersionedData {
  artifactId: string
  n: number
  sha256: string
  size: number
  mime: string
  basedOn?: number
  sourceEventId: string
  note?: string
}

/** ART.2: a version's remote references were blocked (ART.1's scan) — how many and of what kind, never the URLs. */
export interface ArtifactBlockedData { artifactId: string; n: number; count: number; kinds: string[] }
export interface ArtifactPinnedData { artifactId: string; n: number; reason: string }
export interface ArtifactUnpinnedData { artifactId: string; n: number }
/** ART.2: a version's blob was pruned under the disk budget — it reads back as expired, in words. */
export interface ArtifactExpiredData { artifactId: string; n: number; reason: string }

export interface PolicyRequestedData {
  /** The policy that was consulted. */
  policy: string
  toolExecutionId?: Id
}

export interface PolicyDecidedData {
  policy: string
  toolExecutionId?: Id
  decidedBy: 'user' | 'policy'
  /** A denial's stable code (`policy.denied.outside-workspace`, …) — never the refusal sentence. */
  code?: string
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
 * A PERSON took a turn (decision D22, 2026-09-26). Emitted from the SAME predicate legacy counts
 * with — `isHumanUserEntry` in `jsonl.ts`, which excludes `isMeta` and `isCompactSummary` — so a
 * projection counting these events agrees with `user_message_count` by construction.
 *
 * It carries WHO and nothing else: WHEN is the envelope's timestamp and WHICH LINE is its
 * `sourceRef`. There is no text and no text size (D5). `by` is a closed union of one member today;
 * it is a field rather than implied so a later turn opened by something other than a person is an
 * additive widening, not a new event type.
 */
export interface TurnStartedData {
  by: 'user'
  /**
   * The `timestamp` of the LAST assistant-role transcript line written before this prompt, verbatim
   * (decision D25, 2026-09-26) — the instant legacy's `user_response_times` measures FROM. Not the
   * first line of the last response (`model.completed` carries that one) and not reset between
   * turns: legacy keeps the last assistant time for the life of the walk. ABSENT when no assistant
   * line with a timestamp preceded the prompt — never an invented instant.
   */
  previousAssistantAt?: string
}

/**
 * A person's turn CLOSED (decision D25, 2026-09-26), at the point legacy's active-time rule closes
 * it (`activeTime.ts`, harness contract §1):
 * - `'measured'` — the harness wrote its own duration for the turn (Claude's `system/turn_duration`
 *   line). `durationMs` carries it and wins over anything reconstructed; `occurredAt` is that line's.
 * - `'last-line'` — no measurement arrived before the next prompt (or the end of the transcript);
 *   the turn closes at the LAST timestamped line of any kind, whose time is `occurredAt`.
 *
 * Emitted only for a turn that is OPEN — a stray measurement with no turn to close invents nothing.
 * Metadata only (D5): no text, no size. `durationMs` is ABSENT unless the harness stated one (D21's
 * rule) — never a 0 standing in for "not measured".
 */
export interface TurnEndedData {
  close: 'measured' | 'last-line'
  durationMs?: number
}

/**
 * One data shape per event type. Its keys are checked against `EVENT_TYPES` in BOTH directions
 * below, so a type added without a shape — or a shape for a type that does not exist — fails the
 * build rather than reaching the journal with a payload nobody specified.
 */
export interface EventData {
  'session.started': SessionStartedData
  'session.ended': NoData
  'session.model.changed': SessionModelChangedData
  'memory.noted': MemoryNotedData
  'memory.forgotten': MemoryForgottenData
  'artifact.created': ArtifactCreatedData
  'artifact.versioned': ArtifactVersionedData
  'artifact.blocked': ArtifactBlockedData
  'artifact.pinned': ArtifactPinnedData
  'artifact.unpinned': ArtifactUnpinnedData
  'artifact.expired': ArtifactExpiredData
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
  'tool.executed': ToolExecutedData
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
  'context.recalled': ContextRecalledData
  'policy.requested': PolicyRequestedData
  'policy.approved': PolicyDecidedData
  'policy.denied': PolicyDecidedData
  'attention.raised': AttentionRaisedData
  'attention.cleared': AttentionClearedData
  'alm.task.created': AlmTaskCreatedData
  'alm.task.updated': AlmTaskUpdatedData
  'alm.task.completed': NoData
  'alm.evidence.attached': AlmEvidenceAttachedData
  'process.started': ProcessStartedData
  'process.ended': ProcessEndedData
  'turn.started': TurnStartedData
  'turn.ended': TurnEndedData
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
