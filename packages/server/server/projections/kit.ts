/**
 * projections/kit.ts — PURE. The accumulators the P3 projections share (P3 §2), written once.
 *
 * Every projection in this directory is a fold that must be ORDER-INDEPENDENT and IDEMPOTENT by
 * `eventId` (P1 §8, the property `session-meta.ts` already holds): each accumulator here is therefore
 * a sum over distinct events, a min/max over an order key, a set, or a keyed record with a
 * deterministic tie-break — never "the last one to arrive". The idempotency gate itself (a `seen` set)
 * lives in each projection's state, because it is per KEY.
 *
 * Three rules every accumulator carries forward:
 * - **Confidence is the WEAKEST** of the events that produced a figure (D17) — `foldConfidence`.
 * - **Absent is not zero** (D21): a usage counter no response reported stays ABSENT from a sum, and
 *   the counters any response left out are named (`partialCounters`), so a partial total never reads
 *   as a measured one.
 * - **Money is priced by core** (`calcCost`, `MODEL_PRICING`) or stated by the source; never inline.
 */
import {
  HARNESS_ORDER,
  USAGE_COUNTERS,
  absentUsageCounters,
  calcCost,
  isLocalModelId,
  weakestConfidence,
  type AgentisticsEvent,
  type AnyAgentisticsEvent,
  type Confidence,
  type HarnessId,
  type ModelUsage,
  type ProviderId,
  type RunHarness,
  type TokenBreakdown,
  type UsageCounter,
} from '@agentistics/core'
import { compareKey, keyOf, type OrderKey } from './session-meta'

// ── Confidence ──────────────────────────────────────────────────────────────────────────────────

/** `null` = nothing has contributed yet. Commutative and idempotent, so order never matters. */
export function foldConfidence(acc: Confidence | null, c: Confidence): Confidence {
  return acc === null ? c : weakestConfidence(acc, c)
}

// ── Harness ─────────────────────────────────────────────────────────────────────────────────────

const HARNESS_IDS: ReadonlySet<string> = new Set<string>(HARNESS_ORDER)
/** The native runtime's `RunHarness` — a harness, but not a `HarnessId` (no legacy adapter). */
const NATIVE_HARNESS = 'agentistics'

/**
 * Which harness a key belongs to: the `run.started` harness when it names a `RunHarness` (every
 * `HarnessId`, or the native runtime `'agentistics'`), else the event's own `source.id` when THAT is a
 * `HarnessId`. `null` otherwise — a row is never filed under a harness nobody named.
 */
export function resolveHarness(runHarness: string | undefined, sourceId: string | undefined): RunHarness | null {
  if (runHarness && (HARNESS_IDS.has(runHarness) || runHarness === NATIVE_HARNESS)) return runHarness as RunHarness
  if (sourceId && HARNESS_IDS.has(sourceId)) return sourceId as HarnessId
  return null
}

/** Narrows a `RunHarness` to a `HarnessId` (the key of `HARNESS_CAPABILITIES`); `null` for the native one. */
export function adapterHarness(h: RunHarness | null): HarnessId | null {
  return h !== null && HARNESS_IDS.has(h) ? (h as HarnessId) : null
}

/** The facts a key learns from its lifecycle events, each settled by the ORDER KEY (earliest wins). */
export interface DimensionFacts {
  /** `session.started` with the earliest order key. */
  session?: { key: OrderKey; repo?: string; project?: string; conf: Confidence }
  /** `run.started` with the earliest order key. */
  run?: { key: OrderKey; harness: string; conversationId?: string; cwd?: string; at: string; conf: Confidence }
  /** The smallest `source.id` seen on a harness-kind event — the fallback harness. */
  sourceId?: string
  /** Every `taskId` an event of this key carried; the smallest is reported (deterministic). */
  taskIds: Set<string>
}

export const emptyDimensionFacts = (): DimensionFacts => ({ taskIds: new Set() })

