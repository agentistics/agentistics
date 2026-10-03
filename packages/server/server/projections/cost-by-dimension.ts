/**
 * projections/cost-by-dimension.ts — PURE, version 1. Keyed by `sessionId`; finishes into the
 * `CostFact` rows of `facts.ts` — one per (day × provider × model × run × agent × task) cell of the session,
 * stamped with the session's harness, repository and project (P3 §2: harness × provider × model × repo
 * × project × day). The query API (A4.3) sums these and re-derives nothing.
 *
 * Why the key is the SESSION and not the cell: a cell's repo, project and harness are facts of the
 * session (`session.started`, `run.started`), which may reach the journal AFTER the responses they
 * describe. Folding per session and stamping at FINISH is what keeps the answer independent of the
 * arrival order; a cell keyed on its own would have to guess the dimensions of a response whose
 * session it had not seen yet.
 *
 * Money (master spec §41), per response:
 * - a cost the SOURCE stated (`model.completed.costUSD` + `costSource`) is used as stated —
 *   `'provider'` or `'harness'`;
 * - otherwise `calcCost()` × `MODEL_PRICING` over the priced id (`modelServed`, else `model`) —
 *   `'table'`. An id no table row matches takes core's shared fallback rate, exactly as every legacy
 *   surface prices it (a wrong-but-consistent figure is a MODEL_PRICING decision, not this module's);
 * - a response with no model, or a LOCAL model, is never priced (§41: "no cost, ever, and the absence
 *   is visible") — `costUSD` is `null` when nothing in the cell could be priced;
 * - a cell mixing sources says `'mixed'`.
 * Tokens: a counter no response of the cell reported is ABSENT (D21), and `partialCounters` names every
 * counter at least one response left out.
 *
 * `subagent` answers master spec §37's "what did the subagents cost?": a cell is a subagent's when its
 * agent is not the run's main agent, decided at FINISH by `session-meta.ts`'s own rule (the agents an
 * `agent.started` declares main; with none declared, every agent not known to be a subagent).
 *
 * `confidence` is the weakest of the cell's responses AND of the lifecycle events that attributed it
 * (D17): a row is only as certain as the facts that put it in its bucket.
 */
import type { AgentisticsEvent, AnyAgentisticsEvent, Confidence, Projection, ProviderId } from '@agentistics/core'
import type { CostFact } from './facts'
import {
  dimensionsOf, emptyCostCell, foldAgentKind, subagentRule, emptyDimensionFacts, foldConfidence, foldCostResponse, foldDimensionFacts, priceCell,
  pricingModelOf, utcDay,
  type CostCell, type DimensionFacts,
} from './kit'

interface Cell {
  day: string
  provider: ProviderId | null
  model: string | null
  runId: string | null
  agentId: string | null
  taskId: string | null
  cost: CostCell
}

export interface CostByDimensionState {
  seen: Set<string>
  dims: DimensionFacts
  /** Keyed by `JSON.stringify([day, provider, model, runId, agentId, taskId])`. */
  cells: Map<string, Cell>
  /**
   * Each agent's `agent.started` KIND, settled by the smallest event id (as `session-meta.ts` settles
   * it) — whether a cell is a SUBAGENT's is decided from these at finish, never on arrival.
   */
  agentKinds: Map<string, { id: string; main: boolean }>
  sessionId?: string
}

export interface CostByDimensionResult {
  facts: CostFact[]
  /** Responses that could not be filed as a `CostFact` (no harness is named), with the reason. */
  withheld: { responses: number; reason: string } | null
  /** Responses whose day is not a usable UTC day — filed nowhere, counted here. */
  undated: number
}

const RELEVANT: ReadonlySet<string> = new Set(['session.started', 'run.started', 'agent.started', 'model.completed'])

function foldOne(s: CostByDimensionState, e: AnyAgentisticsEvent): void {
  if (!RELEVANT.has(e.type) || s.seen.has(e.eventId)) return
  s.seen.add(e.eventId)
  if (e.sessionId && (s.sessionId === undefined || e.sessionId < s.sessionId)) s.sessionId = e.sessionId
  foldDimensionFacts(s.dims, e)
  if (e.type === 'agent.started') {
    foldAgentKind(s.agentKinds, e)
    return
  }
  if (e.type !== 'model.completed') return
  const m = e as AgentisticsEvent<'model.completed'>
  const model = pricingModelOf(m) || null
  const provider = m.data.provider ?? null
  const day = utcDay(m.occurredAt)
  const runId = m.runId ?? null
  const agentId = m.agentId ?? null
  const taskId = m.taskId ?? null
  const k = JSON.stringify([day, provider, model, runId, agentId, taskId])
  let c = s.cells.get(k)
  if (!c) { c = { day, provider, model, runId, agentId, taskId, cost: emptyCostCell() }; s.cells.set(k, c) }
  foldCostResponse(c.cost, m)
}

function finish(s: CostByDimensionState): CostByDimensionResult {
  const dims = dimensionsOf(s.dims)
  const keys = [...s.cells.keys()].sort()
  let undated = 0
  if (dims.harness === null) {
    const responses = keys.reduce((n, k) => n + s.cells.get(k)!.cost.responses, 0)
    return {
      facts: [],
      withheld: responses > 0 ? { responses, reason: 'no harness is named for this session (its run.started names none this product tracks)' } : null,
      undated: 0,
    }
  }
  // `session-meta.ts`'s rule for which agents are MAIN: the ones an `agent.started` says are main; with
  // none declared, every agent not known to be a subagent. A response with no agent is the session's
  // own, never a subagent's.
  const isSubagent = subagentRule(s.agentKinds)
  const facts: CostFact[] = []
  for (const k of keys) {
    const c = s.cells.get(k)!
    if (!c.day) { undated += c.cost.responses; continue }
    const priced = priceCell(c.cost, c.model ?? '')
    let confidence: Confidence = c.cost.conf ?? 'exact'
    if (dims.conf !== null) confidence = foldConfidence(confidence, dims.conf)
    facts.push({
      day: c.day,
      harness: dims.harness,
      provider: c.provider,
      model: c.model,
      repo: dims.repo,
      project: dims.project,
      sessionId: s.sessionId ?? '',
      ...(dims.conversationId ? { conversationId: dims.conversationId } : {}),
      runId: c.runId,
      agentId: c.agentId,
      subagent: isSubagent(c.agentId),
      taskId: c.taskId,
      tokens: priced.tokens,
      partialCounters: priced.partialCounters,
      costUSD: priced.costUSD,
      costSource: priced.costSource,
      responses: priced.responses,
      confidence,
    })
  }
  return { facts, withheld: null, undated }
}

export const costByDimensionProjection: Projection<CostByDimensionState, CostByDimensionResult> = {
  name: 'cost-by-dimension',
  // 2: `project` is the project root (`canonicalProjectPath`), so worktrees roll up (A4.4 decision 2).
  version: 2,
  empty: () => ({ seen: new Set(), dims: emptyDimensionFacts(), cells: new Map(), agentKinds: new Map() }),
  fold(state, events) {
    for (const e of events) foldOne(state, e)
  },
  finish,
}
