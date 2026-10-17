import { describe, test, expect } from 'bun:test'
import {
  AVG_DAYS_PER_MONTH,
  accountTimeline,
  aggregatePlanBasis,
  allocatePlanCost,
  billingReadiness,
  computePlanCost,
  monthlyCommitment,
  dayFromIndex,
  dayIndex,
  isBillingDay,
  normalizeBillingSettings,
  periodsOverlap,
  planAllocation,
  resolvePlanBasis,
  resolveWindow,
  sortPeriods,
  timelineIsValid,
  validatePeriod,
  windowDayCount,
} from './billing'
import type { BillingPeriod, BillingTimeline, PlanCostResult } from './billing'

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

function sub(id: string, from: string, to: string | undefined, amount: number, currency: 'USD' | 'BRL' = 'USD'): BillingPeriod {
  return { id, mode: 'subscription', planId: 'anthropic-max-5x', from, ...(to ? { to } : {}), price: { amount, currency } }
}
function api(id: string, from: string, to?: string): BillingPeriod {
  return { id, mode: 'api', planId: 'api-payg', from, ...(to ? { to } : {}) }
}
function timeline(...periods: BillingPeriod[]): BillingTimeline {
  return { periods }
}
function codes(errors: ReturnType<typeof validatePeriod>): string[] {
  return errors.map((e) => e.code)
}
/** Every numeric leaf is finite — the guard against an `Infinity` leaking out of a division. */
function allNumbersFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(allNumbersFinite)
  if (value instanceof Set) return [...value].every(allNumbersFinite)
  if (value && typeof value === 'object') return Object.values(value).every(allNumbersFinite)
  return true
}

const ms = (day: string) => Date.parse(`${day}T00:00:00.000Z`)

// ── day arithmetic ───────────────────────────────────────────────────────────────────────────

describe('day arithmetic', () => {
  test('round-trips a real day', () => {
    expect(dayFromIndex(dayIndex('2026-04-01') as number)).toBe('2026-04-01')
    expect(dayIndex('1970-01-01')).toBe(0)
  })

  test('rejects a day that does not exist', () => {
    // Date.UTC rolls 2026-02-31 forward to March 3rd rather than failing, so a plain parse would
    // accept a date the user never meant and shift a period boundary by three days.
    expect(dayIndex('2026-02-31')).toBeNull()
    expect(dayIndex('2026-13-01')).toBeNull()
    expect(isBillingDay('2026-2-1')).toBe(false)
    expect(isBillingDay('not a day')).toBe(false)
    expect(isBillingDay(undefined)).toBe(false)
  })

  test('leap day is a real day', () => {
    expect(isBillingDay('2028-02-29')).toBe(true)
    expect(isBillingDay('2026-02-29')).toBe(false)
  })

  test('windowDayCount is inclusive', () => {
    expect(windowDayCount({ from: '2026-04-01', to: '2026-04-01' })).toBe(1)
    expect(windowDayCount({ from: '2026-04-01', to: '2026-04-30' })).toBe(30)
    expect(windowDayCount({ from: '2026-04-30', to: '2026-04-01' })).toBe(0)
  })
})

// ── overlap and validation ───────────────────────────────────────────────────────────────────

describe('periodsOverlap', () => {
  test('a shared boundary day IS an overlap', () => {
    // Both bounds are inclusive, so that one day would be priced twice.
    const a = sub('a', '2026-01-01', '2026-04-15', 20)
    const b = sub('b', '2026-04-15', '2026-06-30', 100)
    expect(periodsOverlap(a, b)).toBe(true)
  })

  test('adjacent periods do not overlap', () => {
    const a = sub('a', '2026-04-01', '2026-04-15', 20)
    const b = sub('b', '2026-04-16', '2026-04-30', 100)
    expect(periodsOverlap(a, b)).toBe(false)
  })

  test('an ongoing period overlaps everything after its start', () => {
    const ongoing = sub('a', '2026-01-01', undefined, 100)
    expect(periodsOverlap(ongoing, sub('b', '2026-06-01', '2026-06-30', 20))).toBe(true)
    expect(periodsOverlap(ongoing, sub('c', '2025-01-01', '2025-12-31', 20))).toBe(false)
  })

  test('two ongoing periods always overlap', () => {
    expect(periodsOverlap(sub('a', '2020-01-01', undefined, 20), sub('b', '2026-01-01', undefined, 100))).toBe(true)
  })

  test('an unparseable period cannot be shown to overlap anything', () => {
    const broken: BillingPeriod = { id: 'x', mode: 'api', from: 'nope' }
    expect(periodsOverlap(broken, sub('b', '2026-01-01', undefined, 100))).toBe(false)
  })
})