export function foldDimensionFacts(f: DimensionFacts, e: AnyAgentisticsEvent): void {
  if (e.taskId) f.taskIds.add(e.taskId)
  if (e.source.kind === 'harness' && (f.sourceId === undefined || e.source.id < f.sourceId)) f.sourceId = e.source.id
  if (e.type === 'session.started') {
    const key = keyOf(e)
    if (!f.session || compareKey(key, f.session.key) < 0) {
      f.session = {
        key, conf: e.provenance.confidence,
        ...(e.data.repoKey !== undefined ? { repo: e.data.repoKey } : {}),
        ...(e.data.projectPath ? { project: e.data.projectPath } : {}),
      }
    }
  } else if (e.type === 'run.started') {
    const key = keyOf(e)
    if (!f.run || compareKey(key, f.run.key) < 0) {
      f.run = {
        key, harness: e.data.harness, at: e.occurredAt, conf: e.provenance.confidence,
        ...(e.data.conversationId ? { conversationId: e.data.conversationId } : {}),
        ...(e.data.cwd ? { cwd: e.data.cwd } : {}),
      }
    }
  }
}

/** Repo (`''` = no linked repository, a real bucket), project (`''` = unknown), task, harness. */
export function dimensionsOf(f: DimensionFacts): {
  repo: string; project: string; taskId: string | null; harness: RunHarness | null; conversationId?: string
  /** The weakest confidence among the events that settled these dimensions; `null` if none did. */
  conf: Confidence | null
} {
  let conf: Confidence | null = null
  if (f.session) conf = foldConfidence(conf, f.session.conf)
  if (f.run) conf = foldConfidence(conf, f.run.conf)
  const task = [...f.taskIds].sort()[0] ?? null
  return {
    repo: f.session?.repo ?? '',
    project: f.session?.project ?? f.run?.cwd ?? '',
    taskId: task,
    harness: resolveHarness(f.run?.harness, f.sourceId),
    ...(f.run?.conversationId ? { conversationId: f.run.conversationId } : {}),
    conf,
  }
}

// ── Money: one cell of billed responses under ONE pricing model ─────────────────────────────────

/**
 * Billed responses of ONE model, summed. The pricing is decided at FINISH over the cell's totals —
 * `calcCost` is linear, so pricing the sum equals summing per-response prices, and deciding once
 * keeps the TTL split's both-or-neither rule whole.
 */
export interface CostCell {
  /** Summed per counter, ONLY over responses that reported it. */
  reported: Partial<Record<UsageCounter, number>>
  /** Counters at least one response did not report (D21). */
  absent: Set<UsageCounter>
  responses: number
  /** Cost the SOURCE stated (`model.completed.costUSD`), by who stated it. */
  statedProvider: number
  statedHarness: number
  statedProviderN: number
  statedHarnessN: number
  /** Tokens of the responses priced from the table (no stated cost), materialised for `calcCost`. */
  table: { input: number; output: number; cacheRead: number; cacheWrite: number; n: number; ttl1h: number; ttl5m: number; ttlAll: boolean }
  /** Responses that could not be priced at all: no model, or a local model (§41: never a price). */
  unpriced: number
  conf: Confidence | null
}

export const emptyCostCell = (): CostCell => ({
  reported: {}, absent: new Set(), responses: 0,
  statedProvider: 0, statedHarness: 0, statedProviderN: 0, statedHarnessN: 0,
  table: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, n: 0, ttl1h: 0, ttl5m: 0, ttlAll: true },
  unpriced: 0, conf: null,
})

/** The id that PRICES a response (D20: `modelServed` when the provider said which one answered). */
export function pricingModelOf(e: AgentisticsEvent<'model.completed'>): string {
  return e.data.modelServed || e.data.model || ''
}

