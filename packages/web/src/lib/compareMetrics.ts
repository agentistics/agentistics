/**
 * compareMetrics.ts — PURE: the curated A / B / Δ row set for the compare page's filter mode.
 *
 * Curated on purpose. `useDerivedStats` returns ~48 fields and a table of all of them is a data
 * dump, not a comparison; these are the ones that answer "which of these two is better, and by how
 * much". Everything here is arithmetic and labelling — no React, fully tested.
 *
 * ── THE TWO RULES THAT MATTER ────────────────────────────────────────────────────────────────
 * 1. A ROW HAS ONE BASIS. If the plan basis is on but only one side has a usable plan cost, the
 *    cost row falls back to API for BOTH columns. One column in plan basis beside one in API basis
 *    is not a comparison — it is two different questions in the same row, with a Δ between them
 *    that means nothing.
 * 2. A DELTA THAT CANNOT BE STATED IS `null`, NEVER A NUMBER. Growing from zero is not "+∞%" and
 *    not "+100%"; a missing side is not zero. Both come out as `null`, which the UI renders as a
 *    dash — the same N/A-versus-a-confident-0 discipline the rest of the product applies.
 */

/**
 * One side's filters, in words.
 *
 * The table compares two scopes; without a sentence naming each, the reader has to reverse-engineer
 * them from two filter bars and hold both in their head. It stays short and generic on purpose —
 * counts rather than lists — because a side that names nine projects is a paragraph, not a label.
 */
export function describeFilters(
  f: {
    dateRange: string
    customStart?: string
    customEnd?: string
    projects?: string[]
    models?: string[]
    repos?: string[]
    harnesses?: string[]
    tags?: string[]
  },
  lang: 'pt' | 'en',
  harnessLabel: (id: string) => string = id => id,
): string {
  const pt = lang === 'pt'
  const parts: string[] = []

  if (f.customStart || f.customEnd) {
    parts.push(`${f.customStart || '…'} → ${f.customEnd || '…'}`)
  } else {
    parts.push(
      f.dateRange === 'all' ? (pt ? 'todo o período' : 'all time')
      : f.dateRange === '7d' ? (pt ? 'últimos 7 dias' : 'last 7 days')
      : f.dateRange === '30d' ? (pt ? 'últimos 30 dias' : 'last 30 days')
      : f.dateRange === '90d' ? (pt ? 'últimos 90 dias' : 'last 90 days')
      : f.dateRange,
    )
  }

  // Harnesses are named rather than counted: which assistant is usually the POINT of the
  // comparison, and "2 harnesses" answers nothing.
  const h = f.harnesses ?? []
  if (h.length > 0 && h.length <= 3) parts.push(h.map(harnessLabel).join(' + '))
  else if (h.length > 3) parts.push(pt ? `${h.length} harnesses` : `${h.length} harnesses`)

  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  if (f.projects?.length) parts.push(count(f.projects.length, pt ? 'projeto' : 'project', pt ? 'projetos' : 'projects'))
  if (f.repos?.length) parts.push(count(f.repos.length, pt ? 'repo' : 'repo', pt ? 'repos' : 'repos'))
  if (f.models?.length) parts.push(count(f.models.length, pt ? 'modelo' : 'model', pt ? 'modelos' : 'models'))
  if (f.tags?.length) parts.push(count(f.tags.length, 'tag', 'tags'))

  return parts.join(' · ')
}

export type MetricPolarity = 'lower-better' | 'higher-better' | 'neutral'
export type DeltaTone = 'good' | 'bad' | 'flat' | 'na'
export type MetricFormat = 'cost' | 'count' | 'tokens' | 'percent' | 'multiple' | 'rate'
export type MetricBasis = 'api' | 'plan'

export interface CompareMetricDef {
  key: string
  labelEn: string
  labelPt: string
  polarity: MetricPolarity
  format: MetricFormat
  /** A row pinned to one basis whatever the page toggle says. */
  fixedBasis?: MetricBasis
}

/** Everything one side of the comparison contributes. `null` means "not available for this side". */
export interface CompareSide {
  costUSD: number | null
  /** C for this side's filter. `null` when the plan basis is not computable there. */
  planCostUSD: number | null
  planMultiple: number | null
  tokens: number | null
  sessions: number | null
  messages: number | null
  cacheHitRate: number | null
}