describe('validatePeriod', () => {
  test('a sound subscription has no errors', () => {
    expect(validatePeriod(sub('a', '2026-01-01', '2026-04-30', 100))).toEqual([])
  })

  test('editing a period does not report it overlapping its own previous self', () => {
    // `others` excludes the period by id; without this the form would refuse every edit that did
    // not move the dates.
    const p = sub('a', '2026-01-01', '2026-04-30', 100)
    expect(codes(validatePeriod(p, [p]))).toEqual([])
  })

  test('reports an overlap against a different period', () => {
    const a = sub('a', '2026-01-01', '2026-04-30', 100)
    const b = sub('b', '2026-04-01', '2026-06-30', 20)
    expect(codes(validatePeriod(a, [b]))).toEqual(['overlap'])
  })

  test('a gap between periods is not an error', () => {
    const a = sub('a', '2026-01-01', '2026-01-31', 100)
    const b = sub('b', '2026-04-01', '2026-04-30', 20)
    expect(codes(validatePeriod(a, [b]))).toEqual([])
  })

  test('a price on a non-subscription period is refused', () => {
    // An api period's C is its A; a monthly price sitting on it would be added to a cost that
    // already contains it.
    const bad: BillingPeriod = { ...api('a', '2026-01-01'), price: { amount: 100, currency: 'USD' } }
    expect(codes(validatePeriod(bad))).toEqual(['price_on_non_subscription'])
  })

  test('a subscription needs a plan and a positive price', () => {
    const noPrice: BillingPeriod = { id: 'a', mode: 'subscription', from: '2026-01-01' }
    expect(codes(validatePeriod(noPrice)).sort()).toEqual(['missing_plan', 'missing_price'])

    const zero = sub('b', '2026-01-01', undefined, 0)
    expect(codes(validatePeriod(zero))).toEqual(['non_positive_price'])
    const negative = sub('c', '2026-01-01', undefined, -5)
    expect(codes(validatePeriod(negative))).toEqual(['non_positive_price'])
  })

  test("planId 'other' requires a label", () => {
    const p: BillingPeriod = { id: 'a', mode: 'subscription', planId: 'other', from: '2026-01-01', price: { amount: 30, currency: 'USD' } }
    expect(codes(validatePeriod(p))).toEqual(['missing_label'])
    expect(codes(validatePeriod({ ...p, label: 'My gateway' }))).toEqual([])
  })

  test('an inverted range is refused', () => {
    expect(codes(validatePeriod(sub('a', '2026-04-30', '2026-04-01', 100)))).toEqual(['inverted_range'])
  })

  test('a missing or malformed day is refused', () => {
    expect(codes(validatePeriod({ id: 'a', mode: 'api', from: '' }))).toEqual(['missing_from'])
    expect(codes(validatePeriod({ id: 'a', mode: 'api', from: '2026-02-31' }))).toEqual(['bad_day'])
  })
})

describe('sortPeriods', () => {
  test('orders chronologically without mutating the input', () => {
    const input = [sub('b', '2026-04-01', '2026-04-30', 100), sub('a', '2026-01-01', '2026-01-31', 20)]
    expect(sortPeriods(input).map((p) => p.id)).toEqual(['a', 'b'])
    expect(input.map((p) => p.id)).toEqual(['b', 'a'])
  })
})

// ── the window ───────────────────────────────────────────────────────────────────────────────

describe('resolveWindow', () => {
  const base = { dataFirstDay: '2026-01-10', dataLastDay: '2026-06-20', today: '2026-08-11' }

  test("the 'all' filter starts at the data, not at 1970", () => {
    // getDateRangeFilter('all') hands back new Date(0). Prorating a subscription across 56 years —
    // or reporting 0.02% coverage forever — is the first wrong number this could ship.
    const w = resolveWindow({ ...base, filterStartMs: 0, filterEndMs: ms('2026-08-11') })
    expect(w).toEqual({ from: '2026-01-10', to: '2026-06-20' })
  })

  test('a future filter end is clamped to today', () => {
    const w = resolveWindow({ ...base, dataLastDay: '2026-12-31', filterStartMs: ms('2026-01-01'), filterEndMs: ms('2027-01-01') })
    expect(w?.to).toBe('2026-08-11')
  })

  test('no data at all yields null, never a zero-day window', () => {
    expect(resolveWindow({ ...base, dataFirstDay: null, dataLastDay: null, filterStartMs: 0, filterEndMs: ms('2026-08-11') })).toBeNull()
  })

  test('a filter window entirely before the data yields null', () => {
    expect(resolveWindow({ ...base, filterStartMs: ms('2020-01-01'), filterEndMs: ms('2020-12-31') })).toBeNull()
  })

  test('a one-day window survives', () => {
    const w = resolveWindow({ ...base, filterStartMs: ms('2026-03-05'), filterEndMs: ms('2026-03-05') })
    expect(w).toEqual({ from: '2026-03-05', to: '2026-03-05' })
    expect(windowDayCount(w!)).toBe(1)
  })
})

// ── the plan cost ────────────────────────────────────────────────────────────────────────────

