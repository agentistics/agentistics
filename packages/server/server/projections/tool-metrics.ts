/**
 * projections/tool-metrics.ts — PURE, version 1. Keyed by `runId` + canonical tool (P3 §2): calls,
 * errors, cancellations, denials and — new in this product — DURATION per tool, which master spec §37
 * names as the one question the dashboard cannot answer today ("which tools took the most time?").
 *
 * A duration is the harness's own measurement when it stated one (`tool.completed.durationMs`), else
 * the wall time from the request to its result — approval waits included, because that is where the
 * time went. An execution with no result yet, or a clock that ran backwards, has NO duration: it is
 * left out of `durationMs` and `durationCalls` says how many calls the sum covers, so a partial sum is
 * never presented as the whole (the D21 rule, applied to time).
 *
 * Tools are keyed by `canonicalTool()`'s name — the shared vocabulary every chart is written against.
 * Idempotent by `eventId` (`seen`), order independent (every settled field is a min over event ids),
 * confidence the weakest of each tool's events (D17).
 */
import type { AnyAgentisticsEvent, Confidence, Projection, RunHarness } from '@agentistics/core'
import {
  dimensionsOf, emptyDimensionFacts, foldConfidence, foldDimensionFacts, foldToolEvent, toolFigures,
  type DimensionFacts, type ToolAcc, type ToolFigure,
} from './kit'

const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.started', 'tool.requested', 'tool.completed', 'tool.failed', 'tool.denied',
])

export interface ToolMetricsState {
  seen: Set<string>
  tools: ToolAcc
  dims: DimensionFacts
  conf: Confidence | null
  sessionId?: string
  runId?: string
}

export interface ToolMetricsResult {
  runId: string | null
  sessionId: string | null
  harness: RunHarness | null
  /** By canonical tool name, sorted. `unknown` = a result whose request is not in the journal. */
  tools: Record<string, ToolFigure>
  confidence: Confidence | null
  eventsFolded: number
}

function foldOne(s: ToolMetricsState, e: AnyAgentisticsEvent): void {
  if (!TOOL_EVENT_TYPES.has(e.type) || s.seen.has(e.eventId)) return
  s.seen.add(e.eventId)
  s.conf = foldConfidence(s.conf, e.provenance.confidence)
  if (e.sessionId && (s.sessionId === undefined || e.sessionId < s.sessionId)) s.sessionId = e.sessionId
  if (e.runId && (s.runId === undefined || e.runId < s.runId)) s.runId = e.runId
  foldDimensionFacts(s.dims, e)
  foldToolEvent(s.tools, e)
}

export const toolMetricsProjection: Projection<ToolMetricsState, ToolMetricsResult> = {
  name: 'tool-metrics',
  version: 1,
  empty: () => ({ seen: new Set(), tools: new Map(), dims: emptyDimensionFacts(), conf: null }),
  fold(state, events) {
    for (const e of events) foldOne(state, e)
  },
  finish: s => ({
    runId: s.runId ?? null,
    sessionId: s.sessionId ?? null,
    harness: dimensionsOf(s.dims).harness,
    tools: toolFigures(s.tools),
    confidence: s.conf,
    eventsFolded: s.seen.size,
  }),
}
