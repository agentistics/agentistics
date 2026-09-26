/**
 * canonical/entities.ts — PURE types. The canonical domain model of the agentistics runtime.
 *
 * The contract is master spec §13 (docs/superpowers/specs/2026-09-19-agentistics-runtime-master.md,
 * §13.1–§13.4) as settled by the owner decisions of 2026-09-25 (D1, D17). Every field below carries
 * the name, optionality and literal union the spec gives it; where the spec contradicts itself the
 * later, corrected section wins and the resolution is stated at the field.
 *
 * WHY a model at all: today the product's unit is `SessionMeta`, which is a PROJECTION keyed on
 * `(harness, conversationId)`. It cannot say "these two conversations are one piece of work", "this
 * reopen is the same conversation again", "this subagent ran haiku under an opus parent" or "this dev
 * server is still up because of that tool call an hour ago" — each of those has been reconstructed by
 * hand somewhere (`collapseSupersededSessions`, `subagent-join.ts`, `usage-dedupe.ts`). The entities
 * here give each of those facts a home, so a projection derives it instead of guessing it.
 *
 * Hierarchy (§13.1):
 *
 *   Task 1─* Session 1─* Run 1─* Agent ─┬─* Agent (subagent, recursive)
 *                                       ├─* ModelInvocation
 *                                       ├─* ToolExecution ─* Artifact
 *                                       └─* BrowserSession 1─* BrowserTab 1─* BrowserAction
 *   Run 1─* SideProcess  (owned by the run, OUTLIVES the tool execution that spawned it)
 *
 * Entities that already exist keep their identity and are REFERENCED by id, never redefined here:
 * `Task`, `Subtask`, `Attempt` (the ALM), `ManagedSession` (the registry row), `SessionMeta` (the
 * legacy projection), `Provider`/`Model` (pricing), `Repository` (the normalised remote) and
 * `Project` (a directory). A second definition of any of them would be a second answer.
 *
 * Status (A1.1): this module is a CONTRACT with no consumer yet. Nothing reads or writes these
 * shapes; they exist so the journal, the event model (`./event`) and the projections are written
 * against one vocabulary. It deliberately does not define `Confidence` — `./event` owns it (D17), and
 * this file must never import from there, so the dependency runs one way.
 *
 * Timestamps are ISO-8601 strings, the wire shape everywhere else in core.
 */
import type { ProviderId } from '../providers'
import type { TokenBreakdown } from '../tokens'
import type { HarnessId } from '../types'
import type { StopReason } from '../provider/stop-reason'

// ── Identity ─────────────────────────────────────────────────────────────────────────────────────

/**
 * An opaque identifier, MINTED BY THE WRITER with a type prefix (the ALM's `mint(prefix)`
 * convention, §13.3):
 *
 *   ses_ Session · run_ Run · agt_ Agent · inv_ ModelInvocation · tex_ ToolExecution
 *   bro_ BrowserSession · tab_ BrowserTab · bac_ BrowserAction · art_ Artifact · prc_ SideProcess
 *
 * Opaque means a reader never parses it: the prefix is for a human reading a log, not a
 * discriminator. Fields that name an id OUTSIDE this model (a harness conversation, a task, a
 * registry row) are plain `string`, because their format belongs to somebody else.
 */
export type Id = string

/**
 * The harness a Run executed under: every adapter-backed harness, plus the runtime's own native
 * loop. Kept as a widening here rather than an edit to `HarnessId`, because `HarnessId` is a
 * `Record` key in `HARNESS_CAPABILITIES` / `HARNESS_SORT` and adding a member there is a product
 * decision about every surface, not a side effect of a type.
 */
export type RunHarness = HarnessId | 'agentistics'

// ── Session ──────────────────────────────────────────────────────────────────────────────────────

/** How the Session came to exist: read off a harness's files, run natively, or imported. */
export const SESSION_ORIGINS = ['adapter', 'native', 'imported'] as const
export type SessionOrigin = (typeof SESSION_ORIGINS)[number]

/**
 * The RUNTIME's unit of work (D1). It may span harnesses — that is the reason it is not the
 * conversation. Legacy data projects one Session to one Run, so nothing on screen changes until
 * somebody groups two runs.
 */