describe('computePlanCost', () => {
  const april = { from: '2026-04-01', to: '2026-04-30' }

  test('prorates by days: 30.44 days costs exactly one month', () => {
    const r = computePlanCost({ timeline: timeline(sub('a', '2026-04-01', '2026-04-30', 100)), window: april, brlRate: 5.5 })
    expect(r.subscriptionCostUSD).toBeCloseTo((100 * 30) / AVG_DAYS_PER_MONTH, 9)
    expect(r.coveredDays).toBe(30)
    expect(r.coverageRatio).toBe(1)
    expect(r.unavailable).toBe(false)
  })

  test('a plan change mid-window prices each half at its own rate', () => {
    // The reason the model is a timeline rather than a single "current plan".
    const r = computePlanCost({
      timeline: timeline(sub('a', '2026-04-01', '2026-04-15', 20), sub('b', '2026-04-16', '2026-04-30', 100)),
      window: april,
      brlRate: 5.5,
    })
    expect(r.subscriptionCostUSD).toBeCloseTo((20 * 15) / AVG_DAYS_PER_MONTH + (100 * 15) / AVG_DAYS_PER_MONTH, 9)
    expect(r.segments).toHaveLength(2)
    expect(r.coveredDays).toBe(30)
  })

  test('a gap leaves its days uncovered and out of coveredDayKeys', () => {
    const r = computePlanCost({
      timeline: timeline(sub('a', '2026-04-01', '2026-04-07', 20), sub('b', '2026-04-16', '2026-04-30', 100)),
      window: april,
      brlRate: 5.5,
    })
    expect(r.coveredDays).toBe(22)
    expect(r.uncoveredDays).toBe(8)
    expect(r.coverageRatio).toBeCloseTo(22 / 30, 9)
    expect(r.coveredDayKeys.has('2026-04-10')).toBe(false)
    expect(r.coveredDayKeys.has('2026-04-07')).toBe(true)
  })

  test('a window entirely before the first period is unavailable, not zero', () => {
    const r = computePlanCost({ timeline: timeline(sub('a', '2026-06-01', undefined, 100)), window: april, brlRate: 5.5 })
    expect(r.coveredDays).toBe(0)
    expect(r.unavailable).toBe(true)
    expect(r.subscriptionCostUSD).toBe(0)
  })

  test('an ongoing period keeps covering as the window moves forward', () => {
    const t = timeline(sub('a', '2026-01-01', undefined, 100))
    expect(computePlanCost({ timeline: t, window: april, brlRate: 5.5 }).coveredDays).toBe(30)
    const later = computePlanCost({ timeline: t, window: { from: '2027-05-01', to: '2027-05-31' }, brlRate: 5.5 })
    expect(later.coveredDays).toBe(31)
  })

  test('BRL converts through the rate', () => {
    const r = computePlanCost({ timeline: timeline(sub('a', '2026-04-01', '2026-04-30', 550, 'BRL')), window: april, brlRate: 5.5 })
    expect(r.segments[0]!.monthlyUSD).toBeCloseTo(100, 9)
    expect(r.usedBrlRate).toBe(5.5)
    expect(r.brlRateUnusable).toBe(false)
  })

  test('an unusable BRL rate uncovers those days rather than yielding Infinity', () => {
    for (const rate of [0, -1, Number.NaN]) {
      const r = computePlanCost({ timeline: timeline(sub('a', '2026-04-01', '2026-04-30', 550, 'BRL')), window: april, brlRate: rate })
      expect(r.brlRateUnusable).toBe(true)
      expect(r.coveredDays).toBe(0)
      expect(r.unavailable).toBe(true)
      expect(allNumbersFinite(r)).toBe(true)
    }
  })

  test('api-mode days are covered, cost zero here, and land in apiDayKeys', () => {
    // C = A on those days; the A is added by resolvePlanBasis, so the segment carries 0 and the
    // sum of segments can never double-count it.
    const r = computePlanCost({ timeline: timeline(api('a', '2026-04-01', '2026-04-30')), window: april, brlRate: 5.5 })
    expect(r.subscriptionCostUSD).toBe(0)
    expect(r.coveredDays).toBe(30)
    expect(r.apiDayKeys.size).toBe(30)
    expect(r.unavailable).toBe(false)
  })

  test('third-party days are uncovered but still reported as a segment', () => {
    const r = computePlanCost({
      timeline: timeline({ id: 'a', mode: 'thirdparty', from: '2026-04-01', to: '2026-04-30' }),
      window: april,
      brlRate: 5.5,
    })
    expect(r.coveredDays).toBe(0)
    expect(r.uncoveredDays).toBe(30)
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0]!.covered).toBe(false)
    expect(r.segments[0]!.monthlyUSD).toBeNull()
  })

  test('a hand-edited overlap makes the whole result unusable, never a doubled cost', () => {
    // preferences.json is hand-editable, so entry validation is not enough. A silently doubled
    // bill is worse than no bill.
    const t = timeline(sub('a', '2026-04-01', '2026-04-30', 100), sub('b', '2026-04-10', '2026-04-20', 100))
    expect(timelineIsValid(t)).toBe(false)
    const r = computePlanCost({ timeline: t, window: april, brlRate: 5.5 })
    expect(r.invalidTimeline).toBe(true)
    expect(r.unavailable).toBe(true)
    expect(r.subscriptionCostUSD).toBe(0)
  })

  test('an absent or empty timeline is unavailable', () => {
    for (const t of [undefined, timeline()]) {
      const r = computePlanCost({ timeline: t, window: april, brlRate: 5.5 })
      expect(r.unavailable).toBe(true)
      expect(r.coveredDays).toBe(0)
      expect(r.uncoveredDays).toBe(30)
    }
  })

  test('a period is clipped to the window, not counted whole', () => {
    const r = computePlanCost({ timeline: timeline(sub('a', '2020-01-01', undefined, 100)), window: april, brlRate: 5.5 })
    expect(r.segments[0]!.from).toBe('2026-04-01')
    expect(r.segments[0]!.to).toBe('2026-04-30')
    expect(r.segments[0]!.days).toBe(30)
  })
})

// ── the basis ────────────────────────────────────────────────────────────────────────────────