export function foldCostResponse(cell: CostCell, e: AgentisticsEvent<'model.completed'>): void {
  const u = e.data.usage
  cell.responses++
  cell.conf = foldConfidence(cell.conf, e.provenance.confidence)
  for (const c of absentUsageCounters(u)) cell.absent.add(c)
  for (const c of USAGE_COUNTERS) {
    const v = u[c]
    if (typeof v === 'number') cell.reported[c] = (cell.reported[c] ?? 0) + v
  }
  const stated = e.data.costUSD
  if (typeof stated === 'number' && Number.isFinite(stated) && e.data.costSource) {
    if (e.data.costSource === 'provider') { cell.statedProvider += stated; cell.statedProviderN++ }
    else { cell.statedHarness += stated; cell.statedHarnessN++ }
    return
  }
  const model = pricingModelOf(e)
  if (!model || isLocalModelId(model)) { cell.unpriced++; return }
  const t = cell.table
  // An absent counter contributes nothing to the priced sum; `absent` is what says the sum is partial.
  t.input += u.input ?? 0; t.output += u.output ?? 0; t.cacheRead += u.cacheRead ?? 0; t.cacheWrite += u.cacheWrite ?? 0
  t.n++
  if (e.data.cacheWriteByTtl) {
    t.ttl1h += e.data.cacheWriteByTtl.ephemeral_1h ?? 0
    t.ttl5m += e.data.cacheWriteByTtl.ephemeral_5m ?? 0
  } else {
    t.ttlAll = false
  }
}

export interface PricedCell {
  tokens: Partial<TokenBreakdown>
  partialCounters: (keyof TokenBreakdown)[]
  costUSD: number | null
  costSource: 'provider' | 'harness' | 'table' | 'mixed' | null
  responses: number
  /** Responses the figure could not price (no model / a local model) — `costUSD` excludes them. */
  unpricedResponses: number
}

export function priceCell(cell: CostCell, model: string): PricedCell {
  const tokens: Partial<TokenBreakdown> = {}
  for (const c of USAGE_COUNTERS) if (cell.reported[c] !== undefined) tokens[c] = cell.reported[c]
  const partialCounters = USAGE_COUNTERS.filter(c => cell.absent.has(c))

  const kinds: ('provider' | 'harness' | 'table')[] = []
  let cost = 0
  if (cell.statedProviderN > 0) { kinds.push('provider'); cost += cell.statedProvider }
  if (cell.statedHarnessN > 0) { kinds.push('harness'); cost += cell.statedHarness }
  if (cell.table.n > 0 && model) {
    const t = cell.table
    const usage: ModelUsage = {
      inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead, cacheCreationInputTokens: t.cacheWrite,
      webSearchRequests: 0, costUSD: 0,
    }
    // BOTH-OR-NEITHER and only when the split reconciles against the counter — the legacy rule.
    if (t.ttlAll && t.ttl1h + t.ttl5m === t.cacheWrite) {
      usage.cacheCreation1hInputTokens = t.ttl1h
      usage.cacheCreation5mInputTokens = t.ttl5m
    }
    kinds.push('table')
    cost += calcCost(usage, model)
  }
  const costUSD = kinds.length === 0 ? null : cost
  const costSource = kinds.length === 0 ? null : kinds.length === 1 ? kinds[0]! : 'mixed'
  return { tokens, partialCounters, costUSD, costSource, responses: cell.responses, unpricedResponses: cell.unpriced }
}

/** Two priced figures of the same kind, added — `null` only when both are. */
export function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return a + b
}

/** The provider a model was billed through, per model — the smallest when sources disagree. */
export function foldProvider(map: Map<string, ProviderId>, model: string, provider: ProviderId): void {
  const prev = map.get(model)
  if (prev === undefined || provider < prev) map.set(model, provider)
}

// ── Tools: one execution, request to result ─────────────────────────────────────────────────────

export type ToolOutcome = 'completed' | 'failed' | 'cancelled' | 'denied' | 'unknown'

export interface ToolExec {
  /** The request with the smallest event id wins — deterministic, whatever the arrival order. */
  req?: { id: string; canonical: string; raw: string; at: string }
  end?: { id: string; outcome: ToolOutcome; at: string; durationMs?: number }
  conf: Confidence | null
}

