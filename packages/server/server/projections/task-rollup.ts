/**
 * projections/task-rollup.ts — PURE, version 1. Keyed by `taskId` (P3 §2): what a delivery cost, in
 * how many rounds, across how many sessions — the journal's answer to `sessions/task-rollup.ts`, with
 * `costMeasured` finally populated (master spec §41: "12 of 14 sessions measured, 2 estimated").
 *
 * WHAT IT CAN SEE: only events whose envelope carries that `taskId`. A session filed on a task in
 * `tasks.json` but whose events carry no `taskId` is NOT in this rollup — the journal is the only
 * input, and a guess from outside it would be a second answer. (Transcript replays today stamp no
 * `taskId`; the native runtime and the ALM events do.)
 *
 * The same three rules as `sessions/task-rollup.ts`, each applied the same way:
 *  1. Absent is not zero: `rounds`, `activeMinutes`, `tokens` and `costUSD` are `null` when no session
 *     could report them. Rounds and active time are read off an embedded `SessionMetaState` per session
 *     (`user_message_count` / `active_minutes` under that projection's adapter-version gates), never
 *     re-derived here.
 *  2. Cost provenance is counted per session, never merged in silence: a session is MEASURED when every
 *     response of it was priced by a cost its source stated (`provider` / `harness`), ESTIMATED when any
 *     part came from the table, UNPRICED when nothing could be priced.
 *  3. Money is `kit.ts`'s `priceCell` (core `calcCost` per model, at each model's own rate).
 *
 * Confidence is the weakest of every event folded (D17).
 */
import {
  USAGE_COUNTERS,
  type AgentisticsEvent, type AnyAgentisticsEvent, type Confidence, type Projection, type RunHarness,
  type TokenBreakdown, type UsageCounter,
} from '@agentistics/core'
import {
  addNullable, dimensionsOf, emptyCostCell, emptyDimensionFacts, foldConfidence, foldCostResponse, foldDimensionFacts,
  priceCell, pricingModelOf,
  type CostCell, type DimensionFacts,
} from './kit'
import { sessionMetaProjection, type SessionMetaState } from './session-meta'

interface TaskSession {
  sm: SessionMetaState
  dims: DimensionFacts
  /** One cost cell per priced model id. */
  cells: Map<string, CostCell>
}

export interface TaskRollupState {
  sessions: Map<string, TaskSession>
  conf: Confidence | null
  taskId?: string
}

export interface TaskRollupResult {
  taskId: string | null
  /** Sessions with at least one event carrying this task. */
  sessions: number
  sessionIds: string[]
  rounds: number | null
  activeMinutes: number | null
  /** Summed per counter over what was reported; `null` when no response was folded at all. */
  tokens: Partial<TokenBreakdown> | null
  partialCounters: (keyof TokenBreakdown)[]
  costUSD: number | null
  /** `costUSD` split by harness (`''` = no harness named) — `null` exactly when `costUSD` is. */
  costByHarness: Record<string, number> | null
  costMeasuredSessions: number
  costEstimatedSessions: number
  costUnpricedSessions: number
  confidence: Confidence | null
}

/** Sessions of a task with no `sessionId` on their events are folded under this key. */
const NO_SESSION = ''

function foldOne(s: TaskRollupState, e: AnyAgentisticsEvent): void {
  const sid = e.sessionId ?? NO_SESSION
  let ts = s.sessions.get(sid)
  if (!ts) { ts = { sm: sessionMetaProjection.empty(), dims: emptyDimensionFacts(), cells: new Map() }; s.sessions.set(sid, ts) }
  if (ts.sm.seen.has(e.eventId)) return
  s.conf = foldConfidence(s.conf, e.provenance.confidence)
  if (e.taskId && (s.taskId === undefined || e.taskId < s.taskId)) s.taskId = e.taskId
  foldDimensionFacts(ts.dims, e)
  if (e.type === 'model.completed') {
    const m = e as AgentisticsEvent<'model.completed'>
    const model = pricingModelOf(m)
    let c = ts.cells.get(model)
    if (!c) { c = emptyCostCell(); ts.cells.set(model, c) }
    foldCostResponse(c, m)
  }
  sessionMetaProjection.fold(ts.sm, [e])
}

function finish(s: TaskRollupState): TaskRollupResult {
  const ids = [...s.sessions.keys()].sort()
  let rounds: number | null = null
  let activeMinutes: number | null = null
  let costUSD: number | null = null
  const costByHarness: Record<string, number> = {}
  const reported: Partial<Record<UsageCounter, number>> = {}
  const absent = new Set<UsageCounter>()
  let responses = 0
  let measured = 0, estimated = 0, unpriced = 0

  for (const id of ids) {
    const ts = s.sessions.get(id)!
    const meta = sessionMetaProjection.finish(ts.sm).meta
    if (typeof meta.user_message_count === 'number') rounds = (rounds ?? 0) + meta.user_message_count
    if (typeof meta.active_minutes === 'number') activeMinutes = (activeMinutes ?? 0) + meta.active_minutes

    let sessionCost: number | null = null
    const kinds = new Set<string>()
    let sessionUnpriced = 0
    for (const model of [...ts.cells.keys()].sort()) {
      const cell = ts.cells.get(model)!
      responses += cell.responses
      for (const c of cell.absent) absent.add(c)
      for (const c of USAGE_COUNTERS) if (cell.reported[c] !== undefined) reported[c] = (reported[c] ?? 0) + cell.reported[c]!
      const p = priceCell(cell, model)
      sessionCost = addNullable(sessionCost, p.costUSD)
      sessionUnpriced += p.unpricedResponses
      if (p.costSource === 'mixed') { kinds.add('table'); kinds.add('stated') }
      else if (p.costSource === 'table') kinds.add('table')
      else if (p.costSource !== null) kinds.add('stated')
    }
    if (sessionCost === null) {
      if (ts.cells.size > 0) unpriced++
      continue
    }
    if (kinds.has('table') || sessionUnpriced > 0) estimated++
    else measured++
    costUSD = addNullable(costUSD, sessionCost)
    const h: RunHarness | '' = dimensionsOf(ts.dims).harness ?? ''
    costByHarness[h] = (costByHarness[h] ?? 0) + sessionCost
  }

  const tokens: Partial<TokenBreakdown> | null = responses === 0 ? null : {}
  if (tokens) for (const c of USAGE_COUNTERS) if (reported[c] !== undefined) tokens[c] = reported[c]
  return {
    taskId: s.taskId ?? null,
    sessions: ids.length,
    sessionIds: ids,
    rounds,
    activeMinutes,
    tokens,
    partialCounters: USAGE_COUNTERS.filter(c => absent.has(c)),
    costUSD,
    costByHarness: costUSD === null ? null : costByHarness,
    costMeasuredSessions: measured,
    costEstimatedSessions: estimated,
    costUnpricedSessions: unpriced,
    confidence: s.conf,
  }
}

export const taskRollupProjection: Projection<TaskRollupState, TaskRollupResult> = {
  name: 'task-rollup',
  version: 1,
  empty: () => ({ sessions: new Map(), conf: null }),
  fold(state, events) {
    for (const e of events) foldOne(state, e)
  },
  finish,
}