describe('resolvePlanBasis', () => {
  const april = { from: '2026-04-01', to: '2026-04-30' }
  const plan = (t: BillingTimeline | undefined, rate = 5.5): PlanCostResult =>
    computePlanCost({ timeline: t, window: april, brlRate: rate })
  const zeroFacts = { excludedSessions: 0, excludedApiCostUSD: 0, undatedApiCostUSD: 0 }

  test('computes the multiple and the effective rate', () => {
    const p = plan(timeline(sub('a', '2026-04-01', '2026-04-30', 100)))
    const b = resolvePlanBasis({ plan: p, apiCostOnSubscriptionDaysUSD: 850, apiCostOnApiDaysUSD: 0, tokensCovered: 500_000_000, ...zeroFacts })
    expect(b.planCostUSD).toBeCloseTo((100 * 30) / AVG_DAYS_PER_MONTH, 9)
    expect(b.apiCostUSD).toBe(850)
    expect(b.multiple).toBeCloseTo(850 / ((100 * 30) / AVG_DAYS_PER_MONTH), 9)
    expect(b.effectiveCostPerMTokens).toBeCloseTo(b.planCostUSD / 500, 9)
    expect(b.coverage.computable).toBe(true)
  })

  test('an uncovered window is N/A, never a confident zero', () => {
    const b = resolvePlanBasis({ plan: plan(undefined), apiCostOnSubscriptionDaysUSD: 850, apiCostOnApiDaysUSD: 0, tokensCovered: 1e9, ...zeroFacts })
    expect(b.coverage.computable).toBe(false)
    expect(b.multiple).toBeNull()
    expect(b.effectiveCostPerMTokens).toBeNull()
    expect(b.planCostUSD).toBe(0)
    expect(b.apiCostUSD).toBe(0)
  })

  test('a zero-token window still has a multiple but no effective rate', () => {
    const b = resolvePlanBasis({ plan: plan(timeline(sub('a', '2026-04-01', '2026-04-30', 100))), apiCostOnSubscriptionDaysUSD: 50, apiCostOnApiDaysUSD: 0, tokensCovered: 0, ...zeroFacts })
    expect(b.multiple).not.toBeNull()
    expect(b.effectiveCostPerMTokens).toBeNull()
  })

  test('api-only days give a multiple of exactly 1', () => {
    // C = A there, so the plan basis says neither gain nor loss — which is the truth.
    const b = resolvePlanBasis({ plan: plan(timeline(api('a', '2026-04-01', '2026-04-30'))), apiCostOnSubscriptionDaysUSD: 0, apiCostOnApiDaysUSD: 340, tokensCovered: 1e8, ...zeroFacts })
    expect(b.planCostUSD).toBe(340)
    expect(b.apiCostUSD).toBe(340)
    expect(b.multiple).toBe(1)
  })

  test('mixed subscription and api days sum on both sides', () => {
    const p = plan(timeline(sub('a', '2026-04-01', '2026-04-15', 100), api('b', '2026-04-16', '2026-04-30')))
    const b = resolvePlanBasis({ plan: p, apiCostOnSubscriptionDaysUSD: 400, apiCostOnApiDaysUSD: 60, tokensCovered: 1e8, ...zeroFacts })
    expect(b.planCostUSD).toBeCloseTo((100 * 15) / AVG_DAYS_PER_MONTH + 60, 9)
    expect(b.apiCostUSD).toBe(460)
  })

  test('the honesty facts pass through untouched', () => {
    const b = resolvePlanBasis({
      plan: plan(timeline(sub('a', '2026-04-01', '2026-04-20', 100))),
      apiCostOnSubscriptionDaysUSD: 400, apiCostOnApiDaysUSD: 0, tokensCovered: 1e8,
      excludedSessions: 12, excludedApiCostUSD: 340, undatedApiCostUSD: 99,
    })
    expect(b.coverage.excludedSessions).toBe(12)
    expect(b.coverage.excludedApiCostUSD).toBe(340)
    expect(b.coverage.undatedApiCostUSD).toBe(99)
    expect(b.coverage.uncoveredDays).toBe(10)
  })
})

