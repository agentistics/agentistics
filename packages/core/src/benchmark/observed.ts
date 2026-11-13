/**
 * Observed history: numbers only, never a verdict (the `Observed` type has no such field, and this
 * module imports nothing from verdict.ts). Hard work goes to the heavy path, so these figures are
 * biased by construction; the label says so. Only formulas the analysis marked reliable are here.
 *
 * Rules that decide every figure:
 *  - A delivery whose phase history was never recorded has NO stage time and NO QA outcome. The metric
 *    builder gives such an item an all-zero stage record and a `pending` QA result; neither is a
 *    measurement, so those figures are computed over `historyKnown` deliveries only and the rest is a
 *    named gap.
 *  - Abandoned work is not a delivery. It is in `items` only so its sessions can be counted as wasted cost.
 *  - Every figure carries n, a 95% interval of its own sample, the gaps that kept records out, and an origin.
 */
import { filterMetricItems, percentile, type MetricFilters, type MetricItem } from '../deliveryMetrics'
import type { Covered, Gap, GapCode, Interval, Observed, Priced, SessionRole } from './contract'
import { bootstrapInterval, poissonScoreInterval, wilsonInterval } from './interval'

export interface ObservedSession {
  id: string
  /** The delivery (subtask) it is filed under; null = not linked. */
  subtaskId: string | null
  harness: string
  role: SessionRole
  cost: Priced
  /** Dead, abandoned or discarded work: still cost, produced no delivery. */
  wasted?: boolean
  /** Tokens stored for the session (coverage only). */
  hasTokens?: boolean
}

export interface ObservedInput {
  items: readonly MetricItem[]
  sessions: readonly ObservedSession[]
  /** Subtask ids whose phase history exists. Required: "all of them" is not a safe default. */
  historyKnown: ReadonlySet<string>
  /** Subtask ids whose phase history covers the WHOLE working span (born in the flow, or otherwise shown complete).
   *  A history that starts mid-way (an adopted piece) is not complete: active time is a named gap for it. Absent = same as `historyKnown`. */
  historyComplete?: ReadonlySet<string>
  /** Subtask ids whose lead time starts at the request (subtask creation) because the record was only adopted later. */
  requestStart?: ReadonlySet<string>
  /** Subtask ids the board marks abandoned. Absent = nobody says which work was abandoned (wasted cost is then not measured). */
  abandoned?: ReadonlySet<string>
  filters?: MetricFilters
  period?: { from: string | null; to: string | null }
  /** Subtask ids whose QA verdict / escape link exist as structured data. Absent = nothing is structured. */
  structured?: { qaVerdict: ReadonlySet<string>; escapedLink: ReadonlySet<string> }
  /** Published deliveries that a later fix/revert/reopen points back to. null = the link is not recorded at all. */
  escaped?: ReadonlySet<string> | null
}

const MAX_RANGE_WIDTH = 0.5
const WEEK_MS = 7 * 24 * 3600 * 1000
const ACTIVE_BUCKETS = ['running', 'qa', 'adjust', 'leader', 'merge', 'ci'] as const
const SOURCES = ['tasks.json (subtasks)', 'deliveries.json (phase history)', 'managed-sessions.json (sessions)', 'sessions store (tokens)']

const gap = (code: GapCode, count: number): Gap[] => (count > 0 ? [{ code, count }] : [])
const median = (v: number[]) => percentile(v, 0.5)
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null)

function cov<T>(value: T | null, interval: Interval | null, n: number, total: number, missing: string[], gaps: Gap[], formula: string): Covered<T> {
  return { value, interval, gaps, n, covered: n, total, missing, formula, origin: {
    records: SOURCES, formula, n, coverage: `${n} of ${total} records measured`,
  } }
}

