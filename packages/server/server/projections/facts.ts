/**
 * projections/facts.ts — the CONTRACT between the materialised projections (A4.1) and the query API
 * (A4.3). Types only; no behaviour lives here.
 *
 * A4.1 produces these rows (from `costByDimension`, `runMetrics`, `toolMetrics` and `sessionMeta`) and
 * persists them; A4.3 filters, groups and pages them. Neither side re-derives the other's rules: the
 * projections decide WHAT a figure is (and how certain), the query decides only WHICH rows are summed.
 *
 * Invariants every producer must hold:
 * - `null` / an absent key means "not measured", never zero (D21, and `HARNESS_CAPABILITIES`).
 * - `confidence` is the WEAKEST of the events that produced the row (D17): exact > estimated > inferred.
 * - `day` is the UTC day (`occurredAt.slice(0, 10)`) — the billing/tag day rule.
 */
import type { Confidence, ProviderId, RunHarness, TokenBreakdown } from '@agentistics/core'

/** One (harness × provider × model × repo × project × day × session × run) cell of spend. */
export interface CostFact {
  day: string
  /** `RunHarness`: every adapter harness plus the native runtime (`'agentistics'`). */
  harness: RunHarness
  /** `null` when no event named a provider. */
  provider: ProviderId | null
  /** `null` when no event named a model. */
  model: string | null
  /** Normalized git remote (`normalizeGitRemote`); `''` = no linked repository (a real bucket). */
  repo: string
  /** `project_path`; `''` = unknown. */
  project: string
  sessionId: string
  /** ADDED (A4.1, optional): the harness's own conversation id, when `run.started` named it exactly. */
  conversationId?: string
  /** `null` for a session whose events carry no run. */
  runId: string | null
  /** ADDED (A4.3 request): the agent whose responses these are; `null` when no event named one. */
  agentId: string | null
  /** ADDED (A4.3 request): `true` when the agent is a subagent (not the run's main agent). */
  subagent: boolean
  /** `null` when the session is filed on no task. */
  taskId: string | null
  /** Only one of these two per counter: a counter absent from EVERY response is absent here. */
  tokens: Partial<TokenBreakdown>
  /** Counters that at least one contributing response did NOT report — the sum is partial. */
  partialCounters: (keyof TokenBreakdown)[]
  /** `null` = could not be priced (no rate / subscription with no marginal price). */
  costUSD: number | null
  /** Where the money came from; a mix is `'mixed'`. `null` when `costUSD` is null. */
  costSource: 'provider' | 'harness' | 'table' | 'mixed' | null
  /** Billed responses folded into this cell. */
  responses: number
  confidence: Confidence
}

/** Per-run activity figures that are not money: sessions/runs/messages/active time/tools. */
export interface RunFact {
  runId: string
  sessionId: string
  /** ADDED (A4.1, optional): the harness's own conversation id, when `run.started` named it exactly. */
  conversationId?: string
  /** `RunHarness`: every adapter harness plus the native runtime (`'agentistics'`). */
  harness: RunHarness
  /** UTC day the run STARTED — the unit a run count is filed under. */
  day: string
  provider: ProviderId | null
  model: string | null
  repo: string
  project: string
  taskId: string | null
  /** Person's turns; `null` when the adapter version records no turns. */
  messages: number | null
  /** `activeMinutesOf`; `null` when not projectable (walk open, or no turn closes recorded). */
  activeMinutes: number | null
  /** Tool executions by CANONICAL name. */
  tools: Record<string, {
    calls: number
    errors: number
    durationMs: number | null
    /** ADDED (A4.1, optional): how many of `calls` `durationMs` covers — fewer means the sum is partial. */
    durationCalls?: number
    /**
     * ADDED (A4.7 decision 2, optional): the part of the figures above made by SUBAGENTS, by the cost
     * facts' main-agent rule. Absent means none. The main agent's share is the total minus this.
     */
    subagent?: { calls: number; errors: number; durationMs: number | null; durationCalls?: number }
  }>
  /** Agent invocations whose transcript was missing — excluded from totals, counted apart. */
  unmeasuredAgents: number
  confidence: Confidence
}

/** What a reader of the store can ask. A4.1 implements it; A4.3 consumes it (and fakes it in tests). */
export interface ProjectionReader {
  /** Streams every CostFact whose `day` is within [from, to] (inclusive, either bound optional). */
  costFacts(range: { from?: string; to?: string }): AsyncIterable<CostFact>
  runFacts(range: { from?: string; to?: string }): AsyncIterable<RunFact>
  /** How fresh the store is: the journal rowid the projections have folded up to, and per-projection versions. */
  status(): Promise<{ cursor: number; journalHead: number; versions: Record<string, number>; rebuilding: boolean }>
}
