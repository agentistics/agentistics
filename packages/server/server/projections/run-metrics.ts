/**
 * projections/run-metrics.ts — PURE, version 1. Keyed by `runId` (P3 §2): one `RunFact` per run —
 * sessions, messages, active time and tools, the figures that are not money (money is
 * `cost-by-dimension.ts`).
 *
 * It re-derives none of `session-meta.ts`'s rules: the state EMBEDS a `SessionMetaState` and the
 * figures that projection already decides — the person's turns (`user_message_count`, gated on the
 * adapter version that records them), `active_minutes` (`activeMinutesOf`, absent while a turn is
 * open), the session's model and the unmeasured-agent count — are read off its `finish`. What is NEW
 * here is the per-tool DURATION (master spec §37's "which tools took the most time?"), from the
 * request → result pair (`kit.ts`, `toolFigures`).
 *
 * Idempotent by `eventId` through the embedded state's own `seen` set, checked BEFORE any of this
 * projection's accumulators move; order independent because every accumulator is a sum, a set, or a
 * min over an order key. `confidence` is the WEAKEST of every event folded (D17).
 */
import type { AnyAgentisticsEvent, Confidence, Projection, ProviderId } from '@agentistics/core'
import type { RunFact } from './facts'
import {
  dimensionsOf, emptyDimensionFacts, foldConfidence, foldDimensionFacts, foldProvider, foldToolEvent, toolFigures, utcDay,
  type DimensionFacts, type ToolAcc,
} from './kit'
import { sessionMetaProjection, type Caveat, type SessionMetaState } from './session-meta'

export interface RunMetricsState {
  sm: SessionMetaState
  tools: ToolAcc
  dims: DimensionFacts
  providers: Map<string, ProviderId>
  conf: Confidence | null
  /** The smallest ids seen — every event of a run carries the same ones; a min keeps it deterministic. */
  sessionId?: string
  runId?: string
  /** The earliest usable `occurredAt` of any event — the day of a run whose `run.started` is not in the journal. */
  firstAt?: string
}

export interface RunMetricsResult {
  /** `null` when no harness can be named for the run (see `resolveHarness`) — said in `withheld`. */
  fact: RunFact | null
  withheld?: string
  /** `session-meta.ts`'s caveats for the figures read off it (turns, active time, agents). */
  caveats: Caveat[]
  eventsFolded: number
}

/** Folds one event into a state that has not seen it. Shared with `agent-metrics.ts`' neighbours. */
function foldOne(s: RunMetricsState, e: AnyAgentisticsEvent): void {
  if (s.sm.seen.has(e.eventId)) return
  s.conf = foldConfidence(s.conf, e.provenance.confidence)
  if (e.sessionId && (s.sessionId === undefined || e.sessionId < s.sessionId)) s.sessionId = e.sessionId
  if (e.runId && (s.runId === undefined || e.runId < s.runId)) s.runId = e.runId
  if (Number.isFinite(Date.parse(e.occurredAt)) && (s.firstAt === undefined || e.occurredAt < s.firstAt)) s.firstAt = e.occurredAt
  foldDimensionFacts(s.dims, e)
  foldToolEvent(s.tools, e)
  if (e.type === 'model.completed' && e.data.model) foldProvider(s.providers, e.data.model, e.data.provider)
  sessionMetaProjection.fold(s.sm, [e])
}

const RELEVANT_CAVEATS = new Set(['user_message_count', 'active_minutes', 'agents'])

function finish(s: RunMetricsState): RunMetricsResult {
  const sm = sessionMetaProjection.finish(s.sm)
  const caveats = sm.caveats.filter(c => RELEVANT_CAVEATS.has(c.field) || c.field.startsWith('agentMetrics'))
  const eventsFolded = sm.eventsFolded
  if (s.conf === null || s.runId === undefined) return { fact: null, withheld: 'no event of this run was folded', caveats, eventsFolded }
  const dims = dimensionsOf(s.dims)
  if (dims.harness === null) {
    return { fact: null, withheld: 'no harness is named for this run (its run.started names none this product tracks)', caveats, eventsFolded }
  }
  const model = sm.meta.model ?? null
  const tools: RunFact['tools'] = {}
  for (const [name, f] of Object.entries(toolFigures(s.tools))) {
    tools[name] = { calls: f.calls, errors: f.errors, durationMs: f.durationMs, durationCalls: f.durationCalls }
  }
  const fact: RunFact = {
    runId: s.runId,
    sessionId: s.sessionId ?? '',
    ...(dims.conversationId ? { conversationId: dims.conversationId } : {}),
    harness: dims.harness,
    day: utcDay(s.dims.run?.at) || utcDay(s.firstAt),
    provider: model ? (s.providers.get(model) ?? null) : null,
    model,
    repo: dims.repo,
    project: dims.project,
    taskId: dims.taskId,
    messages: sm.meta.user_message_count ?? null,
    activeMinutes: sm.meta.active_minutes ?? null,
    tools,
    unmeasuredAgents: sm.meta.agentMetrics?.unmeasuredInvocations ?? 0,
    confidence: s.conf,
  }
  return { fact, caveats, eventsFolded }
}

export const runMetricsProjection: Projection<RunMetricsState, RunMetricsResult> = {
  name: 'run-metrics',
  // 2: `project` is the project root (`canonicalProjectPath`), so worktrees roll up (A4.4 decision 2).
  version: 2,
  empty: () => ({
    sm: sessionMetaProjection.empty(), tools: new Map(), dims: emptyDimensionFacts(), providers: new Map(), conf: null,
  }),
  fold(state, events) {
    for (const e of events) foldOne(state, e)
  },
  finish,
}