/** One side's cell in a row. */
export interface CompareCell {
  value: number | null
  /** The basis THIS column actually used. Columns may differ — comparing what a plan cost against
   *  what the same work would have cost at API prices is the core question this feature exists
   *  for, and forbidding it forbade the point. What must never happen is a column QUIETLY falling
   *  back while wearing the other's label, which is why every cell carries its own. */
  basis: MetricBasis
  /** The side asked for the plan basis and could not have it, so this cell fell back to API.
   *  Rendered as a caveat, never silently. */
  fellBack: boolean
  /** Against the BASELINE (index 0). `null` on the baseline itself and when either side is
   *  missing. */
  delta: number | null
  /** `delta / baseline`. `null` when the baseline is zero — growth from nothing has no
   *  percentage, and printing one would be inventing a denominator. */
  deltaPct: number | null
  tone: DeltaTone
}

export interface CompareRow {
  metric: CompareMetricDef
  /** One per side, in the sides' own order. `cells[0]` is the baseline. */
  cells: CompareCell[]
  /** The columns do not all share a basis. The table then labels each one, because a delta
   *  between a plan figure and an API figure is a deliberate answer here and an accident
   *  everywhere else — the label is what tells them apart. */
  mixedBasis: boolean
  /** The index of the best cell by this metric's polarity, or `null` for a neutral metric or when
   *  nothing is comparable. Drawn as a marker rather than left for the reader to work out. */
  bestIndex: number | null
}

export const COMPARE_METRICS: readonly CompareMetricDef[] = [
  { key: 'cost', labelEn: 'Cost', labelPt: 'Custo', polarity: 'lower-better', format: 'cost' },
  { key: 'planMultiple', labelEn: 'Plan value multiple', labelPt: 'Múltiplo do plano', polarity: 'higher-better', format: 'multiple', fixedBasis: 'plan' },
  // A − C, the multiple restated in money. Negative when the plan cost more than the usage was
  // worth, which is a real answer and is shown as such rather than floored at zero.
  { key: 'planSavings', labelEn: 'Saved vs API prices', labelPt: 'Economia vs. preços de API', polarity: 'higher-better', format: 'cost', fixedBasis: 'plan' },
  { key: 'effectiveCostPerMTokens', labelEn: 'Effective $/1M tokens', labelPt: 'Custo efetivo por 1M tokens', polarity: 'lower-better', format: 'rate' },
  { key: 'tokens', labelEn: 'Tokens', labelPt: 'Tokens', polarity: 'neutral', format: 'tokens' },
  { key: 'sessions', labelEn: 'Sessions', labelPt: 'Sessões', polarity: 'higher-better', format: 'count' },
  { key: 'messages', labelEn: 'Messages', labelPt: 'Mensagens', polarity: 'neutral', format: 'count' },
  { key: 'tokensPerSession', labelEn: 'Tokens per session', labelPt: 'Tokens por sessão', polarity: 'neutral', format: 'tokens' },
  // Cache is always an API-basis fact: it does not reduce a subscription bill, it extends a rate
  // limit. Same reason CacheHitRatePanel never converts.
  { key: 'cacheHitRate', labelEn: 'Cache hit rate', labelPt: 'Taxa de acerto do cache', polarity: 'higher-better', format: 'percent', fixedBasis: 'api' },
]

const ratio = (n: number | null, d: number | null): number | null =>
  n === null || d === null || d === 0 ? null : n / d