describe('aggregatePlanBasis', () => {
  const april = { from: '2026-04-01', to: '2026-04-30' }
  const zeroFacts = { excludedSessions: 0, excludedApiCostUSD: 0, undatedApiCostUSD: 0 }
  const basisFor = (t: BillingTimeline | undefined, apiUSD: number) =>
    resolvePlanBasis({
      plan: computePlanCost({ timeline: t, window: april, brlRate: 5.5 }),
      apiCostOnSubscriptionDaysUSD: apiUSD, apiCostOnApiDaysUSD: 0, tokensCovered: 1e8, ...zeroFacts,
    })

  test('names the harnesses with no plan instead of averaging them in as zero', () => {
    const agg = aggregatePlanBasis([
      { harness: 'claude', basis: basisFor(timeline(sub('a', '2026-04-01', '2026-04-30', 100)), 850) },
      { harness: 'codex', basis: basisFor(undefined, 120) },
    ])
    expect(agg.uncoveredHarnesses).toEqual(['codex'])
    expect(agg.apiCostUSD).toBe(850)
    expect(agg.multiple).toBeCloseTo(850 / ((100 * 30) / AVG_DAYS_PER_MONTH), 9)
  })

  test('all harnesses uncovered is not computable', () => {
    const agg = aggregatePlanBasis([
      { harness: 'claude', basis: basisFor(undefined, 850) },
      { harness: 'codex', basis: basisFor(undefined, 120) },
    ])
    expect(agg.coverage.computable).toBe(false)
    expect(agg.multiple).toBeNull()
    expect(agg.uncoveredHarnesses).toEqual(['claude', 'codex'])
  })

  test('uncoveredHarnesses follows HARNESS_ORDER', () => {
    const agg = aggregatePlanBasis([
      { harness: 'kimi', basis: basisFor(undefined, 1) },
      { harness: 'claude', basis: basisFor(undefined, 1) },
      { harness: 'gemini', basis: basisFor(undefined, 1) },
    ])
    expect(agg.uncoveredHarnesses).toEqual(['claude', 'gemini', 'kimi'])
  })

  test('planAllocation exposes a per-harness factor and null where uncomputable', () => {
    const agg = aggregatePlanBasis([
      { harness: 'claude', basis: basisFor(timeline(sub('a', '2026-04-01', '2026-04-30', 100)), 850) },
      { harness: 'codex', basis: basisFor(undefined, 120) },
    ])
    const alloc = planAllocation(agg)
    expect(alloc.byHarness.claude).toBeCloseTo(((100 * 30) / AVG_DAYS_PER_MONTH) / 850, 9)
    expect(alloc.byHarness.codex).toBeNull()
    expect(alloc.aggregateFactor).toBeCloseTo(((100 * 30) / AVG_DAYS_PER_MONTH) / 850, 9)
  })
})

// ── allocation ───────────────────────────────────────────────────────────────────────────────

describe('allocatePlanCost', () => {
  const rows = [{ c: 60 }, { c: 30 }, { c: 10 }]
  const cost = (r: { c: number }) => r.c

  test('the allocation sums back to the plan cost', () => {
    const out = allocatePlanCost(rows, cost, 200)
    expect(out.reduce((s, v) => s + v, 0)).toBeCloseTo(200, 9)
  })

  test('ranking is preserved exactly — it is a linear rescale', () => {
    const out = allocatePlanCost(rows, cost, 200)
    expect([...out].sort((a, b) => b - a)).toEqual(out)
  })

  test('proportions are preserved exactly', () => {
    const out = allocatePlanCost(rows, cost, 200)
    expect(out[0]! / out[1]!).toBeCloseTo(60 / 30, 9)
    expect(out[1]! / out[2]!).toBeCloseTo(30 / 10, 9)
  })

  test('rows with no API cost get zero — never NaN, and never an even split', () => {
    // An even split would invent attribution for work that cost nothing.
    const out = allocatePlanCost([{ c: 0 }, { c: 0 }], cost, 200)
    expect(out).toEqual([0, 0])
  })

  test('an empty row set allocates nothing', () => {
    expect(allocatePlanCost([], cost, 200)).toEqual([])
  })

  test('a negative or non-finite row cost is treated as zero', () => {
    const out = allocatePlanCost([{ c: -5 }, { c: Number.NaN }, { c: 10 }], cost, 100)
    expect(out).toEqual([0, 0, 100])
  })
})

// ── normalization ────────────────────────────────────────────────────────────────────────────

describe('normalizeBillingSettings', () => {
  test('garbage never throws and yields empty profiles', () => {
    for (const raw of [null, undefined, 42, 'x', [], { profiles: 'nope' }]) {
      expect(normalizeBillingSettings(raw)).toEqual({ profiles: {} })
    }
  })

  test('one malformed period drops itself and the rest survive', () => {
    // preferences.json is hand-editable; a dashboard must not go blank because a comma moved.
    const out = normalizeBillingSettings({
      profiles: {
        claude: {
          periods: [
            sub('a', '2026-01-01', '2026-01-31', 100),
            { id: 'b', mode: 'subscription', from: '2026-02-31' },
            { id: '', mode: 'api', from: '2026-03-01' },
            api('d', '2026-03-01'),
          ],
        },
      },
    })
    expect(out.profiles.claude?.periods.map((p) => p.id)).toEqual(['a', 'd'])
  })

  test('an unknown harness key is dropped', () => {
    const out = normalizeBillingSettings({ profiles: { notaharness: { periods: [api('a', '2026-01-01')] } } })
    expect(Object.keys(out.profiles)).toEqual([])
  })

  test('carries introDismissed and a valid costBasis only', () => {
    expect(normalizeBillingSettings({ introDismissed: true, costBasis: 'plan' })).toEqual({ profiles: {}, introDismissed: true, costBasis: 'plan' })
    expect(normalizeBillingSettings({ costBasis: 'nonsense' }).costBasis).toBeUndefined()
  })

  test('a non-positive price is dropped, leaving the period to fail validation loudly', () => {
    const out = normalizeBillingSettings({ profiles: { claude: { periods: [sub('a', '2026-01-01', undefined, 0)] } } })
    expect(out.profiles.claude?.periods[0]?.price).toBeUndefined()
    expect(codes(validatePeriod(out.profiles.claude!.periods[0]!))).toEqual(['missing_price'])
  })
})

// ── the monthly commitment ───────────────────────────────────────────────────────────────────