export type ToolAcc = Map<string, ToolExec>

export function foldToolEvent(acc: ToolAcc, e: AnyAgentisticsEvent): void {
  let execId: string
  switch (e.type) {
    case 'tool.requested': case 'tool.completed': case 'tool.failed': case 'tool.denied':
      execId = e.data.toolExecutionId
      break
    default:
      return
  }
  let x = acc.get(execId)
  if (!x) { x = { conf: null }; acc.set(execId, x) }
  x.conf = foldConfidence(x.conf, e.provenance.confidence)
  if (e.type === 'tool.requested') {
    if (!x.req || e.eventId < x.req.id) x.req = { id: e.eventId, canonical: e.data.canonicalName, raw: e.data.name, at: e.occurredAt }
    return
  }
  // A terminal event: the one with the smallest event id settles the outcome.
  if (x.end && x.end.id <= e.eventId) return
  if (e.type === 'tool.completed') {
    x.end = { id: e.eventId, outcome: 'completed', at: e.occurredAt, ...(e.data.durationMs !== undefined ? { durationMs: e.data.durationMs } : {}) }
  } else if (e.type === 'tool.failed') {
    x.end = { id: e.eventId, outcome: e.data.status, at: e.occurredAt }
  } else {
    x.end = { id: e.eventId, outcome: 'denied', at: e.occurredAt }
  }
}

export interface ToolFigure {
  calls: number
  errors: number
  cancelled: number
  denied: number
  /** Executions with a result event at all — the rest are still running, or their result was never written. */
  finished: number
  /** Summed over the executions whose duration is known; `null` when none is. */
  durationMs: number | null
  /** How many executions `durationMs` covers — fewer than `calls` means the sum is partial. */
  durationCalls: number
  maxDurationMs: number | null
  confidence: Confidence
}

/**
 * The duration of one execution: the harness's own measurement when it stated one, else the wall time
 * from the request to the result (which includes any approval wait — that is where the time went).
 * `null` when either end is missing, unusable, or the clock ran backwards.
 */
export function execDurationMs(x: ToolExec): number | null {
  const d = x.end?.durationMs
  if (typeof d === 'number' && Number.isFinite(d) && d >= 0) return d
  if (!x.req || !x.end) return null
  const a = Date.parse(x.req.at)
  const b = Date.parse(x.end.at)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  return b - a
}

/** Per tool, by `canonical` (or the harness's own `raw`) name; a result with no request is `unknown`. */
export function toolFigures(acc: ToolAcc, names: 'canonical' | 'raw' = 'canonical'): Record<string, ToolFigure> {
  const out: Record<string, ToolFigure> = {}
  for (const x of acc.values()) {
    const name = x.req ? (names === 'raw' ? x.req.raw : x.req.canonical) : 'unknown'
    let f = out[name]
    if (!f) {
      f = { calls: 0, errors: 0, cancelled: 0, denied: 0, finished: 0, durationMs: null, durationCalls: 0, maxDurationMs: null, confidence: x.conf ?? 'exact' }
      out[name] = f
    }
    f.calls++
    if (x.conf) f.confidence = weakestConfidence(f.confidence, x.conf)
    if (x.end) {
      f.finished++
      if (x.end.outcome === 'failed') f.errors++
      else if (x.end.outcome === 'cancelled') f.cancelled++
      else if (x.end.outcome === 'denied') f.denied++
    }
    const d = execDurationMs(x)
    if (d !== null) {
      f.durationMs = (f.durationMs ?? 0) + d
      f.durationCalls++
      f.maxDurationMs = f.maxDurationMs === null ? d : Math.max(f.maxDurationMs, d)
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** The UTC day of an instant — the billing/tag day rule. `''` when it is not a usable instant. */
export function utcDay(at: string | undefined): string {
  if (!at) return ''
  const d = at.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ''
}
