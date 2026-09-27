/**
 * projections/agent-metrics.ts — PURE, version 1. Keyed by `runId` (P3 §2): the run's subagent
 * invocations — `SessionAgentMetrics`, now for EVERY harness whose adapter emits `agent.*` events.
 *
 * The rollup itself is `session-meta.ts`'s (which agent is the main one, which subagent a nested one
 * rolls into, each model priced at its own rate, unmeasured invocations excluded from the totals and
 * counted apart): the state embeds a `SessionMetaState` fed ONLY the event types that rollup reads,
 * and this projection reads `meta.agentMetrics` off its finish. Nothing is re-derived.
 *
 * Capability honesty (`HARNESS_CAPABILITIES.agents`): a harness that cannot produce agent metrics gets
 * `agentMetrics: null` and a reason, never an empty rollup that reads as "ran no agents". A harness
 * that CAN produce them and ran none gets a real, empty rollup.
 */
import { HARNESS_CAPABILITIES, type AnyAgentisticsEvent, type Confidence, type Projection, type RunHarness } from '@agentistics/core'
import { adapterHarness, dimensionsOf, emptyDimensionFacts, foldConfidence, foldDimensionFacts, type DimensionFacts } from './kit'
import { sessionMetaProjection, type Caveat, type ProjectedAgentMetrics, type SessionMetaState } from './session-meta'

/** The event types the agent rollup reads (`session-meta.ts` finish, the agent half). */
const AGENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.started', 'agent.started', 'agent.ended', 'model.completed', 'tool.requested',
])

export interface AgentMetricsState {
  sm: SessionMetaState
  dims: DimensionFacts
  conf: Confidence | null
  sessionId?: string
  runId?: string
}

export interface AgentMetricsResult {
  runId: string | null
  sessionId: string | null
  harness: RunHarness | null
  /** `null` when the harness cannot produce agent metrics at all — see `reason`. */
  agentMetrics: ProjectedAgentMetrics | null
  unmeasuredAgents: number
  reason?: string
  caveats: Caveat[]
  /** Weakest of the events folded; `null` when none was. */
  confidence: Confidence | null
}

function foldOne(s: AgentMetricsState, e: AnyAgentisticsEvent): void {
  if (!AGENT_EVENT_TYPES.has(e.type) || s.sm.seen.has(e.eventId)) return
  s.conf = foldConfidence(s.conf, e.provenance.confidence)
  if (e.sessionId && (s.sessionId === undefined || e.sessionId < s.sessionId)) s.sessionId = e.sessionId
  if (e.runId && (s.runId === undefined || e.runId < s.runId)) s.runId = e.runId
  foldDimensionFacts(s.dims, e)
  sessionMetaProjection.fold(s.sm, [e])
}

function finish(s: AgentMetricsState): AgentMetricsResult {
  const sm = sessionMetaProjection.finish(s.sm)
  const harness = dimensionsOf(s.dims).harness
  const caveats = sm.caveats.filter(c => c.field === 'agents' || c.field.startsWith('agentMetrics'))
  const base = { runId: s.runId ?? null, sessionId: s.sessionId ?? null, harness, caveats, confidence: s.conf }
  const found = sm.meta.agentMetrics
  const adapter = adapterHarness(harness)
  if (!found && adapter !== null && !HARNESS_CAPABILITIES[adapter].agents) {
    return { ...base, agentMetrics: null, unmeasuredAgents: 0, reason: `${adapter} does not produce agent metrics (HARNESS_CAPABILITIES)` }
  }
  const agentMetrics: ProjectedAgentMetrics = found ?? { invocations: [], totalInvocations: 0, unmeasuredInvocations: 0, totalTokens: 0, totalCostUSD: 0 }
  return { ...base, agentMetrics, unmeasuredAgents: agentMetrics.unmeasuredInvocations }
}

export const agentMetricsProjection: Projection<AgentMetricsState, AgentMetricsResult> = {
  name: 'agent-metrics',
  version: 1,
  empty: () => ({ sm: sessionMetaProjection.empty(), dims: emptyDimensionFacts(), conf: null }),
  fold(state, events) {
    for (const e of events) foldOne(state, e)
  },
  finish,
}