describe('monthlyCommitment', () => {
  const claude = (periods: BillingPeriod[]) => normalizeBillingSettings({ profiles: { claude: { periods } } }).profiles

  test('a full month of one subscription is its monthly price', () => {
    const c = monthlyCommitment({ profiles: claude([sub('a', '2020-01-01', undefined, 100)]), month: '2026-04-17', brlRate: 5.5 })
    // April has 30 days, so a $100/month plan prorates to 100 × 30 / 30.44.
    expect(c!.usd).toBeCloseTo((100 * 30) / AVG_DAYS_PER_MONTH, 9)
    expect(c!.partial).toBe(false)
    expect(c!.harnesses).toEqual(['claude'])
  })

  test('a plan starting mid-month is reported as partial', () => {
    // An unexplained "USD 63" where the user expects USD 100 reads as a bug, so the flag exists.
    const c = monthlyCommitment({ profiles: claude([sub('a', '2026-04-15', undefined, 100)]), month: '2026-04-01', brlRate: 5.5 })
    expect(c!.partial).toBe(true)
    expect(c!.usd).toBeCloseTo((100 * 16) / AVG_DAYS_PER_MONTH, 9)
  })

  test('api-mode days commit nothing but are flagged as usage on top', () => {
    // Their cost is usage, not a commitment; folding one into the other makes the number neither.
    const c = monthlyCommitment({ profiles: claude([api('a', '2020-01-01')]), month: '2026-04-10', brlRate: 5.5 })
    expect(c!.usd).toBe(0)
    expect(c!.hasUsageBilling).toBe(true)
    expect(c!.harnesses).toEqual([])
  })

  test('one short plan makes the TOTAL partial, even beside a full-month one', () => {
    // The total is then smaller than the sum of the monthly prices, and without this flag nothing
    // on screen says why. Taking the longest coverage instead reports a full month whenever any
    // one plan happens to span it.
    const profiles = normalizeBillingSettings({
      profiles: {
        claude: { periods: [sub('c', '2020-01-01', undefined, 100)] },
        kimi: { periods: [sub('k', '2026-04-20', undefined, 30)] },
      },
    }).profiles
    const c = monthlyCommitment({ profiles, month: '2026-04-10', brlRate: 5.5 })
    expect(c!.partial).toBe(true)
    expect(c!.usd).toBeCloseTo((100 * 30) / AVG_DAYS_PER_MONTH + (30 * 11) / AVG_DAYS_PER_MONTH, 9)
  })

  test('several harnesses sum, and are named in display order', () => {
    const profiles = normalizeBillingSettings({
      profiles: {
        kimi: { periods: [sub('k', '2020-01-01', undefined, 30)] },
        claude: { periods: [sub('c', '2020-01-01', undefined, 100)] },
      },
    }).profiles
    const c = monthlyCommitment({ profiles, month: '2026-04-10', brlRate: 5.5 })
    expect(c!.usd).toBeCloseTo((130 * 30) / AVG_DAYS_PER_MONTH, 9)
    expect(c!.harnesses).toEqual(['claude', 'kimi'])
  })

  test('nothing registered yields null, never a zero that reads as "your plans are free"', () => {
    expect(monthlyCommitment({ profiles: {}, month: '2026-04-10', brlRate: 5.5 })).toBeNull()
    expect(monthlyCommitment({ profiles: claude([sub('a', '2027-01-01', undefined, 100)]), month: '2026-04-10', brlRate: 5.5 })).toBeNull()
  })

  test('a December month rolls into the next year correctly', () => {
    const c = monthlyCommitment({ profiles: claude([sub('a', '2020-01-01', undefined, 100)]), month: '2026-12-05', brlRate: 5.5 })
    expect(c!.usd).toBeCloseTo((100 * 31) / AVG_DAYS_PER_MONTH, 9)
  })

  test('a bad month string yields null rather than throwing', () => {
    expect(monthlyCommitment({ profiles: claude([sub('a', '2020-01-01', undefined, 100)]), month: 'nope', brlRate: 5.5 })).toBeNull()
  })
})

// ── readiness ────────────────────────────────────────────────────────────────────────────────

