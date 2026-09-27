/**
 * runtime-metrics-query.ts — PURE. The query behind `GET /api/runtime/metrics` (P3 spec §3, A4.3).
 *
 * It reads the materialised projections through the `ProjectionReader` CONTRACT
 * (`projections/facts.ts`) and decides only WHICH rows are summed and how they are grouped. What a
 * figure IS — its tokens, its price, its confidence — is the projections' decision, never this
 * module's (the header of `facts.ts` states that split).
 *
 * The rules this module exists to hold:
 *
 * - **Bad input is REFUSED with a code, never silently ignored.** An unknown parameter, dimension,
 *   metric, harness or provider is a caller who believes they asked for something they did not get;
 *   answering anyway is a confident wrong number.
 * - **Paged, always.** `limit` has a default and a hard ceiling, and a limit above the ceiling is
 *   refused rather than clamped. The cursor is KEYSET (the last group's key), so pages are stable
 *   across calls: group order is a total order on the key tuple, not on arrival order.
 * - **Every response states its basis** — the day rule, the cost basis, the confidence mix and what
 *   was NOT measured — plus how fresh the projection is.
 * - **Capability-aware**: a metric a group's harness cannot produce (`CAPABILITY_STATES`, the
 *   canonical table — the projections ARE the canonical model) is ABSENT from that group with a
 *   reason, never 0. A mixed group sums only its capable harnesses and names the ones it excluded.
 * - **`null` is not zero**: an unpriced cost row, a run with no messages recorded, a tool call with no
 *   duration are counted APART, and a metric no row could measure is absent, not `0`.
 * - Tokens are all four counters, through `tokens.ts` (`totalTokens`).
 */
import {
  CAPABILITY_STATES,
  capabilityReason,
  capabilitySupported,
  HARNESS_ORDER,
  totalTokens,
  type CapabilityMetric,
  type CapabilityState,
  type Confidence,
  type HarnessId,
  type RunHarness,
  type ProviderId,
  type TokenBreakdown,
} from '@agentistics/core'
import type { CostFact, ProjectionReader, RunFact } from './projections/facts'

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/** Dimensions a caller may FILTER on. Each maps to one field both fact shapes carry. */
export const FILTER_DIMENSIONS = ['harness', 'provider', 'model', 'repo', 'project', 'task', 'run', 'agent'] as const
export type FilterDimension = typeof FILTER_DIMENSIONS[number]

/** Dimensions a caller may GROUP by: every filter dimension, plus the UTC day. */
export const GROUP_DIMENSIONS = [...FILTER_DIMENSIONS, 'day'] as const
export type GroupDimension = typeof GROUP_DIMENSIONS[number]

/**
 * Filters the P3 spec names that this query CANNOT honour over the projection contract, each with
 * the sentence that says why. Refused with `unsupported_filter` — never ignored, because an ignored
 * `tag=x` answers "everything" to a caller who asked for "only x".
 */
export const UNSUPPORTED_FILTERS: Record<'tag' | 'machine' | 'member', string> = {
  tag: 'tag filtering is not available on the projection query yet: a tag resolves to sessions through their SessionMeta (machine, team, account, user and a period window), and the projection facts carry none of those fields, so resolving it here would be a second, divergent implementation of the tag rule.',
  machine: 'the machine dimension does not exist in this projection: every fact in it was produced by THIS machine, and a central has no projection of its members yet.',
  member: 'the member dimension does not exist in this projection: every fact in it was produced by THIS machine, and a central has no projection of its members yet.',
}

export const METRICS = ['cost', 'tokens', 'responses', 'sessions', 'runs', 'messages', 'activeMinutes', 'tools'] as const
export type MetricId = typeof METRICS[number]
export const DEFAULT_METRICS: readonly MetricId[] = ['cost', 'tokens', 'sessions', 'runs']

/** The capability that gates each metric, or `null` when the metric exists for every harness. */
const METRIC_CAPABILITY: Record<MetricId, CapabilityMetric | null> = {
  cost: 'cost',
  tokens: 'tokens',
  responses: null,
  sessions: null,
  runs: null,
  messages: null,
  activeMinutes: 'activeTime',
  tools: 'tools',
}

/** Which fact stream a metric is read from. `sessions`/`runs` are counted over both. */
const METRIC_STREAM: Record<MetricId, 'cost' | 'run' | 'both'> = {
  cost: 'cost',
  tokens: 'cost',
  responses: 'cost',
  sessions: 'both',
  runs: 'both',
  messages: 'run',
  activeMinutes: 'run',
  tools: 'run',
}

/** A Record so the compiler insists on every `ProviderId` — never a hand-kept array. */
const KNOWN_PROVIDERS: Record<ProviderId, true> = {
  anthropic: true, openai: true, google: true, moonshot: true, 'openai-compatible': true, other: true,
}
/** Every harness a fact can carry: the adapter harnesses plus the native runtime. */
export const RUN_HARNESS_ORDER: readonly RunHarness[] = [...HARNESS_ORDER, 'agentistics']
const KNOWN_HARNESSES = new Set<string>(RUN_HARNESS_ORDER)