export interface Session {
  id: Id
  createdAt: string
  title?: string
  /** ALM link, optional. References `Task.id`; the task is not redefined here. */
  taskId?: string
  subtaskId?: string
  /**
   * `normalizeGitRemote()` output. `''` is the "no linked repository" BUCKET, a real value — never
   * read it as absent. Absent means nobody resolved it.
   */
  repoKey?: string
  projectPath?: string
  origin: SessionOrigin
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────────

export const RUN_STATUSES = ['running', 'completed', 'failed', 'abandoned', 'lost'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/**
 * How exactly a Run is tied to a harness conversation:
 * - `assigned` — the id was handed to the harness at spawn, or the harness itself stated it
 *   (`--session-id`, agy's process log). Exact.
 * - `observed` — read off the harness's files by a replay adapter. What every legacy row is (§13.2).
 * - `none` — there is no conversation to link (a gemini tmux row, an unlinkable agy process).
 */
export const CONVERSATION_LINKS = ['assigned', 'observed', 'none'] as const
export type ConversationLink = (typeof CONVERSATION_LINKS)[number]

/** ONE execution segment of ONE harness inside a Session. */
export interface Run {
  id: Id
  sessionId: Id
  /**
   * D1: a harness conversation is a RUN inside a Session, so the harness lives here and not on the
   * Session — a Session holding Runs of two harnesses is the case the model exists for.
   */
  harness: RunHarness
  harnessVersion?: string
  /**
   * The harness's OWN thread id, only when one exists and is EXACT. A conversation reopened N
   * times is N Runs sharing ONE `conversationId` — the distinction `collapseSupersededSessions`
   * makes by hand today.
   */
  conversationId?: string
  /**
   * `'none'` means every projection reads this Run as UNMEASURED, never as zero (§13.1). It has no
   * `(harness, conversationId)` key, so it projects into NO `SessionMeta` row, and a surface says so
   * rather than drawing a confident 0.
   */
  conversationLink?: ConversationLink
  startedAt: string
  endedAt?: string
  status: RunStatus
  cwd?: string
  /** The tmux-backed registry row (`ManagedSession`), when agentop hosts it. Referenced, not owned. */
  managedSessionId?: string
}

// ── Agent ────────────────────────────────────────────────────────────────────────────────────────

export const AGENT_KINDS = ['main', 'subagent', 'fork'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

/**
 * `unmeasured` is an agent that ran but whose numbers are gone (its transcript was cleaned up, the
 * call was interrupted). Read it BEFORE any figure: zeros under it are not measurements — the rule
 * `AgentInvocation.unmeasured` already carries.
 */
export const AGENT_STATUSES = ['running', 'completed', 'failed', 'unmeasured'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

/** The run's main agent and every subagent, as ONE type. */
export interface Agent {
  id: Id
  runId: Id
  /** Absent = the run's main agent. A nested subagent points at the agent that spawned it. */
  parentAgentId?: Id
  kind: AgentKind
  /** `'Explore'`, `'general-purpose'`, an agy subagent, … */
  agentType?: string
  description?: string
  /**
   * The agent's OWN model. A subagent commonly runs haiku under an opus parent; pricing it at the
   * parent's model is the defect the old agent reader had.
   */
  model?: string
  startedAt: string
  endedAt?: string
  status: AgentStatus
}

// ── ModelInvocation ──────────────────────────────────────────────────────────────────────────────

export const MODEL_INVOCATION_STATUSES = ['completed', 'failed', 'cancelled'] as const
export type ModelInvocationStatus = (typeof MODEL_INVOCATION_STATUSES)[number]

/**
 * Who computed `costUSD`: the provider's bill, the harness's own figure, or our pricing table
 * (`calcCost` × `MODEL_PRICING`). Only `provider` and `harness` are measurements; `table` is an
 * estimate and must be labelled as one.
 */
export const COST_SOURCES = ['provider', 'harness', 'table'] as const
export type CostSource = (typeof COST_SOURCES)[number]

/**
 * How a provider bills its reasoning tokens — the discriminator §14.2 (corrected 2026-09-20)
 * requires:
 * - `included-in-output` — OpenAI / OpenRouter (`reasoning_tokens` is inside output), agy's `1.4.9`
 *   inside `1.4.3`. Adding it to output counts it twice.
 * - `additive` — Google's `thoughtsTokenCount`, a separate top-level counter billed on top.
 * - `unknown` — the source did not say. NEVER summed.
 * Anthropic exposes no reasoning counter at all, so its invocations carry no `reasoning`.
 */
export const REASONING_BILLINGS = ['included-in-output', 'additive', 'unknown'] as const
export type ReasoningBilling = (typeof REASONING_BILLINGS)[number]

/**
 * Why the model stopped (D20, 2026-09-25) — BOTH the normalised kind and the provider's own value.
 * The normalised half is B1.1's `StopReason` (`provider/stop-reason.ts`), reused rather than
 * restated: a second stop vocabulary would be a second answer to one question.
 */
export interface ModelStopReason {
  normalised: StopReason
  /** The provider's value exactly as sent. Absent when the source did not hand it over — never guessed. */
  verbatim?: string
}

/**
 * One server-side sub-call the provider reported inside a billed response (D20 — Anthropic's
 * `usage.iterations[]`; master §22.1.1 condition #2). Only what can be named is typed: whether its
 * tokens are already inside the four counters is UNMEASURED (B1 spec O-3), so none are extracted
 * here — the raw capture keeps them — and a projection must call the invocation's price PARTIAL.
 */
export interface ModelIteration {
  kind: string
  model?: string
}

export interface ModelIterations {
  /** The only relation to the top-level counters anyone can state today (O-3). */
  relation: 'unmeasured'
  items: ModelIteration[]
}

/**
 * ONE billed response. The unit of cost.
 *
 * D20 (2026-09-25) added `attemptId`/`attempt`, `modelRequested`/`modelServed`, `stopReason` and
 * `iterations`, and made `agentId` OPTIONAL (B1 spec O-6: a bare provider call has no agent, and
 * inventing one would put an agent on record that nothing started). Every D20 field is optional
 * and additive: a source that cannot produce one leaves it ABSENT, never zero.
 */
export interface ModelInvocation {
  id: Id
  /** Absent for an invocation no agent made (a bare runtime call) — O-6. */
  agentId?: Id
  /**
   * The grouping key SHARED by every attempt of one invocation (the caller-minted `inv_…`), with
   * `attempt` telling them apart. The runtime owns the retry (master §22.1.1), so each retry is its
   * own attempt; the billed response is still ONE invocation, keyed on the provider's response id.
   */
  attemptId?: Id
  /** 1-based. */
  attempt?: number
  /** The id the caller ASKED for. May differ from `modelServed` under aliases and routing. */
  modelRequested?: string
  /** The id the provider SAYS answered. Only this one prices the call. */
  modelServed?: string
  stopReason?: ModelStopReason
  iterations?: ModelIterations
  /**
   * The correlation key across layers (§13.3): Anthropic `message.id` / `request-id`, OpenAI's id,
   * … One id = one billing event, last wins — the `usage-dedupe.ts` rule. When the source does not
   * expose it (every file-based adapter today) it is absent, and correlation falls back to
   * `(agentId, startedAt, model)`, which is an INFERENCE and must be marked as one.
   */
  providerRequestId?: string
  provider: ProviderId
  /** The bare model id (no `provider/` prefix), so the shared pricing table can key on it. */
  model: string
  /** vertex / bedrock / azure / openrouter route, when stated. */
  deployment?: string
  startedAt: string
  completedAt?: string
  latencyMs?: number
  /**
   * The four counters, ALWAYS all four (`tokens.ts`): `input + output` alone was measured at 0,34 %
   * of real volume. `input` EXCLUDES the cache counters, normalised per provider on the way in.
   */
  usage: TokenBreakdown
  /**
   * SPEC CONFLICT, resolved: §13 lists `reasoningTokens?: number`; §14.2's correction forbids a
   * bare number, because one implementer would add it on top of output and another would not, and
   * both would look right. So it carries its billing, and only `additive` may ever be summed.
   */
  reasoning?: { tokens: number; billing: ReasoningBilling }
  /** ONLY when somebody else measured it; otherwise the projection prices it and says `table`. */
  costUSD?: number
  costSource?: CostSource
  status: ModelInvocationStatus
  errorClass?: string
}

// ── ToolExecution ────────────────────────────────────────────────────────────────────────────────

export const TOOL_KINDS = ['shell', 'file', 'search', 'mcp', 'browser', 'agent', 'other'] as const
export type ToolKind = (typeof TOOL_KINDS)[number]

export const TOOL_STATUSES = ['completed', 'failed', 'denied', 'cancelled', 'unknown'] as const
export type ToolStatus = (typeof TOOL_STATUSES)[number]

export const TOOL_APPROVALS = ['auto', 'user', 'policy', 'denied'] as const
export type ToolApproval = (typeof TOOL_APPROVALS)[number]

export interface ToolExecution {
  id: Id
  agentId: Id
  /** The harness's own name, kept verbatim. */
  name: string
  /** `canonicalTool()` — the shared vocabulary. A MAPPING, never a filter: unmapped names pass through. */
  canonicalName: string
  kind: ToolKind
  /** Only when the harness names one (`mcp__<server>__<tool>`); never guessed from a tool name. */
  mcpServer?: string
  requestedAt: string
  startedAt?: string
  endedAt?: string
  status: ToolStatus
  approval?: ToolApproval
  /** `commandSummary()` — never a raw first-line truncation (which reads `cd /home/…` and says nothing). */
  summary?: string
  filesTouched?: string[]
  linesAdded?: number
  linesRemoved?: number
}

// ── Browser ──────────────────────────────────────────────────────────────────────────────────────

export const BROWSER_IMPLEMENTATIONS = ['playwright', 'extension', 'remote'] as const
export type BrowserImplementation = (typeof BROWSER_IMPLEMENTATIONS)[number]

export const BROWSER_ACTION_KINDS = [
  'navigate', 'click', 'input', 'scroll', 'screenshot', 'download',
] as const
export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number]

export interface BrowserSession {
  id: Id
  runId: Id
  implementation: BrowserImplementation
  startedAt: string
  endedAt?: string
}

export interface BrowserTab {
  id: Id
  browserSessionId: Id
  openedAt: string
  closedAt?: string
  /** The HOST only — a full URL can carry tokens in its query string. */
  lastUrlHost?: string
}

export interface BrowserAction {
  id: Id
  tabId: Id
  kind: BrowserActionKind
  at: string
  detail?: string
}

// ── Artifact ─────────────────────────────────────────────────────────────────────────────────────

export const ARTIFACT_KINDS = ['file', 'screenshot', 'diff', 'log', 'report'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** Evidence: a file, a screenshot, a diff, a test report. */
export interface Artifact {
  id: Id
  runId: Id
  kind: ArtifactKind
  /** A storage id, NEVER inline bytes — an entity that can carry a screenshot is one nobody can list. */
  ref: string
  bytes?: number
  sha256?: string
  createdAt: string
}

// ── SideProcess (§13.4) ──────────────────────────────────────────────────────────────────────────

export const SIDE_PROCESS_KINDS = ['server', 'watcher', 'task', 'unknown'] as const
export type SideProcessKind = (typeof SIDE_PROCESS_KINDS)[number]

/**
 * How a SideProcess ended. `lost` is a REAL end state, not a missing value: the runtime restarted
 * and the process may or may not still be alive — claiming either would be inventing it, the same
 * discipline `ManagedSession`'s `lost` carries after a reboot.
 */
export const SIDE_PROCESS_ENDED_BY = ['exit', 'killed-by-runtime', 'killed-externally', 'lost'] as const
export type SideProcessEndedBy = (typeof SIDE_PROCESS_ENDED_BY)[number]

/**
 * A process that OUTLIVES the tool call that started it — a `bun run dev` spawned inside a
 * ToolExecution that ended an hour ago (issue #342). It is OWNED BY A RUN, not by the tool
 * execution; that asymmetry is the whole point. It is ended by a person's act or by the run's end,
 * never by a timer (the `SHELL_CAP` reasoning: a TTL kills work at an hour nobody was watching).
 * Its lifecycle is events (`process.started` / `process.ended`), so "what is still running because
 * of this task" is a projection rather than a `ps` at render time.
 */
export interface SideProcess {
  id: Id
  /** Who started it — the owner. */
  runId: Id
  /** The call that spawned it, which has long since ended. */
  startedByToolExecutionId: Id
  kind: SideProcessKind
  /**
   * SUMMARISED (`commandSummary()`), NEVER the raw command line: argv routinely carries tokens and
   * passwords, and this record outlives the process and travels with the run. The name is the
   * spec's; the content is a summary.
   */
  command: string
  cwd: string
  pid?: number
  /** What it bound, when observable. */
  ports?: number[]
  startedAt: string
  endedAt?: string
  endedBy?: SideProcessEndedBy
  /** The preview address, when one can be established — never guessed from a port. */
  url?: string
}