describe('billingReadiness', () => {
  const settings = (periods: BillingPeriod[]) =>
    normalizeBillingSettings({ profiles: { claude: { periods } } })

  test('no timeline at all is not ready, and says which harness', () => {
    const r = billingReadiness({ profiles: {} }, ['claude', 'codex'])
    expect(r.ready).toBe(false)
    expect(r.readyHarnesses).toEqual([])
    expect(r.gaps).toEqual([
      { code: 'no_timeline', harness: 'claude' },
      { code: 'no_timeline', harness: 'codex' },
    ])
  })

  test('one usable timeline is enough to offer the basis', () => {
    const r = billingReadiness(settings([sub('a', '2026-01-01', undefined, 100)]), ['claude', 'codex'])
    expect(r.ready).toBe(true)
    expect(r.readyHarnesses).toEqual(['claude'])
    expect(r.gaps).toEqual([{ code: 'no_timeline', harness: 'codex' }])
  })

  test('a period missing its price is reported as that period, not as a missing timeline', () => {
    // The prompt must ask for the amount of THIS plan — never re-ask for everything.
    const r = billingReadiness(settings([sub('a', '2026-01-01', undefined, 0)]), ['claude'])
    expect(r.ready).toBe(false)
    expect(r.gaps).toHaveLength(1)
    const gap = r.gaps[0]!
    expect(gap.code).toBe('incomplete_period')
    if (gap.code === 'incomplete_period') {
      expect(gap.periodId).toBe('a')
      expect(gap.planId).toBe('anthropic-max-5x')
      expect(gap.errors.map((e) => e.code)).toEqual(['missing_price'])
    }
  })

  test('an overlap is reported once for the timeline, not once per period', () => {
    const r = billingReadiness(
      settings([sub('a', '2026-01-01', '2026-06-30', 100), sub('b', '2026-03-01', '2026-09-30', 20)]),
      ['claude'],
    )
    expect(r.gaps).toEqual([{ code: 'invalid_timeline', harness: 'claude' }])
  })

  test('R1: an obsolete default that every account overrides is not validated', () => {
    const bad = { periods: [sub('a', '2026-01-01', '2026-06-30', 100), sub('b', '2026-03-01', '2026-09-30', 20)] }
    const ok = (id: string) => ({ periods: [sub(id, '2026-01-01', undefined, 100)] })
    const s = normalizeBillingSettings({ profiles: { claude: bad }, accountProfiles: { x: ok('x'), y: ok('y') } })
    const accounts = [{ id: 'x', harness: 'claude' as const }, { id: 'y', harness: 'claude' as const }]
    expect(billingReadiness(s, ['claude'], accounts).ready).toBe(true)
    // …but it still blocks when an account actually inherits it.
    const inheriting = billingReadiness(s, ['claude'], [...accounts, { id: 'z', harness: 'claude' as const }])
    expect(inheriting.ready).toBe(false)
    expect(inheriting.gaps).toEqual([{ code: 'invalid_timeline', harness: 'claude' }])
  })

  test('readyHarnesses follows HARNESS_ORDER', () => {
    const s = normalizeBillingSettings({
      profiles: {
        kimi: { periods: [api('k', '2026-01-01')] },
        claude: { periods: [api('c', '2026-01-01')] },
      },
    })
    expect(billingReadiness(s, ['kimi', 'claude']).readyHarnesses).toEqual(['claude', 'kimi'])
  })

  test('account-only plans make the harness ready (no harness default timeline)', () => {
    const s = normalizeBillingSettings({
      profiles: {},
      accountProfiles: { a1: { periods: [sub('a', '2026-01-01', undefined, 100)] }, b1: { periods: [sub('b', '2026-01-01', undefined, 20)] } },
    })
    const accounts = [{ id: 'a1', harness: 'claude' as const }, { id: 'b1', harness: 'claude' as const }]
    expect(billingReadiness(s, ['claude']).ready).toBe(false)
    const r = billingReadiness(s, ['claude'], accounts)
    expect(r.ready).toBe(true)
    expect(r.readyHarnesses).toEqual(['claude'])
    expect(r.gaps).toEqual([])
  })

  test('an account timeline with a missing price keeps the harness not ready', () => {
    const s = normalizeBillingSettings({ profiles: {}, accountProfiles: { a1: { periods: [sub('a', '2026-01-01', undefined, 0)] } } })
    const r = billingReadiness(s, ['claude'], [{ id: 'a1', harness: 'claude' }])
    expect(r.ready).toBe(false)
    expect(r.gaps[0]?.code).toBe('incomplete_period')
  })

  test('an empty scope is not ready and asks for nothing', () => {
    expect(billingReadiness({ profiles: {} }, [])).toEqual({ ready: false, readyHarnesses: [], gaps: [] })
  })
})

// ── ACCT.BILLING: N accounts per harness ─────────────────────────────────────────────────────