function valueFor(side: CompareSide, key: string, basis: MetricBasis): number | null {
  switch (key) {
    case 'cost': return basis === 'plan' ? side.planCostUSD : side.costUSD
    case 'planMultiple': return side.planMultiple
    case 'planSavings':
      // Needs BOTH figures; one alone says nothing about the difference between them.
      return side.planCostUSD === null || side.costUSD === null ? null : side.costUSD - side.planCostUSD
    case 'effectiveCostPerMTokens':
      // Both bases divide by the SAME token count. Taking the plan basis's own rate here would
      // change the denominator too (it counts cache, this page's `tokens` does not), so flipping
      // the toggle would move the number for two reasons at once and the row would compare
      // nothing. A basis switch may only ever change the numerator.
      return ratio(
        basis === 'plan' ? side.planCostUSD : side.costUSD,
        side.tokens === null ? null : side.tokens / 1_000_000,
      )
    case 'tokens': return side.tokens
    case 'sessions': return side.sessions
    case 'messages': return side.messages
    case 'tokensPerSession': return ratio(side.tokens, side.sessions)
    case 'cacheHitRate': return side.cacheHitRate
    default: return null
  }
}

function toneFor(delta: number | null, polarity: MetricPolarity): DeltaTone {
  if (delta === null) return 'na'
  if (delta === 0) return 'flat'
  if (polarity === 'neutral') return 'flat'
  const better = polarity === 'lower-better' ? delta < 0 : delta > 0
  return better ? 'good' : 'bad'
}

/**
 * Build the table for N sides.
 *
 * `basis` is the comparison's own basis. A row whose `fixedBasis` disagrees keeps its own, and the
 * cost row degrades to API when ANY side cannot produce a plan cost — see rule 1 in the header:
 * one plan-basis column beside an API-basis one is not a comparison.
 *
 * Every delta is against `sides[0]`. With two sides that is a symmetric statement and the order
 * hardly matters; with three or more it is the whole meaning of the table, which is why the
 * baseline is fixed at the first side rather than chosen per row.
 */
export function buildCompareRows(
  sides: readonly CompareSide[],
  /** One basis PER SIDE, so "my plan" can be measured against "the same work at API prices".
   *  A missing entry defaults to `'api'`. */
  bases: readonly MetricBasis[],
): CompareRow[] {
  if (sides.length === 0) return []
  const rows: CompareRow[] = []

  for (const metric of COMPARE_METRICS) {
    const resolved = sides.map((side, i) => {
      const asked: MetricBasis = metric.fixedBasis ?? bases[i] ?? 'api'
      // Asking for the plan basis where no plan cost exists falls back to API — but the cell says
      // so. A silent fallback wearing the plan label is the failure this per-column basis is
      // designed around, not the mixed row itself.
      const fellBack = asked === 'plan' && metric.key !== 'planMultiple' && side.planCostUSD === null
      const basis: MetricBasis = fellBack ? 'api' : asked
      return { basis, fellBack, value: valueFor(side, metric.key, basis) }
    })

    // A row pinned to the plan basis is simply absent when NO side has one — a row that can only
    // ever say "no" in every column is noise.
    if (metric.fixedBasis === 'plan' && resolved.every(r => r.value === null)) continue

    const baseline = resolved[0]?.value ?? null
    const cells: CompareCell[] = resolved.map((r, i) => {
      if (i === 0) return { ...r, delta: null, deltaPct: null, tone: 'flat' }
      const delta = r.value === null || baseline === null ? null : r.value - baseline
      const deltaPct = delta === null || baseline === null || baseline === 0 ? null : delta / baseline
      return { ...r, delta, deltaPct, tone: toneFor(delta, metric.polarity) }
    })

    rows.push({
      metric,
      cells,
      mixedBasis: new Set(resolved.map(r => r.basis)).size > 1,
      bestIndex: bestOf(resolved.map(r => r.value), metric.polarity),
    })
  }

  return rows
}

/** Which side wins this metric. `null` for a neutral one — marking a "winner" where none exists
 *  would invent a judgement the metric does not support. */
function bestOf(values: (number | null)[], polarity: MetricPolarity): number | null {
  if (polarity === 'neutral') return null
  const present = values.filter((v): v is number => v !== null)
  // A single comparable side is not a winner over anything.
  if (present.length < 2) return null

  const bestValue = polarity === 'lower-better' ? Math.min(...present) : Math.max(...present)
  // A TIE HAS NO WINNER. Strict comparison left the first side crowned whenever the values were
  // equal, so two identical columns showed a crown on one of them — the table asserting a
  // difference the numbers do not contain.
  if (present.filter(v => v === bestValue).length > 1) return null
  return values.findIndex(v => v === bestValue)
}