/**
 * Dimensions that only COST facts carry (the agent whose responses were billed). A run fact is the
 * whole run, not one agent's share of it, so while one of these is active the run stream cannot be
 * attributed: its metrics are refused and sessions/runs are counted over cost facts only.
 */
const COST_ONLY_DIMENSIONS: readonly string[] = ['agent']

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 1000
export const MAX_GROUP_BY = 3
export const MAX_FILTER_VALUES = 200

const TOKEN_KEYS: readonly (keyof TokenBreakdown)[] = ['input', 'output', 'cacheRead', 'cacheWrite']
const CONFIDENCE_RANK: Record<Confidence, number> = { exact: 0, estimated: 1, inferred: 2 }
const CONFIDENCES: readonly Confidence[] = ['exact', 'estimated', 'inferred']

export const DAY_RULE =
  'UTC, start of event: occurredAt.slice(0,10). cost, tokens and responses are filed under the UTC day of the billed response; runs, messages, activeMinutes and tools under the UTC day the run STARTED. Same rule as the billing basis and tags (start_time.slice(0,10)).'

export const COST_BASIS = {
  basis: 'api' as const,
  meaning: 'API-equivalent spend: the provider\'s own figure where it stated one (costSource provider), the harness\'s own where it stated one (harness), otherwise the pricing table estimate (table).',
  planApplied: false,
  whyNoPlan: 'The plan basis (billing.ts) needs the user\'s registered plan timeline and re-expresses a whole window\'s spend against it; that is a presentation of this figure, applied by the surface that owns the timeline, never by a query that may be grouped by provider, run or day.',
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export interface MetricsQuery {
  from?: string
  to?: string
  /** `''` in a list names the unnamed bucket (a `null` provider/model/task/run, or repo/project `''`). */
  filters: Partial<Record<FilterDimension, string[]>>
  /** `true` = subagents only, `false` = main agents only. Cost facts only. */
  subagent?: boolean
  groupBy: GroupDimension[]
  metrics: MetricId[]
  limit: number
  /** The key of the last group already returned; the page starts strictly after it. */
  after?: (string | null)[]
}

export interface QueryRefusal {
  code: string
  param?: string
  value?: string
  sentence: string
}

export type ParseResult = { ok: true; query: MetricsQuery } | { ok: false; error: QueryRefusal }

const KNOWN_PARAMS = new Set<string>([
  'from', 'to', 'groupBy', 'metrics', 'cursor', 'limit', 'subagent',
  ...FILTER_DIMENSIONS, ...Object.keys(UNSUPPORTED_FILTERS),
])

function refuse(code: string, sentence: string, param?: string, value?: string): ParseResult {
  return { ok: false, error: { code, sentence, ...(param ? { param } : {}), ...(value !== undefined ? { value } : {}) } }
}

function validDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * Values of a list parameter. Repeated parameters and comma lists both work, EXCEPT for `project`,
 * whose values are paths and may legitimately contain a comma — there, only repetition separates.
 */
function listValues(params: URLSearchParams, name: string): string[] {
  const raw = params.getAll(name)
  if (name === 'project') return raw
  return raw.flatMap(v => v.split(','))
}

export function parseMetricsQuery(params: URLSearchParams): ParseResult {
  for (const key of new Set(params.keys())) {
    if (!KNOWN_PARAMS.has(key)) {
      return refuse('unknown_param', `"${key}" is not a parameter of this query; it would have been ignored, so it is refused.`, key)
    }
  }
  for (const [name, reason] of Object.entries(UNSUPPORTED_FILTERS)) {
    if (params.has(name)) return refuse('unsupported_filter', reason, name)
  }

  const single = (name: string): string | undefined => {
    const all = params.getAll(name)
    return all.length ? all[all.length - 1] : undefined
  }
  for (const name of ['from', 'to', 'limit', 'cursor', 'groupBy', 'metrics', 'subagent']) {
    if (params.getAll(name).length > 1) return refuse('repeated_param', `"${name}" was given more than once.`, name)
  }

  const from = single('from')
  const to = single('to')
  if (from !== undefined && !validDay(from)) return refuse('bad_date', 'from must be a UTC day, yyyy-MM-dd.', 'from', from)
  if (to !== undefined && !validDay(to)) return refuse('bad_date', 'to must be a UTC day, yyyy-MM-dd.', 'to', to)
  if (from !== undefined && to !== undefined && from > to) return refuse('bad_range', 'from is after to.', 'from', from)

  const filters: Partial<Record<FilterDimension, string[]>> = {}
  for (const dim of FILTER_DIMENSIONS) {
    if (!params.has(dim)) continue
    const values = [...new Set(listValues(params, dim))]
    if (values.length > MAX_FILTER_VALUES) {
      return refuse('too_many_values', `at most ${MAX_FILTER_VALUES} values per filter.`, dim)
    }
    for (const v of values) {
      if (dim === 'harness' && !KNOWN_HARNESSES.has(v)) {
        return refuse('unknown_harness', `"${v}" is not a harness this product knows (${HARNESS_ORDER.join(', ')}).`, dim, v)
      }
      if (dim === 'provider' && v !== '' && !(v in KNOWN_PROVIDERS)) {
        return refuse('unknown_provider', `"${v}" is not a provider id (${Object.keys(KNOWN_PROVIDERS).join(', ')}); an empty value selects rows that named no provider.`, dim, v)
      }
    }
    filters[dim] = values
  }

  let groupBy: GroupDimension[] = []
  const gb = single('groupBy')
  if (gb !== undefined && gb !== '') {
    const dims = gb.split(',')
    for (const d of dims) {
      if (!(GROUP_DIMENSIONS as readonly string[]).includes(d)) {
        return refuse('unknown_dimension', `"${d}" is not a group dimension (${GROUP_DIMENSIONS.join(', ')}).`, 'groupBy', d)
      }
    }
    if (new Set(dims).size !== dims.length) return refuse('duplicate_dimension', 'a dimension appears twice in groupBy.', 'groupBy', gb)
    if (dims.length > MAX_GROUP_BY) return refuse('too_many_dimensions', `at most ${MAX_GROUP_BY} group dimensions.`, 'groupBy', gb)
    groupBy = dims as GroupDimension[]
  }

  let metrics: MetricId[] = [...DEFAULT_METRICS]
  const ms = single('metrics')
  if (ms !== undefined) {
    const list = ms.split(',')
    if (ms === '' || list.some(m => m === '')) return refuse('empty_metrics', 'metrics names no metric.', 'metrics', ms)
    for (const m of list) {
      if (!(METRICS as readonly string[]).includes(m)) {
        return refuse('unknown_metric', `"${m}" is not a metric (${METRICS.join(', ')}).`, 'metrics', m)
      }
    }
    metrics = [...new Set(list)] as MetricId[]
  }

  let subagent: boolean | undefined
  const sa = single('subagent')
  if (sa !== undefined) {
    if (sa !== 'true' && sa !== 'false') return refuse('bad_boolean', 'subagent must be true or false.', 'subagent', sa)
    subagent = sa === 'true'
  }
  const costOnly = subagent !== undefined
    || groupBy.some(d => COST_ONLY_DIMENSIONS.includes(d))
    || Object.keys(filters).some(d => COST_ONLY_DIMENSIONS.includes(d))
  if (costOnly) {
    const bad = metrics.find(m => METRIC_STREAM[m] === 'run')
    if (bad) {
      return refuse('metric_dimension_mismatch', `"${bad}" is a per-run figure and cannot be split by agent; drop it, or drop the agent/subagent dimension.`, 'metrics', bad)
    }
  }

  let limit = DEFAULT_LIMIT
  const ls = single('limit')
  if (ls !== undefined) {
    if (!/^\d+$/.test(ls) || Number(ls) < 1) return refuse('bad_limit', 'limit must be a positive integer.', 'limit', ls)
    if (Number(ls) > MAX_LIMIT) return refuse('limit_too_large', `limit may not exceed ${MAX_LIMIT}; page with the cursor instead.`, 'limit', ls)
    limit = Number(ls)
  }

  const query: MetricsQuery = { ...(from ? { from } : {}), ...(to ? { to } : {}), filters, ...(subagent !== undefined ? { subagent } : {}), groupBy, metrics, limit }

  const cur = single('cursor')
  if (cur !== undefined) {
    const decoded = decodeCursor(cur)
    if (!decoded || decoded.k.length !== groupBy.length) {
      return refuse('bad_cursor', 'the cursor is not one this query issued.', 'cursor')
    }
    if (decoded.q !== queryFingerprint(query)) {
      return refuse('cursor_mismatch', 'the cursor belongs to a different query (filters, grouping, metrics or range changed); start again without it.', 'cursor')
    }
    query.after = decoded.k
  }
  return { ok: true, query }
}

// ---------------------------------------------------------------------------------------------
// Cursor — opaque, keyset, bound to the query it was issued for
// ---------------------------------------------------------------------------------------------

/** FNV-1a over the normalised query (limit excluded — a caller may change page size mid-walk). */
export function queryFingerprint(q: MetricsQuery): string {
  const norm = JSON.stringify({
    from: q.from ?? null,
    to: q.to ?? null,
    f: FILTER_DIMENSIONS.map(d => (q.filters[d] ? [...q.filters[d]!].sort() : null)),
    s: q.subagent ?? null,
    g: q.groupBy,
    m: [...q.metrics].sort(),
  })
  let h = 0x811c9dc5
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

export function encodeCursor(q: MetricsQuery, lastKey: (string | null)[]): string {
  return Buffer.from(JSON.stringify({ v: 1, q: queryFingerprint(q), k: lastKey }), 'utf8').toString('base64url')
}

function decodeCursor(s: string): { q: string; k: (string | null)[] } | null {
  try {
    const o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    if (!o || o.v !== 1 || typeof o.q !== 'string' || !Array.isArray(o.k)) return null
    if (!o.k.every((x: unknown) => x === null || typeof x === 'string')) return null
    return { q: o.q, k: o.k }
  } catch {
    return null
  }
}

/** Total order on key tuples: `null` sorts before any string, strings by code unit. */
export function compareKeys(a: (string | null)[], b: (string | null)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? null
    const y = b[i] ?? null
    if (x === y) continue
    if (x === null) return -1
    if (y === null) return 1
    return x < y ? -1 : 1
  }
  return 0
}

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------

type Fact = CostFact | RunFact

function dimValue(f: Fact, d: GroupDimension): string | null {
  switch (d) {
    case 'harness': return f.harness
    case 'provider': return f.provider
    case 'model': return f.model
    case 'repo': return f.repo
    case 'project': return f.project
    case 'task': return f.taskId
    case 'run': return f.runId
    case 'agent': return 'agentId' in f ? f.agentId : null
    case 'day': return f.day
  }
}

/**
 * A compiled filter: only the ACTIVE dimensions, each as a Set. `''` in a filter list matches the
 * unnamed bucket (a `null` provider/model/task/run, or repo/project `''`). Compiled once per query
 * because it runs once per fact — the hot loop over a 100k-session store (P3 §6).
 */
function compileFilter(q: MetricsQuery): (f: Fact) => boolean {
  const active = FILTER_DIMENSIONS
    .filter(d => q.filters[d])
    .map(d => [d, new Set(q.filters[d])] as const)
  const from = q.from
  const to = q.to
  const sub = q.subagent
  if (active.length === 0 && !from && !to && sub === undefined) return () => true
  return (f: Fact) => {
    if (sub !== undefined && (!('subagent' in f) || f.subagent !== sub)) return false
    for (const [d, allowed] of active) {
      if (!allowed.has(dimValue(f, d) ?? '')) return false
    }
    if (from && f.day < from) return false
    if (to && f.day > to) return false
    return true
  }
}

type CostSourceName = 'provider' | 'harness' | 'table' | 'mixed'

interface HarnessAcc {
  costRows: number
  costUsd: number
  pricedRows: number
  unpricedRows: number
  sources: Record<CostSourceName, number>
  tokens: Partial<TokenBreakdown>
  partialCounters: Set<keyof TokenBreakdown> | null
  partialCounterRows: number
  responses: number
  runRows: number
  messages: number
  messagesMeasured: number
  messagesUnmeasured: number
  activeMinutes: number
  activeMeasured: number
  activeUnmeasured: number
  /** Allocated on the first tool seen — a group per run makes 100k of these (P3 §6). */
  tools: Map<string, { calls: number; errors: number; durationMs: number; durationUnmeasuredRows: number; durationMeasuredRows: number; durationPartialRows: number }> | null
  unmeasuredAgents: number
}

function emptyHarnessAcc(): HarnessAcc {
  return {
    costRows: 0, costUsd: 0, pricedRows: 0, unpricedRows: 0,
    sources: { provider: 0, harness: 0, table: 0, mixed: 0 },
    tokens: {}, partialCounters: null, partialCounterRows: 0, responses: 0,
    runRows: 0, messages: 0, messagesMeasured: 0, messagesUnmeasured: 0,
    activeMinutes: 0, activeMeasured: 0, activeUnmeasured: 0,
    tools: null, unmeasuredAgents: 0,
  }
}

interface GroupAcc {
  key: (string | null)[]
  rows: number
  weakest: Confidence
  /** Only allocated when `sessions` / `runs` was asked for. */
  sessions: Set<string> | null
  runs: Set<string> | null
  /** The last id added — facts arrive clustered by session, so most adds are repeats of it. */
  lastSession: string | null
  lastRun: string | null
  byHarness: Map<RunHarness, HarnessAcc>
}

function harnessAcc(g: GroupAcc, h: RunHarness): HarnessAcc {
  let a = g.byHarness.get(h)
  if (!a) g.byHarness.set(h, a = emptyHarnessAcc())
  return a
}

function weaker(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a
}

function foldCost(a: HarnessAcc, f: CostFact): void {
  a.costRows++
  if (f.costUSD === null) a.unpricedRows++
  else {
    a.pricedRows++
    a.costUsd += f.costUSD
    if (f.costSource) a.sources[f.costSource]++
  }
  for (const k of TOKEN_KEYS) {
    const v = f.tokens[k]
    if (v !== undefined) a.tokens[k] = (a.tokens[k] ?? 0) + v
  }
  if (f.partialCounters.length) {
    a.partialCounterRows++
    const pc = a.partialCounters ?? (a.partialCounters = new Set())
    for (const k of f.partialCounters) pc.add(k)
  }
  a.responses += f.responses
}

function foldRun(a: HarnessAcc, f: RunFact): void {
  a.runRows++
  if (f.messages === null) a.messagesUnmeasured++
  else { a.messagesMeasured++; a.messages += f.messages }
  if (f.activeMinutes === null) a.activeUnmeasured++
  else { a.activeMeasured++; a.activeMinutes += f.activeMinutes }
  for (const name in f.tools) {
    const t = f.tools[name]!
    const tools = a.tools ?? (a.tools = new Map())
    let s = tools.get(name)
    if (!s) tools.set(name, s = { calls: 0, errors: 0, durationMs: 0, durationUnmeasuredRows: 0, durationMeasuredRows: 0, durationPartialRows: 0 })
    s.calls += t.calls
    s.errors += t.errors
    if (t.durationMs === null) s.durationUnmeasuredRows++
    else {
      s.durationMeasuredRows++
      s.durationMs += t.durationMs
      if (t.durationCalls !== undefined && t.durationCalls < t.calls) s.durationPartialRows++
    }
  }
  a.unmeasuredAgents += f.unmeasuredAgents
}

// ---------------------------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------------------------

export interface ExcludedHarness { harness: RunHarness; reason: string }
export interface AbsentMetric { reason: string; excluded: ExcludedHarness[] }

export interface CostCell {
  usd: number
  pricedRows: number
  /** Rows that could not be priced — left OUT of `usd`, never counted as 0. */
  unpricedRows: number
  /** `true` when some rows were unpriced, so `usd` is a floor. */
  partial: boolean
  sources: Record<CostSourceName, number>
  excluded?: ExcludedHarness[]
}
export interface TokensCell {
  /** `totalTokens` over the counters that were reported — all four counters, never two. */
  total: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  /** Counters no contributing row reported at all — absent, not zero. */
  absentCounters: (keyof TokenBreakdown)[]
  /** Counters some contributing row did not report — the sum is a floor. */
  partialCounters: (keyof TokenBreakdown)[]
  excluded?: ExcludedHarness[]
}
export interface CountCell { count: number; excluded?: ExcludedHarness[] }
export interface MeasuredSumCell { value: number; runsMeasured: number; runsUnmeasured: number; excluded?: ExcludedHarness[] }
export interface ToolRow {
  name: string
  calls: number
  errors: number
  durationMs: number | null
  durationUnmeasuredRows: number
  /** `true` when some calls carry no duration (a run with none, or `durationCalls < calls`): a floor. */
  durationPartial: boolean
}
export interface ToolsCell {
  /** Ordered by measured duration (desc, unmeasured last), then calls, then name. */
  byTool: ToolRow[]
  calls: number
  /** `null` when no tool call in the group carried a duration. */
  durationMs: number | null
  excluded?: ExcludedHarness[]
}

export interface MetricsGroup {
  key: Partial<Record<GroupDimension, string | null>>
  /** Rows (facts) that passed the filters into this group. */
  rows: number
  /** The WEAKEST confidence of those rows (D17). */
  confidence: Confidence
  metrics: {
    cost?: CostCell
    tokens?: TokensCell
    responses?: CountCell
    sessions?: CountCell
    runs?: CountCell
    messages?: MeasuredSumCell
    activeMinutes?: MeasuredSumCell
    tools?: ToolsCell
  }
  /** Requested metrics this group cannot answer, each with the reason. Never rendered as 0. */
  absent: Partial<Record<MetricId, AbsentMetric>>
}

export interface ProjectionFreshness {
  cursor: number
  journalHead: number
  /** Journal rows not yet folded into the projections. */
  lag: number
  rebuilding: boolean
  fresh: boolean
  versions: Record<string, number>
}

export interface MetricsBasis {
  dayRule: string
  costBasis: typeof COST_BASIS
  capabilities: string
  confidence: {
    rows: number
    exact: { count: number; share: number }
    estimated: { count: number; share: number }
    inferred: { count: number; share: number }
    /** The weakest confidence of any contributing row; `null` when no row matched. */
    weakest: Confidence | null
  }
  unmeasured: {
    /** Cost rows with no price (no rate, or a subscription with no marginal price). */
    unpricedCostRows: number
    /** Cost rows where at least one token counter was not reported by every response. */
    partialCounterRows: number
    /** Agent invocations whose transcript was missing (excluded from the run's totals). */
    unmeasuredAgents: number
    runsWithoutMessages: number
    runsWithoutActiveMinutes: number
    /** Per-run tool entries whose duration was not recorded. */
    toolEntriesWithoutDuration: number
    /** Per-run tool entries whose duration covers fewer calls than were made (`durationCalls`). */
    toolEntriesWithPartialDuration: number
    /** Rows left out of a gated metric because their harness cannot produce it. */
    capabilityExcludedRows: number
  }
  freshness: ProjectionFreshness
  /** Set when an agent dimension is active: the run stream was not read, and sessions/runs count cost facts only. */
  attribution?: string
}

export interface MetricsResponse {
  query: {
    from: string | null
    to: string | null
    filters: Partial<Record<FilterDimension, string[]>>
    subagent: boolean | null
    groupBy: GroupDimension[]
    metrics: MetricId[]
  }
  groups: MetricsGroup[]
  page: { limit: number; returned: number; totalGroups: number; nextCursor: string | null }
  basis: MetricsBasis
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

export type CapabilityTable = Record<HarnessId, Record<CapabilityMetric, CapabilityState>>

function capabilityCheck(caps: CapabilityTable, h: RunHarness, metric: MetricId): { ok: true } | { ok: false; reason: string } {
  const cap = METRIC_CAPABILITY[metric]
  if (!cap) return { ok: true }
  // `'agentistics'` (the native runtime) is not a key of the capability table yet: it is then stated
  // absent-with-reason, never guessed capable and never 0.
  const state = (caps as Partial<Record<RunHarness, Record<CapabilityMetric, CapabilityState>>>)[h]?.[cap]
  if (!state) return { ok: false, reason: `unknown: no capability recorded for ${h}.${cap}` }
  if (capabilitySupported(state)) return { ok: true }
  return { ok: false, reason: `${state.state}: ${capabilityReason(state) ?? cap}` }
}

function share(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 10000) / 10000
}

/**
 * Split a group's harnesses (those with rows in the metric's stream) into capable and excluded.
 * `stream` rows only: a harness that has run facts but no cost facts is not "excluded from cost",
 * it simply contributed nothing to it.
 */
function partition(caps: CapabilityTable, g: GroupAcc, metric: MetricId): { capable: [RunHarness, HarnessAcc][]; excluded: ExcludedHarness[]; excludedRows: number } {
  const stream = METRIC_STREAM[metric]
  const capable: [RunHarness, HarnessAcc][] = []
  const excluded: ExcludedHarness[] = []
  let excludedRows = 0
  for (const h of RUN_HARNESS_ORDER) {
    const a = g.byHarness.get(h)
    if (!a) continue
    const rows = stream === 'cost' ? a.costRows : stream === 'run' ? a.runRows : a.costRows + a.runRows
    if (rows === 0) continue
    const c = capabilityCheck(caps, h, metric)
    if (c.ok) capable.push([h, a])
    else { excluded.push({ harness: h, reason: c.reason }); excludedRows += rows }
  }
  return { capable, excluded, excludedRows }
}

function withExcluded<T extends object>(cell: T, excluded: ExcludedHarness[]): T {
  return excluded.length ? { ...cell, excluded } : cell
}

function finishGroup(caps: CapabilityTable, g: GroupAcc, q: MetricsQuery): MetricsGroup {
  const key: Partial<Record<GroupDimension, string | null>> = {}
  q.groupBy.forEach((d, i) => { key[d] = g.key[i] })
  const out: MetricsGroup = { key, rows: g.rows, confidence: g.weakest, metrics: {}, absent: {} }

  for (const m of q.metrics) {
    if (m === 'sessions') { out.metrics.sessions = { count: g.sessions!.size }; continue }
    if (m === 'runs') { if (g.runs) out.metrics.runs = { count: g.runs.size }; continue }

    const { capable, excluded } = partition(caps, g, m)
    if (capable.length === 0) {
      out.absent[m] = {
        reason: excluded.length
          ? 'no harness in this group can produce this metric'
          : (METRIC_STREAM[m] === 'cost' ? 'no billed response was recorded in this group' : 'no run was recorded in this group'),
        excluded,
      }
      continue
    }
    const accs = capable.map(([, a]) => a)

    if (m === 'cost') {
      const priced = accs.reduce((s, a) => s + a.pricedRows, 0)
      const unpriced = accs.reduce((s, a) => s + a.unpricedRows, 0)
      if (priced === 0) {
        out.absent.cost = { reason: `none of the ${unpriced} cost row(s) could be priced (no rate, or a subscription with no marginal price)`, excluded }
        continue
      }
      const sources: Record<CostSourceName, number> = { provider: 0, harness: 0, table: 0, mixed: 0 }
      for (const a of accs) for (const k of Object.keys(sources) as CostSourceName[]) sources[k] += a.sources[k]
      out.metrics.cost = withExcluded({
        usd: accs.reduce((s, a) => s + a.costUsd, 0),
        pricedRows: priced,
        unpricedRows: unpriced,
        partial: unpriced > 0,
        sources,
      }, excluded)
    } else if (m === 'tokens') {
      const sum: Partial<TokenBreakdown> = {}
      const partial = new Set<keyof TokenBreakdown>()
      for (const a of accs) {
        for (const k of TOKEN_KEYS) if (a.tokens[k] !== undefined) sum[k] = (sum[k] ?? 0) + a.tokens[k]!
        if (a.partialCounters) for (const k of a.partialCounters) partial.add(k)
      }
      const absentCounters = TOKEN_KEYS.filter(k => sum[k] === undefined)
      if (absentCounters.length === TOKEN_KEYS.length) {
        out.absent.tokens = { reason: 'no contributing row reported any token counter', excluded }
        continue
      }
      const full: TokenBreakdown = { input: sum.input ?? 0, output: sum.output ?? 0, cacheRead: sum.cacheRead ?? 0, cacheWrite: sum.cacheWrite ?? 0 }
      out.metrics.tokens = withExcluded({
        total: totalTokens(full),
        ...sum,
        absentCounters,
        partialCounters: TOKEN_KEYS.filter(k => partial.has(k)),
      }, excluded)
    } else if (m === 'responses') {
      out.metrics.responses = withExcluded({ count: accs.reduce((s, a) => s + a.responses, 0) }, excluded)
    } else if (m === 'messages' || m === 'activeMinutes') {
      const measured = accs.reduce((s, a) => s + (m === 'messages' ? a.messagesMeasured : a.activeMeasured), 0)
      const unmeasured = accs.reduce((s, a) => s + (m === 'messages' ? a.messagesUnmeasured : a.activeUnmeasured), 0)
      if (measured === 0) {
        out.absent[m] = { reason: `none of the ${unmeasured} run(s) recorded this figure`, excluded }
        continue
      }
      out.metrics[m] = withExcluded({
        value: accs.reduce((s, a) => s + (m === 'messages' ? a.messages : a.activeMinutes), 0),
        runsMeasured: measured,
        runsUnmeasured: unmeasured,
      }, excluded)
    } else if (m === 'tools') {
      const merged = new Map<string, { calls: number; errors: number; durationMs: number; durationUnmeasuredRows: number; durationMeasuredRows: number; durationPartialRows: number }>()
      for (const a of accs) {
        if (a.tools) for (const [name, t] of a.tools) {
          let s = merged.get(name)
          if (!s) merged.set(name, s = { calls: 0, errors: 0, durationMs: 0, durationUnmeasuredRows: 0, durationMeasuredRows: 0, durationPartialRows: 0 })
          s.calls += t.calls
          s.errors += t.errors
          s.durationMs += t.durationMs
          s.durationUnmeasuredRows += t.durationUnmeasuredRows
          s.durationMeasuredRows += t.durationMeasuredRows
          s.durationPartialRows += t.durationPartialRows
        }
      }
      const byTool: ToolRow[] = [...merged].map(([name, s]) => ({
        name,
        calls: s.calls,
        errors: s.errors,
        durationMs: s.durationMeasuredRows > 0 ? s.durationMs : null,
        durationUnmeasuredRows: s.durationUnmeasuredRows,
        durationPartial: s.durationUnmeasuredRows > 0 || s.durationPartialRows > 0,
      }))
      byTool.sort((a, b) => {
        if (a.durationMs !== b.durationMs) {
          if (a.durationMs === null) return 1
          if (b.durationMs === null) return -1
          return b.durationMs - a.durationMs
        }
        if (a.calls !== b.calls) return b.calls - a.calls
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      })
      const anyDuration = byTool.some(t => t.durationMs !== null)
      out.metrics.tools = withExcluded({
        byTool,
        calls: byTool.reduce((s, t) => s + t.calls, 0),
        durationMs: anyDuration ? byTool.reduce((s, t) => s + (t.durationMs ?? 0), 0) : null,
      }, excluded)
    }
  }
  return out
}

/**
 * Run the query. Streams only the fact kinds the requested metrics need, filters, groups, and
 * returns ONE page. The whole filtered set is aggregated to compute a stable ordering and the
 * basis; only the page's groups are finished and returned.
 */
export async function runMetricsQuery(
  reader: ProjectionReader,
  q: MetricsQuery,
  /** The capability table; injectable so the absent-with-reason path is testable. */
  caps: CapabilityTable = CAPABILITY_STATES,
): Promise<MetricsResponse> {
  const streams = new Set(q.metrics.map(m => METRIC_STREAM[m]))
  const readCost = streams.has('cost') || streams.has('both')
  const costOnly = q.subagent !== undefined
    || q.groupBy.some(d => COST_ONLY_DIMENSIONS.includes(d))
    || Object.keys(q.filters).some(d => COST_ONLY_DIMENSIONS.includes(d))
  const readRun = !costOnly && (streams.has('run') || streams.has('both'))
  const range = { ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) }

  const groups = new Map<string, GroupAcc>()
  const conf: Record<Confidence, number> = { exact: 0, estimated: 0, inferred: 0 }
  const un = { unpricedCostRows: 0, partialCounterRows: 0, unmeasuredAgents: 0, runsWithoutMessages: 0, runsWithoutActiveMinutes: 0, toolEntriesWithoutDuration: 0, toolEntriesWithPartialDuration: 0 }
  const dims = q.groupBy

  const wantSessions = q.metrics.includes('sessions')
  // Grouped BY run, every group is one run (or the no-run bucket): the count needs no set.
  const runsByKey = dims.includes('run')
  const wantRuns = q.metrics.includes('runs') && !runsByKey
  const passes = compileFilter(q)
  // The group id: cheap string keys for the hot loop (NUL never occurs in an id, model, repo, path
  // or day; SOH stands for null). The key TUPLE is kept beside it for ordering and the cursor.
  const idOf = (key: (string | null)[]): string =>
    key.length === 0 ? '' : key.length === 1 ? (key[0] ?? '\u0001') : key.map(v => (v === null ? '\u0001' : v)).join('\u0000')

  const groupOf = (f: Fact): GroupAcc => {
    const key = dims.length === 0 ? [] : dims.map(d => dimValue(f, d))
    const id = idOf(key)
    let g = groups.get(id)
    if (!g) {
      g = {
        key, rows: 0, weakest: 'exact',
        sessions: wantSessions ? new Set() : null,
        runs: wantRuns ? new Set() : null,
        lastSession: null,
        lastRun: null,
        byHarness: new Map(),
      }
      groups.set(id, g)
    }
    g.rows++
    if (f.confidence !== 'exact') g.weakest = weaker(g.weakest, f.confidence)
    if (g.sessions && f.sessionId !== g.lastSession) { g.sessions.add(f.sessionId); g.lastSession = f.sessionId }
    if (g.runs && f.runId !== null && f.runId !== g.lastRun) { g.runs.add(f.runId); g.lastRun = f.runId }
    conf[f.confidence]++
    return g
  }

  if (readCost) {
    for await (const f of reader.costFacts(range)) {
      if (!passes(f)) continue
      foldCost(harnessAcc(groupOf(f), f.harness), f)
      if (f.costUSD === null) un.unpricedCostRows++
      if (f.partialCounters.length) un.partialCounterRows++
    }
  }
  if (readRun) {
    for await (const f of reader.runFacts(range)) {
      if (!passes(f)) continue
      foldRun(harnessAcc(groupOf(f), f.harness), f)
      un.unmeasuredAgents += f.unmeasuredAgents
      if (f.messages === null) un.runsWithoutMessages++
      if (f.activeMinutes === null) un.runsWithoutActiveMinutes++
      for (const name in f.tools) {
        const t = f.tools[name]!
        if (t.durationMs === null) un.toolEntriesWithoutDuration++
        else if (t.durationCalls !== undefined && t.durationCalls < t.calls) un.toolEntriesWithPartialDuration++
      }
    }
  }

  const ordered = [...groups.values()].sort((a, b) => compareKeys(a.key, b.key))
  const start = q.after ? ordered.findIndex(g => compareKeys(g.key, q.after!) > 0) : 0
  const from = start === -1 ? ordered.length : start
  const pageAccs = ordered.slice(from, from + q.limit)
  const hasMore = from + pageAccs.length < ordered.length

  // Excluded rows are tallied over the WHOLE filtered set, not just this page, so the basis is the
  // same on every page of one query.
  const tally = { capabilityExcludedRows: 0 }
  for (const g of ordered) {
    for (const m of q.metrics) {
      if (m === 'sessions' || m === 'runs') continue
      tally.capabilityExcludedRows += partition(caps, g, m).excludedRows
    }
  }
  const runIdx = dims.indexOf('run')
  const pageGroups = pageAccs.map(g => {
    const out = finishGroup(caps, g, q)
    if (runsByKey && q.metrics.includes('runs')) out.metrics.runs = { count: g.key[runIdx] === null ? 0 : 1 }
    return out
  })

  const rows = conf.exact + conf.estimated + conf.inferred
  const weakest = rows === 0 ? null : CONFIDENCES.slice().reverse().find(c => conf[c] > 0) ?? null
  const status = await reader.status()
  const lag = Math.max(0, status.journalHead - status.cursor)

  return {
    query: {
      from: q.from ?? null,
      to: q.to ?? null,
      filters: q.filters,
      subagent: q.subagent ?? null,
      groupBy: q.groupBy,
      metrics: q.metrics,
    },
    groups: pageGroups,
    page: {
      limit: q.limit,
      returned: pageGroups.length,
      totalGroups: ordered.length,
      nextCursor: hasMore ? encodeCursor(q, pageAccs[pageAccs.length - 1]!.key) : null,
    },
    basis: {
      dayRule: DAY_RULE,
      costBasis: COST_BASIS,
      capabilities: 'Canonical capability table (CAPABILITY_STATES). A metric a harness cannot produce is absent from its group with the reason; in a mixed group only the capable harnesses are summed and the others are listed as excluded. sessions/runs/responses/messages exist for every harness.',
      confidence: {
        rows,
        exact: { count: conf.exact, share: share(conf.exact, rows) },
        estimated: { count: conf.estimated, share: share(conf.estimated, rows) },
        inferred: { count: conf.inferred, share: share(conf.inferred, rows) },
        weakest,
      },
      unmeasured: { ...un, capabilityExcludedRows: tally.capabilityExcludedRows },
      ...(costOnly ? { attribution: 'An agent dimension (agent / subagent) is active: only cost facts carry an agent, so the run stream was not read and sessions/runs count the sessions and runs that have billed responses from the selected agents.' } : {}),
      freshness: {
        cursor: status.cursor,
        journalHead: status.journalHead,
        lag,
        rebuilding: status.rebuilding,
        fresh: lag === 0 && !status.rebuilding,
        versions: status.versions,
      },
    },
  }
}