describe('per-account billing', () => {
  const april = { from: '2026-04-01', to: '2026-04-30' }
  const full = (id: string, amount: number) => timeline(sub(id, '2026-04-01', '2026-04-30', amount))
  const accs = (...ids: string[]) => ids.map((id) => ({ id, harness: 'claude' as const }))

  test('two overlapping subscriptions: C is the sum, days are the union', () => {
    const r = computePlanCost({
      timeline: undefined,
      window: april,
      brlRate: 5,
      accounts: accs('acc_a', 'acc_b'),
      accountProfiles: { acc_a: full('a', 100), acc_b: full('b', 200) },
    })
    expect(r.subscriptionCostUSD).toBeCloseTo((300 * 30) / AVG_DAYS_PER_MONTH, 9)
    expect(r.coveredDays).toBe(30)
    expect(r.segments).toHaveLength(2)
    expect(r.unavailable).toBe(false)
  })

  test('one own timeline + two inheriting: the default is counted once', () => {
    const r = computePlanCost({
      timeline: full('d', 100),
      window: april,
      brlRate: 5,
      accounts: accs('acc_a', 'acc_b', 'acc_c'),
      accountProfiles: { acc_a: full('a', 50) },
    })
    expect(r.subscriptionCostUSD).toBeCloseTo((150 * 30) / AVG_DAYS_PER_MONTH, 9)
  })

  test('no accounts argument: identical to the single-timeline result', () => {
    const base = { timeline: full('d', 100), window: april, brlRate: 5 }
    const plain = computePlanCost(base)
    expect(computePlanCost({ ...base, accountProfiles: { acc_a: full('a', 50) } })).toEqual(plain)
    expect(computePlanCost({ ...base, accounts: accs('acc_a') })).toEqual(plain)
    expect(computePlanCost({ ...base, accounts: accs('acc_a'), accountProfiles: {} })).toEqual(plain)
  })

  test('overlap inside ONE account timeline is still refused', () => {
    const bad = timeline(sub('x', '2026-04-01', '2026-04-20', 10), sub('y', '2026-04-10', '2026-04-30', 10))
    const r = computePlanCost({
      timeline: undefined,
      window: april,
      brlRate: 5,
      accounts: accs('acc_a', 'acc_b'),
      accountProfiles: { acc_a: bad, acc_b: full('b', 100) },
    })
    expect(r.invalidTimeline).toBe(true)
    expect(r.unavailable).toBe(true)
    // The empty shape: the healthy account's C must not leak into an unusable result.
    expect(r.subscriptionCostUSD).toBe(0)
    expect(r.coveredDays).toBe(0)
    expect(r.coveredDayKeys.size).toBe(0)
    expect(r.segments).toEqual([])
  })

  test('two codex accounts (non-claude) each price on their own timeline', () => {
    const codex = ['acc_x', 'acc_y'].map((id) => ({ id, harness: 'codex' as const }))
    const r = computePlanCost({
      timeline: undefined,
      window: april,
      brlRate: 5,
      accounts: codex,
      accountProfiles: { acc_x: full('x', 20), acc_y: full('y', 200) },
    })
    expect(r.subscriptionCostUSD).toBeCloseTo((220 * 30) / AVG_DAYS_PER_MONTH, 9)
    expect(r.segments).toHaveLength(2)
  })

  test('monthlyCommitment sums accounts, even with no harness default', () => {
    const c = monthlyCommitment({
      profiles: {},
      month: '2026-04-15',
      brlRate: 5,
      accounts: accs('acc_a', 'acc_b'),
      accountProfiles: { acc_a: full('a', 100), acc_b: full('b', 200) },
    })
    expect(c?.usd).toBeCloseTo((300 * 30) / AVG_DAYS_PER_MONTH, 9)
    expect(c?.harnesses).toEqual(['claude'])
  })

  test('monthlyCommitment is partial when one account of the harness is short, even if the union spans the month', () => {
    const shortOne = timeline(sub('s', '2026-04-20', '2026-04-30', 30))
    const c = monthlyCommitment({
      profiles: {},
      month: '2026-04-15',
      brlRate: 5,
      accounts: accs('acc_a', 'acc_b'),
      accountProfiles: { acc_a: full('a', 100), acc_b: shortOne },
    })
    expect(c?.partial).toBe(true)
    expect(c?.usd).toBeCloseTo((100 * 30 + 30 * 11) / AVG_DAYS_PER_MONTH, 9)
  })

  test('monthlyCommitment refuses a harness with an invalid account timeline, whatever its siblings hold', () => {
    const bad = timeline(sub('x', '2026-04-01', '2026-04-20', 10), sub('y', '2026-04-10', '2026-04-30', 10))
    const apiOnly = timeline({ id: 'p', mode: 'api', from: '2026-04-01' } as BillingPeriod)
    const refused = monthlyCommitment({
      profiles: {},
      month: '2026-04-15',
      brlRate: 5,
      accounts: accs('acc_a', 'acc_b', 'acc_c'),
      accountProfiles: { acc_a: bad, acc_b: apiOnly, acc_c: full('c', 100) },
    })
    expect(refused).toBeNull()
    const valid = monthlyCommitment({
      profiles: {},
      month: '2026-04-15',
      brlRate: 5,
      accounts: accs('acc_b', 'acc_c'),
      accountProfiles: { acc_b: apiOnly, acc_c: full('c', 100) },
    })
    expect(valid?.hasUsageBilling).toBe(true)
    expect(valid?.usd).toBeCloseTo((100 * 30) / AVG_DAYS_PER_MONTH, 9)
  })

  test('monthlyCommitment without accounts is unchanged', () => {
    const profiles = { claude: full('d', 100) }
    const a = monthlyCommitment({ profiles, month: '2026-04-15', brlRate: 5 })
    const b = monthlyCommitment({ profiles, month: '2026-04-15', brlRate: 5, accountProfiles: { acc_a: full('a', 9) } })
    expect(b).toEqual(a)
  })

  test('normalizeBillingSettings reads accountProfiles and drops junk', () => {
    const s = normalizeBillingSettings({
      profiles: {},
      accountProfiles: { acc_a: { periods: [sub('a', '2026-04-01', undefined, 100), { bad: 1 }] }, acc_b: { periods: [] }, '': { periods: [sub('z', '2026-04-01', undefined, 1)] } },
    })
    expect(Object.keys(s.accountProfiles ?? {})).toEqual(['acc_a'])
    expect(s.accountProfiles?.acc_a?.periods).toHaveLength(1)
    expect(normalizeBillingSettings({ profiles: {} }).accountProfiles).toBeUndefined()
  })

  test('accountTimeline prefers the account, falls back to the harness', () => {
    const b = normalizeBillingSettings({
      profiles: { claude: full('d', 1) },
      accountProfiles: { acc_a: full('a', 2) },
    })
    expect(accountTimeline(b, 'claude', 'acc_a')?.periods[0]?.id).toBe('a')
    expect(accountTimeline(b, 'claude', 'acc_z')?.periods[0]?.id).toBe('d')
    expect(accountTimeline(b, 'codex')).toBeUndefined()
  })
})