export function buildObserved(input: ObservedInput): Observed {
  const scoped = input.filters ? filterMetricItems(input.items, input.filters) : [...input.items]
  const abandonedIds = input.abandoned ?? new Set<string>()
  const items = scoped.filter(i => !abandonedIds.has(i.subtaskId))
  const ids = new Set(scoped.map(i => i.subtaskId))
  const sessions = input.sessions.filter(s => s.subtaskId === null || ids.has(s.subtaskId))
  const linked = sessions.filter(s => s.subtaskId !== null)
  const isWasted = (s: ObservedSession) => !!s.wasted || (s.subtaskId !== null && abandonedIds.has(s.subtaskId))
  const withHistory = items.filter(i => input.historyKnown.has(i.subtaskId))
  const noHistoryIds = items.filter(i => !input.historyKnown.has(i.subtaskId)).map(i => i.subtaskId)

  // coverage per harness: a harness with nothing priced is listed, not dropped
  const coverage: Observed['coverage'] = {}
  for (const s of sessions) {
    const c: Observed['coverage'][string] = coverage[s.harness] ?? { sessions: 0, withCost: 0, withTokens: 0, withRole: 0, withLink: 0, status: 'measured', reason: null }
    c.sessions++
    if (s.cost.costUSD !== null) c.withCost++
    if (s.hasTokens ?? s.cost.missing !== 'tokens') c.withTokens++
    if (s.role !== 'unknown') c.withRole++
    if (s.subtaskId !== null) c.withLink++
    c.status = c.withCost === c.sessions && c.withTokens === c.sessions ? 'measured' : 'not measured'
    c.reason = c.status === 'not measured'
      ? `confirmed cost/tokens for ${c.withCost} of ${c.sessions} sessions`
      : null
    coverage[s.harness] = c
  }

  // cost per delivery: only deliveries whose every filed session is priced
  const byDelivery = new Map<string, ObservedSession[]>()
  for (const s of linked) byDelivery.set(s.subtaskId!, [...(byDelivery.get(s.subtaskId!) ?? []), s])
  const priced: number[] = []
  const unpriced: string[] = []
  let noSessions = 0, unpricedNoPrice = 0, unpricedNoTokens = 0
  for (const it of items) {
    const ss = byDelivery.get(it.subtaskId)
    if (!ss?.length) { noSessions++; continue }
    const bad = ss.filter(s => s.cost.costUSD === null)
    if (bad.length) {
      unpriced.push(it.subtaskId)
      // the cause that blocks it: a missing price is reported ahead of absent tokens
      if (bad.some(s => s.cost.missing === 'price')) unpricedNoPrice++; else unpricedNoTokens++
      continue
    }
    priced.push(ss.reduce((a, s) => a + s.cost.costUSD!, 0))
  }
  const costPerDelivery = cov(mean(priced), bootstrapInterval(priced, v => mean(v)), priced.length, items.length, unpriced,
    [...gap('no_sessions', noSessions), ...gap('no_price', unpricedNoPrice), ...gap('no_tokens', unpricedNoTokens)],
    'mean over deliveries of Σ session cost (table×tokens); deliveries with an unpriced or absent session are left out')

  const published = items.filter(i => i.publishedAtMs !== null)
  const leads = published.map(i => i.leadMs).filter((x): x is number => x !== null)
  const wallMedian = cov(median(leads), bootstrapInterval(leads, median), leads.length, published.length,
    published.filter(i => i.leadMs === null).map(i => i.subtaskId), [],
    'median of lead time, published deliveries: from queue entry for records born in the flow; from the subtask creation (the request) for records the flow only adopted later')
  const adoptedLeads = published.filter(i => input.requestStart?.has(i.subtaskId) && i.leadMs !== null).length
  wallMedian.origin.coverage = `${wallMedian.n} of ${wallMedian.total} records measured · ${adoptedLeads} adopted records start at the subtask creation`

  const completeIds = input.historyComplete ?? input.historyKnown
  const publishedWithHistory = published.filter(i => completeIds.has(i.subtaskId))
  const publishedIncomplete = published.filter(i => input.historyKnown.has(i.subtaskId) && !completeIds.has(i.subtaskId)).length
  // A history that shows no time in any working stage (a piece adopted already finished, a release declared the
  // instant it was adopted) did not measure the work: its zero is "not looked at", not "took no time".
  const activeOf = (i: MetricItem) => ACTIVE_BUCKETS.reduce((a, b) => a + i.stageMs[b], 0)
  const activeItems = publishedWithHistory.filter(i => activeOf(i) > 0)
  const actives = activeItems.map(activeOf)
  const activeMedian = cov(median(actives), bootstrapInterval(actives, median), actives.length, published.length,
    published.filter(i => !activeItems.includes(i)).map(i => i.subtaskId),
    [...gap('no_phase_history', published.length - publishedWithHistory.length - publishedIncomplete), ...gap('incomplete_history', publishedIncomplete), ...gap('no_active_stage', publishedWithHistory.length - activeItems.length)],
    'median of time in running + qa + adjust + leader + merge + ci, published deliveries whose phase history is complete (born in the flow) and shows time in a working stage; adopted pieces are a named gap')

  // coordination share: a RANGE. lo = leader sessions only; hi = leader + sessions with no role.
  const pricedLinked = linked.filter(s => s.cost.costUSD !== null)
  const sum = (f: (s: ObservedSession) => boolean) => pricedLinked.filter(f).reduce((a, s) => a + s.cost.costUSD!, 0)
  const allCost = sum(() => true)
  const rawRange = allCost > 0
    ? { lo: sum(s => s.role === 'leader') / allCost, hi: sum(s => s.role === 'leader' || s.role === 'unknown') / allCost }
    : { lo: null, hi: null }
  // A range wider than half the scale says nothing (most cost has no recorded role): it is withheld, not drawn.
  const tooWide = rawRange.lo !== null && rawRange.hi !== null && rawRange.hi - rawRange.lo > MAX_RANGE_WIDTH
  const coordinationShareRange = tooWide ? { lo: null, hi: null } : rawRange
  const unpricedIds = linked.filter(s => s.cost.costUSD === null).map(s => s.id)
  const roleUnknownSessions = linked.filter(s => s.role === 'unknown').length
  const coordinationShare = cov<number>(null,
    coordinationShareRange.lo !== null && coordinationShareRange.hi !== null ? { lo: coordinationShareRange.lo, hi: coordinationShareRange.hi, level: 0.95, method: 'range' } : null,
    pricedLinked.length, linked.length, unpricedIds,
    [...gap('no_price', linked.filter(s => s.cost.costUSD === null && s.cost.missing === 'price').length), ...gap('no_tokens', linked.filter(s => s.cost.costUSD === null && s.cost.missing !== 'price').length), ...gap(tooWide ? 'role_range_too_wide' : 'role_unknown', roleUnknownSessions)],
    'a range, never a point: leader cost ÷ total cost (lower end) up to (leader + role-unknown) ÷ total (upper end); withheld when wider than 50 points')

  // QA: only deliveries with a recorded phase history can have an outcome; "never left QA" is not a rejection.
  const decided = withHistory.filter(i => i.qaResult !== 'pending')
  const rejected = decided.filter(i => i.qaResult === 'rejected_once' || i.qaResult === 'rejected_many')
  const qaGaps = [...gap('no_phase_history', noHistoryIds.length), ...gap('no_qa_stage', withHistory.length - decided.length)]
  const qaMissing = items.filter(i => !decided.includes(i)).map(i => i.subtaskId)
  const qaFirstRoundRejection = cov(decided.length ? rejected.length / decided.length : null, wilsonInterval(rejected.length, decided.length), decided.length, items.length,
    qaMissing, qaGaps, 'deliveries sent back by QA at least once ÷ deliveries whose phase history shows QA decided')
  const rounds = decided.map(i => i.qaRejections + 1)
  const qaRoundsMedian = cov(median(rounds), bootstrapInterval(rounds, median), rounds.length, items.length, qaMissing, qaGaps,
    'median of (QA rejections + 1) over deliveries whose phase history shows QA decided')

  const escapedDefectRate = input.escaped
    ? cov(published.length ? published.filter(i => input.escaped!.has(i.subtaskId)).length / published.length : null,
      wilsonInterval(published.filter(i => input.escaped!.has(i.subtaskId)).length, published.length), published.length, published.length, [], [],
      'published deliveries that a later fix, revert or reopen links back to ÷ published deliveries')
    : cov<number>(null, null, 0, published.length, published.map(i => i.subtaskId), gap('escape_links_not_recorded', published.length), 'escape links are not recorded')

  const wasteTracked = input.abandoned !== undefined
  const wastedSessions = pricedLinked.filter(isWasted)
  const wastedCost = wastedSessions.reduce((a, s) => a + s.cost.costUSD!, 0)
  const wastedInterval = wasteTracked && allCost > 0
    ? bootstrapInterval(pricedLinked.map((_, k) => k), idx => {
      let w = 0, t = 0
      for (const k of idx) { const s = pricedLinked[k]!; t += s.cost.costUSD!; if (isWasted(s)) w += s.cost.costUSD! }
      return t > 0 ? w / t : null
    })
    : null
  const wastedCostShare = wasteTracked
    ? cov(allCost > 0 ? wastedCost / allCost : null, wastedInterval, pricedLinked.length, linked.length, unpricedIds,
      [...gap('no_price', linked.filter(s => s.cost.costUSD === null && s.cost.missing === 'price').length), ...gap('no_tokens', linked.filter(s => s.cost.costUSD === null && s.cost.missing !== 'price').length)],
      'cost of sessions filed under abandoned work ÷ total cost, priced sessions only')
    : cov<number>(null, null, 0, linked.length, linked.map(s => s.id), gap('waste_not_tracked', linked.length), 'which work was abandoned is not recorded')

  const from = input.period?.from ?? null, to = input.period?.to ?? null
  const span = items.length ? Math.max(...items.map(i => i.refMs)) - Math.min(...items.map(i => i.refMs)) : 0
  const weeks = input.filters?.fromMs !== undefined && input.filters?.toMs !== undefined ? (input.filters.toMs - input.filters.fromMs) / WEEK_MS : span / WEEK_MS
  const throughputPerWeek = cov(weeks > 0 ? published.length / weeks : null, weeks > 0 ? poissonScoreInterval(published.length, weeks) : null, published.length, items.length,
    items.filter(i => i.publishedAtMs === null).map(i => i.subtaskId), gap('not_published', items.length - published.length),
    'published deliveries ÷ weeks in the period')

  const st = input.structured
  return {
    label: 'observed-biased',
    period: { from, to },
    deliveries: items.length,
    scope: {
      published: published.length, open: items.length - published.length, withPhaseHistory: withHistory.length,
      abandonedWithSessions: new Set(linked.filter(s => abandonedIds.has(s.subtaskId!)).map(s => s.subtaskId)).size,
      sinceMs: (() => { const t = items.map(i => i.refMs).filter(v => v > 0); return t.length ? Math.min(...t) : null })(),
    },
    metrics: { costPerDelivery, wallMedian, activeMedian, coordinationShare, qaFirstRoundRejection, qaRoundsMedian, escapedDefectRate, wastedCostShare, throughputPerWeek },
    coordinationShareRange,
    roleUnknownSessions,
    coverage,
    notStructured: {
      qaVerdict: st ? items.filter(i => !st.qaVerdict.has(i.subtaskId)).length : items.length,
      escapedLink: st ? items.filter(i => !st.escapedLink.has(i.subtaskId)).length : items.length,
    },
  }
}
