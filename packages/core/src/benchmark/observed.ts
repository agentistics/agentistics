/**
 * Observed history: numbers only, never a verdict (the `Observed` type has no such field, and this
 * module imports nothing from verdict.ts). Hard work goes to the heavy path, so these figures are
 * biased by construction; the label says so. Only formulas the analysis marked reliable are here.
 */
import { filterMetricItems, percentile, type MetricFilters, type MetricItem } from '../deliveryMetrics'
import type { Covered, Observed, Priced, SessionRole } from './contract'

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
  filters?: MetricFilters
  period?: { from: string | null; to: string | null }
  /** Subtask ids whose QA verdict / escape link exist as structured data. Absent = nothing is structured. */
  structured?: { qaVerdict: ReadonlySet<string>; escapedLink: ReadonlySet<string> }
  /** Published deliveries that a later fix/revert/reopen points back to. null = the link is not recorded at all. */
  escaped?: ReadonlySet<string> | null
}

const WEEK_MS = 7 * 24 * 3600 * 1000
const ACTIVE_BUCKETS = ['running', 'qa', 'adjust', 'leader', 'merge', 'ci'] as const

const cov = <T,>(value: T | null, n: number, total: number, missing: string[], formula: string): Covered<T> =>
  ({ value, n, covered: n, total, missing, formula })

export function buildObserved(input: ObservedInput): Observed {
  const items = input.filters ? filterMetricItems(input.items, input.filters) : [...input.items]
  const ids = new Set(items.map(i => i.subtaskId))
  const sessions = input.sessions.filter(s => s.subtaskId === null || ids.has(s.subtaskId))
  const linked = sessions.filter(s => s.subtaskId !== null)

  // coverage per harness: a harness with nothing priced is listed, not dropped
  const coverage: Observed['coverage'] = {}
  for (const s of sessions) {
    const c = coverage[s.harness] ?? { sessions: 0, withCost: 0, withTokens: 0, withRole: 0, withLink: 0 }
    c.sessions++
    if (s.cost.costUSD !== null) c.withCost++
    if (s.hasTokens ?? s.cost.missing !== 'tokens') c.withTokens++
    if (s.role !== 'unknown') c.withRole++
    if (s.subtaskId !== null) c.withLink++
    coverage[s.harness] = c
  }

  // cost per delivery: only deliveries whose every filed session is priced
  const byDelivery = new Map<string, ObservedSession[]>()
  for (const s of linked) byDelivery.set(s.subtaskId!, [...(byDelivery.get(s.subtaskId!) ?? []), s])
  const priced: number[] = []
  const unpriced: string[] = []
  for (const it of items) {
    const ss = byDelivery.get(it.subtaskId)
    if (!ss?.length) continue
    if (ss.some(s => s.cost.costUSD === null)) { unpriced.push(it.subtaskId); continue }
    priced.push(ss.reduce((a, s) => a + s.cost.costUSD!, 0))
  }
  const costPerDelivery = cov(priced.length ? priced.reduce((a, b) => a + b, 0) / priced.length : null, priced.length, priced.length + unpriced.length, unpriced,
    'mean over deliveries of Σ session cost (table×tokens); deliveries with an unpriced session are left out')

  const leads = items.map(i => i.leadMs).filter((x): x is number => x !== null)
  const wallMedian = cov(percentile(leads, 0.5), leads.length, items.length, items.filter(i => i.leadMs === null).map(i => i.subtaskId),
    'median of lead time (request or queue entry → published)')
  const actives = items.filter(i => i.publishedAtMs !== null).map(i => ACTIVE_BUCKETS.reduce((a, b) => a + i.stageMs[b], 0))
  const activeMedian = cov(percentile(actives, 0.5), actives.length, items.length, items.filter(i => i.publishedAtMs === null).map(i => i.subtaskId),
    'median of time in running + qa + adjust + leader + merge + ci, published deliveries')

  // coordination share: a RANGE. lo = leader sessions only; hi = leader + sessions with no role.
  const pricedLinked = linked.filter(s => s.cost.costUSD !== null)
  const sum = (f: (s: ObservedSession) => boolean) => pricedLinked.filter(f).reduce((a, s) => a + s.cost.costUSD!, 0)
  const allCost = sum(() => true)
  const coordinationShareRange = allCost > 0
    ? { lo: sum(s => s.role === 'leader') / allCost, hi: sum(s => s.role === 'leader' || s.role === 'unknown') / allCost }
    : { lo: null, hi: null }
  const unpricedIds = linked.filter(s => s.cost.costUSD === null).map(s => s.id)
  const coordinationShare = cov<number>(null, pricedLinked.length, linked.length, unpricedIds,
    'a range, never a point: leader cost ÷ total cost (lower end) up to (leader + role-unknown) ÷ total (upper end)')

  const decided = items.filter(i => i.qaResult !== 'pending')
  const rejected = decided.filter(i => i.qaResult === 'rejected_once' || i.qaResult === 'rejected_many')
  const qaFirstRoundRejection = cov(decided.length ? rejected.length / decided.length : null, decided.length, items.length,
    items.filter(i => i.qaResult === 'pending').map(i => i.subtaskId), 'deliveries sent back by QA at least once ÷ deliveries QA has decided')
  const rounds = decided.map(i => i.qaRejections + 1)
  const qaRoundsMedian = cov(percentile(rounds, 0.5), rounds.length, items.length,
    items.filter(i => i.qaResult === 'pending').map(i => i.subtaskId), 'median of (QA rejections + 1) over decided deliveries')

  const published = items.filter(i => i.publishedAtMs !== null)
  const escapedDefectRate = input.escaped
    ? cov(published.length ? published.filter(i => input.escaped!.has(i.subtaskId)).length / published.length : null, published.length, published.length, [],
      'published deliveries that a later fix, revert or reopen links back to ÷ published deliveries')
    : cov<number>(null, 0, published.length, published.map(i => i.subtaskId), 'escape links are not recorded')

  const wasted = pricedLinked.filter(s => s.wasted)
  const wastedCostShare = cov(allCost > 0 ? wasted.reduce((a, s) => a + s.cost.costUSD!, 0) / allCost : null, pricedLinked.length, linked.length, unpricedIds,
    'cost of dead, abandoned or discarded sessions ÷ total cost, priced sessions only')

  const from = input.period?.from ?? null, to = input.period?.to ?? null
  const span = items.length ? Math.max(...items.map(i => i.refMs)) - Math.min(...items.map(i => i.refMs)) : 0
  const weeks = input.filters?.fromMs !== undefined && input.filters?.toMs !== undefined ? (input.filters.toMs - input.filters.fromMs) / WEEK_MS : span / WEEK_MS
  const throughputPerWeek = cov(weeks > 0 ? published.length / weeks : null, published.length, items.length,
    items.filter(i => i.publishedAtMs === null).map(i => i.subtaskId), 'published deliveries ÷ weeks in the period')

  const st = input.structured
  return {
    label: 'observed-biased',
    period: { from, to },
    deliveries: items.length,
    metrics: { costPerDelivery, wallMedian, activeMedian, coordinationShare, qaFirstRoundRejection, qaRoundsMedian, escapedDefectRate, wastedCostShare, throughputPerWeek },
    coordinationShareRange,
    coverage,
    notStructured: {
      qaVerdict: st ? items.filter(i => !st.qaVerdict.has(i.subtaskId)).length : items.length,
      escapedLink: st ? items.filter(i => !st.escapedLink.has(i.subtaskId)).length : items.length,
    },
  }
}
