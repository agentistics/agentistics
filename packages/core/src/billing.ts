/**
 * billing.ts — how the user is ACTUALLY billed, and the arithmetic that re-expresses cost in those
 * terms.
 *
 * Every cost elsewhere in this product is an API-EQUIVALENT estimate: tokens × `MODEL_PRICING`.
 * Most people are not billed that way — they pay a flat monthly subscription, and the estimate is
 * an answer to a question they never asked. This module supplies the missing input (a timeline of
 * what they actually pay) and the arithmetic that turns the estimate into two facts they can use:
 *
 *   C = what the plan cost over the window        V = A / C, the value multiple
 *   A = the API-equivalent cost over that window  effective $/1M = C / (tokens / 1e6)
 *
 * ── THE MODEL IS A TIMELINE, NOT A SETTING ───────────────────────────────────────────────────
 * A single "current plan" cannot price a window that spans a plan change, and there is NO per-
 * session record of which plan was in force — not in the transcripts, not in `~/.claude.json`,
 * nowhere. The user is the only source, so they declare PERIODS and each period prices its own
 * overlap with the window. Pro for three months then Max for two comes out right; anything
 * simpler comes out wrong and looks right.
 *
 * ── PRORATION IS BY DAYS, DELIBERATELY ───────────────────────────────────────────────────────
 * `C = monthly × days / 30.44`. Counting whole calendar months is the INVOICE reading and it is
 * the more literal one — you did pay $100 even if you used three days — but it cannot survive an
 * arbitrary filter window: a 7-day filter would report a whole month's price against a fifth of a
 * month's usage and call the plan a bad deal. Proration is the RATE reading, and a rate is what
 * makes a window comparable to any other window. The invoice reading belongs on a surface that is
 * genuinely about one billing cycle, not here.
 *
 * ── UNCOVERED DAYS ARE CUT FROM BOTH SIDES ───────────────────────────────────────────────────
 * A day no period covers has an A and no C. Including it inflates V; excluding it from C alone
 * inflates V harder. So it is removed from BOTH, and `coveredDayKeys` is the SINGLE source of
 * which days count — no caller may re-derive it, or A and C end up measuring different periods
 * and the ratio between them means nothing. The facts that makes that honest (how many days, how
 * many sessions, how much API value) travel in `PlanCoverage` so the UI can state them without
 * recomputing anything.
 *
 * ── WHAT MUST NEVER HAPPEN ───────────────────────────────────────────────────────────────────
 * Nothing here may return a confident number it cannot stand behind. A window with no covered day
 * is `unavailable`, not `0`; a multiple over a zero cost is `null`, not `Infinity`; a timeline
 * with overlapping periods is `unavailable` rather than the doubled C that the overlap would
 * produce. Overlaps are refused on entry AND re-checked here, because `preferences.json` is a
 * hand-editable file and a silently doubled bill is worse than no bill.
 */

import type { HarnessId } from './types'
import { HARNESS_ORDER } from './types'

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type BillingMode = 'subscription' | 'api' | 'thirdparty' | 'unknown'
export type BillingCurrency = 'USD' | 'BRL'
export type CostBasis = 'api' | 'plan'

/** A calendar day, `yyyy-MM-dd`. Textual, never a `Date` — see `tagSessionDay` for the same rule
 *  and the same reason: a local-clock day would put a 23:00 UTC-3 session inside one window while
 *  the chart beside it plots the session on the next day. */
export type BillingDay = string

export interface BillingPeriod {
  /** `bp_<hex>`. The timeline is edited BY ID, never by index — sorting a list must not retarget
   *  an in-flight edit onto a different period. */
  id: string
  mode: BillingMode
  /** A `plan-catalog.ts` id. Present only for `mode === 'subscription'`; `'other'` needs `label`. */
  planId?: string
  /** The user's own words, for `planId === 'other'` or a renamed catalog entry. */
  label?: string
  /** Monthly list price. REQUIRED for `subscription`, and MUST BE ABSENT for every other mode —
   *  an `api` period has no monthly price by definition (its C is its A), so a price sitting on
   *  one would be added to a cost that already contains it. `validatePeriod` refuses it. */
  price?: { amount: number; currency: BillingCurrency }
  /** Inclusive first day. */
  from: BillingDay
  /** Inclusive last day. ABSENT MEANS ONGOING — it does not mean "today". Resolving it to the day
   *  it was typed would leave every window after that day silently uncovered, which reads as "you
   *  had no plan" for the one period the user is most likely to be looking at. */
  to?: BillingDay
}

/** One harness's periods, unordered. */
export interface BillingTimeline {
  periods: BillingPeriod[]
}

export type BillingProfiles = Partial<Record<HarnessId, BillingTimeline>>

/**
 * `Preferences.billing`. LOCAL ONLY — this never enters `IngestBody`, a team doc or an audit
 * event. What someone pays is theirs, and a central has no use for it: it cannot price a fleet
 * from one operator's timeline anyway.
 */
export interface BillingSettings {
  profiles: BillingProfiles
  /** Set once the user dismisses the first-run invite for good. */
  introDismissed?: boolean
  /** The display basis. A preference exactly like `currency` — it changes no stored data. */
  costBasis?: CostBasis
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Day arithmetic — integer days since the epoch, UTC, no dependencies
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_DAY = 86_400_000

/** Average days per month. The proration constant: a period of exactly this many days costs
 *  exactly one month's price. */
export const AVG_DAYS_PER_MONTH = 30.44

/**
 * `yyyy-MM-dd` → days since 1970-01-01 UTC, or `null` if it is not a real day.
 *
 * The round-trip check is what rejects `2026-02-31`: `Date.UTC` rolls it forward to March 3rd
 * rather than failing, so a plain parse would silently accept a date the user never meant and
 * shift a period boundary by three days.
 */
export function dayIndex(day: unknown): number | null {
  if (typeof day !== 'string' || !DAY_PATTERN.test(day)) return null
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(5, 7))
  const date = Number(day.slice(8, 10))
  const ms = Date.UTC(year, month - 1, date)
  if (!Number.isFinite(ms)) return null
  const index = Math.floor(ms / MS_PER_DAY)
  return dayFromIndex(index) === day ? index : null
}

/** Days since 1970-01-01 UTC → `yyyy-MM-dd`. */
export function dayFromIndex(index: number): BillingDay {
  return new Date(index * MS_PER_DAY).toISOString().slice(0, 10)
}

/** A millisecond timestamp → the UTC day it falls on. The same `slice(0, 10)` rule as everywhere
 *  else in this module. */
export function dayFromMs(ms: number): BillingDay | null {
  if (!Number.isFinite(ms)) return null
  const day = new Date(ms).toISOString().slice(0, 10)
  return dayIndex(day) === null ? null : day
}

/** `true` when `day` is a well-formed, real calendar day. */
export function isBillingDay(day: unknown): day is BillingDay {
  return dayIndex(day) !== null
}

/** A period's `[start, end]` in day indices, `end === Infinity` while it is ongoing.
 *  `null` when either bound is unparseable. */
function periodRange(p: BillingPeriod): { start: number; end: number } | null {
  const start = dayIndex(p.from)
  if (start === null) return null
  if (p.to === undefined || p.to === null || p.to === '') return { start, end: Number.POSITIVE_INFINITY }
  const end = dayIndex(p.to)
  if (end === null || end < start) return null
  return { start, end }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type BillingPeriodError =
  | { code: 'missing_from' }
  | { code: 'bad_day'; field: 'from' | 'to'; value: string }
  | { code: 'inverted_range'; from: BillingDay; to: BillingDay }
  | { code: 'missing_plan' }
  | { code: 'missing_label' }
  | { code: 'missing_price' }
  | { code: 'non_positive_price'; amount: number }
  | { code: 'price_on_non_subscription'; mode: BillingMode }
  | { code: 'overlap'; withId: string }

/**
 * Do two periods claim the same day?
 *
 * Both bounds are INCLUSIVE, so `a.to === b.from` IS an overlap — that day would otherwise be
 * priced twice. Two ongoing periods always overlap; an unparseable period cannot be shown to
 * overlap anything and reports `false` (its own `bad_day` error is what the user needs to see).
 */
export function periodsOverlap(a: BillingPeriod, b: BillingPeriod): boolean {
  const ra = periodRange(a)
  const rb = periodRange(b)
  if (!ra || !rb) return false
  return ra.start <= rb.end && rb.start <= ra.end
}

/** Chronological, ongoing periods last within the same start day. Stable on `id` so a redraw
 *  never reorders two periods that begin on the same day. */
export function sortPeriods(periods: readonly BillingPeriod[]): BillingPeriod[] {
  return [...periods].sort((x, y) => {
    const rx = periodRange(x)
    const ry = periodRange(y)
    const sx = rx ? rx.start : Number.POSITIVE_INFINITY
    const sy = ry ? ry.start : Number.POSITIVE_INFINITY
    if (sx !== sy) return sx - sy
    const ex = rx ? rx.end : Number.POSITIVE_INFINITY
    const ey = ry ? ry.end : Number.POSITIVE_INFINITY
    if (ex !== ey) return ex - ey
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
  })
}

/**
 * Everything wrong with one period, including overlaps against `others`.
 *
 * `others` must EXCLUDE the period itself, so editing one never reports it overlapping its own
 * previous self — the form would then refuse every edit that did not move the dates.
 */
export function validatePeriod(
  period: BillingPeriod,
  others: readonly BillingPeriod[] = [],
): BillingPeriodError[] {
  const errors: BillingPeriodError[] = []

  if (typeof period.from !== 'string' || period.from === '') {
    errors.push({ code: 'missing_from' })
  } else if (dayIndex(period.from) === null) {
    errors.push({ code: 'bad_day', field: 'from', value: period.from })
  }

  const hasTo = typeof period.to === 'string' && period.to !== ''
  if (hasTo && dayIndex(period.to as string) === null) {
    errors.push({ code: 'bad_day', field: 'to', value: period.to as string })
  }

  if (hasTo && dayIndex(period.from) !== null && dayIndex(period.to as string) !== null) {
    if ((dayIndex(period.to as string) as number) < (dayIndex(period.from) as number)) {
      errors.push({ code: 'inverted_range', from: period.from, to: period.to as string })
    }
  }

  if (period.mode === 'subscription') {
    if (!period.planId) errors.push({ code: 'missing_plan' })
    if (period.planId === 'other' && !period.label?.trim()) errors.push({ code: 'missing_label' })
    if (!period.price) {
      errors.push({ code: 'missing_price' })
    } else if (!(Number.isFinite(period.price.amount) && period.price.amount > 0)) {
      errors.push({ code: 'non_positive_price', amount: period.price.amount })
    }
  } else if (period.price) {
    errors.push({ code: 'price_on_non_subscription', mode: period.mode })
  }

  for (const other of others) {
    if (other.id === period.id) continue
    if (periodsOverlap(period, other)) errors.push({ code: 'overlap', withId: other.id })
  }

  return errors
}

/** Every period's errors, keyed by id. An empty map means the timeline is sound. */
export function validateTimeline(timeline: BillingTimeline): Map<string, BillingPeriodError[]> {
  const out = new Map<string, BillingPeriodError[]>()
  for (const period of timeline.periods) {
    const errors = validatePeriod(period, timeline.periods)
    if (errors.length > 0) out.set(period.id, errors)
  }
  return out
}

export function timelineIsValid(timeline: BillingTimeline): boolean {
  return validateTimeline(timeline).size === 0
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Readiness — may the plan basis be OFFERED at all?
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One reason the plan basis cannot be computed, specific enough for the UI to ask for exactly
 *  the missing thing and nothing else. */
export type BillingGap =
  | { code: 'no_timeline'; harness: HarnessId }
  | { code: 'invalid_timeline'; harness: HarnessId }
  | {
      code: 'incomplete_period'
      harness: HarnessId
      periodId: string
      planId?: string
      label?: string
      errors: BillingPeriodError[]
    }

export interface BillingReadiness {
  /** The plan basis may be offered. */
  ready: boolean
  /** The harnesses in scope that can actually produce a plan cost. */
  readyHarnesses: HarnessId[]
  /** Exactly what is still missing. */
  gaps: BillingGap[]
}

/**
 * Can the plan basis be computed for anything in scope?
 *
 * The toggle is DISABLED until this says yes, and pressing it opens the setup prompt instead of
 * doing nothing. A control that is enabled and then silently renders N/A teaches the user that
 * the feature is broken; a control that is disabled and says what it needs teaches them how to
 * turn it on. This is the same distinction the product already draws between N/A and a confident
 * zero, applied to an affordance instead of a number.
 *
 * The gaps are deliberately fine-grained, because the prompt must ask ONLY for what is actually
 * missing. Detection can supply the mode and often the exact plan, and the catalog supplies a
 * verified price for most plans — so in the common case the only thing left is the START DATE,
 * which no file on any machine records. Asking for a plan the user already has detected, or for
 * a price the catalog already knows, is how a two-field prompt becomes one nobody finishes.
 */
export function billingReadiness(
  settings: BillingSettings,
  harnessesInScope: readonly HarnessId[],
): BillingReadiness {
  const readyHarnesses: HarnessId[] = []
  const gaps: BillingGap[] = []

  for (const harness of harnessesInScope) {
    const timeline = settings.profiles[harness]
    if (!timeline || timeline.periods.length === 0) {
      gaps.push({ code: 'no_timeline', harness })
      continue
    }

    const errorsById = validateTimeline(timeline)
    if (errorsById.size === 0) {
      readyHarnesses.push(harness)
      continue
    }

    // An overlap is a property of the timeline, not of one period — reporting it per row would
    // ask the user to fix the same fact twice.
    const overlapping = [...errorsById.values()].some((errors) =>
      errors.some((e) => e.code === 'overlap'),
    )
    if (overlapping) {
      gaps.push({ code: 'invalid_timeline', harness })
      continue
    }

    for (const period of sortPeriods(timeline.periods)) {
      const errors = errorsById.get(period.id)
      if (!errors || errors.length === 0) continue
      gaps.push({
        code: 'incomplete_period',
        harness,
        periodId: period.id,
        planId: period.planId,
        label: period.label,
        errors,
      })
    }
  }

  return {
    ready: readyHarnesses.length > 0,
    readyHarnesses: readyHarnesses.sort(
      (a, b) => HARNESS_ORDER.indexOf(a) - HARNESS_ORDER.indexOf(b),
    ),
    gaps,
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The window
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PlanWindow {
  /** Inclusive. */
  from: BillingDay
  /** Inclusive. */
  to: BillingDay
}

/**
 * The window a plan cost may honestly be prorated over.
 *
 * `getDateRangeFilter('all', …)` returns `new Date(0)` as its start, so the filter's own window
 * begins in 1970. Prorating a subscription across 56 years — or reporting "0.02% coverage"
 * forever — is the first wrong number this feature could ship, so the filter window is CLAMPED to
 * the days data actually exists on, and to today at the far end, because nobody is billed for the
 * future.
 *
 * Returns `null` when there is nothing to compare: no data at all, or a filter window that misses
 * the data entirely. `null` means N/A, and is never a zero-day window whose coverage would divide
 * by zero.
 *
 * `today` is injected rather than read, so this stays pure and its tests stay deterministic.
 */
export function resolveWindow(args: {
  filterStartMs: number
  filterEndMs: number
  dataFirstDay: BillingDay | null
  dataLastDay: BillingDay | null
  today: BillingDay
}): PlanWindow | null {
  const { filterStartMs, filterEndMs, dataFirstDay, dataLastDay, today } = args

  const dataStart = dayIndex(dataFirstDay)
  const dataEnd = dayIndex(dataLastDay)
  const todayIndex = dayIndex(today)
  if (dataStart === null || dataEnd === null || todayIndex === null) return null

  const filterStartDay = dayFromMs(filterStartMs)
  const filterEndDay = dayFromMs(filterEndMs)
  const filterStart = filterStartDay === null ? dataStart : (dayIndex(filterStartDay) as number)
  const filterEnd = filterEndDay === null ? dataEnd : (dayIndex(filterEndDay) as number)

  const start = Math.max(filterStart, dataStart)
  const end = Math.min(filterEnd, dataEnd, todayIndex)
  if (start > end) return null

  return { from: dayFromIndex(start), to: dayFromIndex(end) }
}

/** Inclusive day count of a window. `0` when the window is malformed. */
export function windowDayCount(window: PlanWindow): number {
  const start = dayIndex(window.from)
  const end = dayIndex(window.to)
  if (start === null || end === null || end < start) return 0
  return end - start + 1
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The plan cost
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One period's window-clipped contribution. The settings screen and the KPI tooltip both list
 *  these, so "which plan, for how many days, at what price" is answerable without recomputing. */
export interface PlanSegment {
  periodId: string
  mode: BillingMode
  planId?: string
  label?: string
  /** Window-clipped, inclusive. */
  from: BillingDay
  to: BillingDay
  /** Inclusive, always >= 1. */
  days: number
  /** The monthly price in USD. `null` for every mode but `subscription`, and for a subscription
   *  whose currency could not be converted. */
  monthlyUSD: number | null
  /** `monthlyUSD × days / 30.44`. ZERO for `api`, whose cost is its A — a number this module
   *  never sees. `resolvePlanBasis` adds it. */
  costUSD: number
  /** `false` when this segment's days count as uncovered: a third-party or unknown period, or a
   *  price that could not be converted. */
  covered: boolean
}

export interface PlanCostResult {
  /** The SUBSCRIPTION half of C. `api` days contribute 0 here by construction. */
  subscriptionCostUSD: number
  windowDays: number
  /** Days covered by a period with a computable cost — `subscription` or `api`. */
  coveredDays: number
  /** Days with no period, a `thirdparty`/`unknown` period, or an unconvertible price. */
  uncoveredDays: number
  /** `coveredDays / windowDays`, or 0 when the window is empty. */
  coverageRatio: number
  /** THE single source of which days count. A must be cut to exactly this set. */
  coveredDayKeys: ReadonlySet<BillingDay>
  /** The subset of `coveredDayKeys` in `api` mode, where C = A. */
  apiDayKeys: ReadonlySet<BillingDay>
  segments: PlanSegment[]
  /** The rate actually applied, so the UI can say the figure moves with the exchange rate.
   *  `null` when no usable rate was available — reporting the unusable input as "the rate used"
   *  would put a `NaN` on screen and claim it was applied. */
  usedBrlRate: number | null
  /** A BRL price could not be converted; its days went to `uncoveredDays` rather than yielding
   *  `Infinity`. */
  brlRateUnusable: boolean
  /** The timeline is internally inconsistent — overlaps survived a hand edit. The whole result is
   *  then unusable: overlapping periods double C, and a silently doubled bill is worse than none. */
  invalidTimeline: boolean
  /** `coveredDays === 0 || invalidTimeline`. Render N/A, never 0. */
  unavailable: boolean
}

/**
 * C over a window, plus every fact needed to say how much of the window it actually covers.
 *
 * Never throws and never returns a non-finite number. A period it cannot read is skipped and its
 * days are uncovered — one malformed row must not take the whole figure down with it.
 */
export function computePlanCost(args: {
  timeline: BillingTimeline | undefined
  window: PlanWindow
  /** BRL→USD divisor (`amountUSD = amount / brlRate`), from `AppContext.brlRate`. */
  brlRate: number
}): PlanCostResult {
  const { timeline, window, brlRate } = args

  const windowStart = dayIndex(window.from)
  const windowEnd = dayIndex(window.to)
  const windowDays = windowDayCount(window)

  const coveredDayKeys = new Set<BillingDay>()
  const apiDayKeys = new Set<BillingDay>()
  const segments: PlanSegment[] = []
  let subscriptionCostUSD = 0
  let brlRateUnusable = false

  const rateUsable = Number.isFinite(brlRate) && brlRate > 0
  const usedBrlRate = rateUsable ? brlRate : null

  const empty = (invalid: boolean): PlanCostResult => ({
    subscriptionCostUSD: 0,
    windowDays,
    coveredDays: 0,
    uncoveredDays: windowDays,
    coverageRatio: 0,
    coveredDayKeys: new Set(),
    apiDayKeys: new Set(),
    segments: invalid ? segments : [],
    usedBrlRate,
    brlRateUnusable: false,
    invalidTimeline: invalid,
    unavailable: true,
  })

  if (windowStart === null || windowEnd === null || windowDays === 0) return empty(false)
  if (!timeline || timeline.periods.length === 0) return empty(false)
  if (!timelineIsValid(timeline)) return empty(true)

  for (const period of sortPeriods(timeline.periods)) {
    const range = periodRange(period)
    if (!range) continue

    const start = Math.max(range.start, windowStart)
    const end = Math.min(range.end, windowEnd)
    if (start > end) continue
    const days = end - start + 1

    let monthlyUSD: number | null = null
    let covered = false

    if (period.mode === 'subscription' && period.price) {
      if (period.price.currency === 'BRL') {
        if (rateUsable) {
          monthlyUSD = period.price.amount / brlRate
          covered = true
        } else {
          // An unconvertible price must not become Infinity, and must not silently become free
          // either — the days go uncovered, which the coverage sentence then reports.
          brlRateUnusable = true
        }
      } else {
        monthlyUSD = period.price.amount
        covered = true
      }
    } else if (period.mode === 'api') {
      // C = A on these days. The A is added by `resolvePlanBasis`; the segment carries 0 so that
      // summing `segments[].costUSD` can never double-count it.
      covered = true
    }

    const costUSD = monthlyUSD === null ? 0 : (monthlyUSD * days) / AVG_DAYS_PER_MONTH
    if (covered) {
      subscriptionCostUSD += costUSD
      for (let i = start; i <= end; i++) {
        const day = dayFromIndex(i)
        coveredDayKeys.add(day)
        if (period.mode === 'api') apiDayKeys.add(day)
      }
    }

    segments.push({
      periodId: period.id,
      mode: period.mode,
      planId: period.planId,
      label: period.label,
      from: dayFromIndex(start),
      to: dayFromIndex(end),
      days,
      monthlyUSD,
      costUSD,
      covered,
    })
  }

  const coveredDays = coveredDayKeys.size
  return {
    subscriptionCostUSD,
    windowDays,
    coveredDays,
    uncoveredDays: windowDays - coveredDays,
    coverageRatio: windowDays === 0 ? 0 : coveredDays / windowDays,
    coveredDayKeys,
    apiDayKeys,
    segments,
    usedBrlRate,
    brlRateUnusable,
    invalidTimeline: false,
    unavailable: coveredDays === 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The basis
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PlanCoverage {
  coveredDays: number
  uncoveredDays: number
  windowDays: number
  ratio: number
  /** `false` ⇒ render N/A. Never render a number when this is false. */
  computable: boolean
  /** Sessions dropped because their day is uncovered, and what they were worth. "82% coverage" is
   *  weak; "USD 340 of API value excluded" is what a user can actually judge. */
  excludedSessions: number
  excludedApiCostUSD: number
  /** Claude history no day can be attributed to. Real spend that is neither in nor out — see
   *  `ApiCostByDay.undatedCostUSD`. Nonzero means the coverage sentence must name it. */
  undatedApiCostUSD: number
  invalidTimeline: boolean
  brlRateUnusable: boolean
}

export interface PlanBasisResult {
  /** C = the subscription cost over covered days, plus A over the `api`-mode days. */
  planCostUSD: number
  /** A, cut to `coveredDayKeys`. NEVER the unrestricted `derived.totalCostUSD`. */
  apiCostUSD: number
  /** V = A / C. `null` when C is 0 — an infinite multiple is not a fact. */
  multiple: number | null
  /** C / (tokens / 1e6). `null` when there are no tokens. */
  effectiveCostPerMTokens: number | null
  /** The denominator above, so no caller re-sums it. */
  tokensCovered: number
  coverage: PlanCoverage
  segments: PlanSegment[]
}

/**
 * Combine a plan cost with the API cost over the SAME days.
 *
 * The two A inputs are named separately and explicitly. They could have been one number, but then
 * passing an uncut `derived.totalCostUSD` — A over every day, against a C over some days — would
 * be an invisible mistake that produces a plausible, wrong multiple. Named parameters make it a
 * visible one.
 */
export function resolvePlanBasis(args: {
  plan: PlanCostResult
  /** A over `plan.coveredDayKeys` MINUS `plan.apiDayKeys`. */
  apiCostOnSubscriptionDaysUSD: number
  /** A over `plan.apiDayKeys`. Added to C verbatim, since C = A there. */
  apiCostOnApiDaysUSD: number
  tokensCovered: number
  excludedSessions: number
  excludedApiCostUSD: number
  undatedApiCostUSD: number
}): PlanBasisResult {
  const {
    plan,
    apiCostOnSubscriptionDaysUSD,
    apiCostOnApiDaysUSD,
    tokensCovered,
    excludedSessions,
    excludedApiCostUSD,
    undatedApiCostUSD,
  } = args

  const computable = !plan.unavailable && !plan.invalidTimeline

  const planCostUSD = computable ? plan.subscriptionCostUSD + apiCostOnApiDaysUSD : 0
  const apiCostUSD = computable ? apiCostOnSubscriptionDaysUSD + apiCostOnApiDaysUSD : 0

  const multiple = computable && planCostUSD > 0 ? apiCostUSD / planCostUSD : null
  const effectiveCostPerMTokens =
    computable && tokensCovered > 0 ? planCostUSD / (tokensCovered / 1_000_000) : null

  return {
    planCostUSD,
    apiCostUSD,
    multiple,
    effectiveCostPerMTokens,
    tokensCovered: computable ? tokensCovered : 0,
    coverage: {
      coveredDays: plan.coveredDays,
      uncoveredDays: plan.uncoveredDays,
      windowDays: plan.windowDays,
      ratio: plan.coverageRatio,
      computable,
      excludedSessions,
      excludedApiCostUSD,
      undatedApiCostUSD,
      invalidTimeline: plan.invalidTimeline,
      brlRateUnusable: plan.brlRateUnusable,
    },
    segments: plan.segments,
  }
}

export interface HarnessPlanBasis {
  harness: HarnessId
  basis: PlanBasisResult
}

export interface AggregatePlanBasis {
  planCostUSD: number
  apiCostUSD: number
  multiple: number | null
  effectiveCostPerMTokens: number | null
  /** Day-weighted across the harnesses in scope: Σ covered / Σ window, in HARNESS-DAYS. The unit
   *  is stated in words wherever this is rendered — printed bare as "days" it would read as
   *  calendar days and double for a two-harness scope. */
  coverage: PlanCoverage
  perHarness: Partial<Record<HarnessId, PlanBasisResult>>
  /** Harnesses present in the filtered scope with no usable timeline. Named in the UI, because
   *  "Codex and Gemini have no registered plan" is a fact the user can act on. */
  uncoveredHarnesses: HarnessId[]
}

/** Roll per-harness results into one. Only harnesses whose basis is computable contribute to the
 *  totals; the rest are NAMED instead, never averaged in as zeros. */
export function aggregatePlanBasis(parts: readonly HarnessPlanBasis[]): AggregatePlanBasis {
  const perHarness: Partial<Record<HarnessId, PlanBasisResult>> = {}
  const uncovered: HarnessId[] = []

  let planCostUSD = 0
  let apiCostUSD = 0
  let tokensCovered = 0
  let coveredDays = 0
  let uncoveredDays = 0
  let windowDays = 0
  let excludedSessions = 0
  let excludedApiCostUSD = 0
  let undatedApiCostUSD = 0
  let invalidTimeline = false
  let brlRateUnusable = false
  let anyComputable = false

  for (const { harness, basis } of parts) {
    perHarness[harness] = basis
    invalidTimeline = invalidTimeline || basis.coverage.invalidTimeline
    brlRateUnusable = brlRateUnusable || basis.coverage.brlRateUnusable
    undatedApiCostUSD += basis.coverage.undatedApiCostUSD

    if (!basis.coverage.computable) {
      uncovered.push(harness)
      continue
    }
    anyComputable = true
    planCostUSD += basis.planCostUSD
    apiCostUSD += basis.apiCostUSD
    tokensCovered += basis.tokensCovered
    coveredDays += basis.coverage.coveredDays
    uncoveredDays += basis.coverage.uncoveredDays
    windowDays += basis.coverage.windowDays
    excludedSessions += basis.coverage.excludedSessions
    excludedApiCostUSD += basis.coverage.excludedApiCostUSD
  }

  return {
    planCostUSD,
    apiCostUSD,
    multiple: anyComputable && planCostUSD > 0 ? apiCostUSD / planCostUSD : null,
    effectiveCostPerMTokens:
      anyComputable && tokensCovered > 0 ? planCostUSD / (tokensCovered / 1_000_000) : null,
    coverage: {
      coveredDays,
      uncoveredDays,
      windowDays,
      ratio: windowDays === 0 ? 0 : coveredDays / windowDays,
      computable: anyComputable,
      excludedSessions,
      excludedApiCostUSD,
      undatedApiCostUSD,
      invalidTimeline,
      brlRateUnusable,
    },
    perHarness,
    uncoveredHarnesses: uncovered.sort(
      (a, b) => HARNESS_ORDER.indexOf(a) - HARNESS_ORDER.indexOf(b),
    ),
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The monthly commitment
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface MonthlyCommitment {
  /** The fixed subscription cost for the month, in USD. */
  usd: number
  /** The harnesses contributing to it, in display order. */
  harnesses: HarnessId[]
  /** A subscription did not cover the whole month — it started or ended inside it, so this figure
   *  is the prorated part rather than a full month's price. Worth saying out loud: an unexplained
   *  "USD 63" where the user expects USD 100 reads as a bug. */
  partial: boolean
  /** At least one harness is billed per token in this month, so there is variable spend ON TOP of
   *  this commitment and the number is a floor rather than the total. */
  hasUsageBilling: boolean
}

/**
 * What the registered plans COMMIT to for one calendar month, regardless of any filter.
 *
 * This is a different question from `computePlanCost`, and deliberately so. That one prices a
 * filter window to compare against usage; this one answers "what do I owe this month", which is
 * what a monthly budget is set against. `api`-mode days contribute NOTHING here — their cost is
 * usage, not a commitment, and folding a usage figure into a commitment would make the number
 * neither.
 *
 * Returns `null` when no period covers any day of the month: there is no commitment to state, and
 * zero would read as "your plans are free".
 */
export function monthlyCommitment(args: {
  profiles: BillingProfiles
  /** Any day in the month of interest. */
  month: BillingDay
  brlRate: number
}): MonthlyCommitment | null {
  const { profiles, month, brlRate } = args
  const index = dayIndex(month)
  if (index === null) return null

  const first = `${month.slice(0, 7)}-01`
  const firstIndex = dayIndex(first)
  if (firstIndex === null) return null
  // The last day of the month: step to the first of the next month and back one.
  const year = Number(month.slice(0, 4))
  const mon = Number(month.slice(5, 7))
  const nextFirst = Math.floor(Date.UTC(mon === 12 ? year + 1 : year, mon === 12 ? 0 : mon, 1) / MS_PER_DAY)
  const window: PlanWindow = { from: first, to: dayFromIndex(nextFirst - 1) }
  const monthDays = windowDayCount(window)

  let usd = 0
  let anyPartial = false
  let hasUsageBilling = false
  const harnesses: HarnessId[] = []

  for (const [key, timeline] of Object.entries(profiles) as [HarnessId, BillingTimeline][]) {
    if (!timeline) continue
    const plan = computePlanCost({ timeline, window, brlRate })
    if (plan.unavailable && plan.apiDayKeys.size === 0) continue
    if (plan.apiDayKeys.size > 0) hasUsageBilling = true
    if (plan.subscriptionCostUSD > 0) {
      usd += plan.subscriptionCostUSD
      harnesses.push(key)
      // ANY contributing subscription that does not span the whole month makes the TOTAL a
      // prorated figure. Taking the longest coverage instead would report a full month whenever
      // one plan happened to span it, leaving the short one's proration unexplained — the total
      // is smaller than the sum of the monthly prices and nothing on screen would say why.
      if (plan.coveredDays < monthDays) anyPartial = true
    }
  }

  if (harnesses.length === 0 && !hasUsageBilling) return null

  return {
    usd,
    harnesses: harnesses.sort((a, b) => HARNESS_ORDER.indexOf(a) - HARNESS_ORDER.indexOf(b)),
    partial: harnesses.length > 0 && anyPartial,
    hasUsageBilling,
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Allocation
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PlanAllocation {
  /** C_h / A_h over the whole scope; uncovered days contribute at their API price. */
  byHarness: Partial<Record<HarnessId, number | null>>
  /** ΣC / ΣA over the whole scope, for legacy single-factor surfaces. */
  aggregateFactor: number | null
}

export function planAllocation(agg: AggregatePlanBasis): PlanAllocation {
  const byHarness: Partial<Record<HarnessId, number | null>> = {}
  let totalPlan = 0
  let totalApi = 0
  for (const [harness, basis] of Object.entries(agg.perHarness) as [HarnessId, PlanBasisResult][]) {
    const fallbackApi = (basis.coverage.excludedApiCostUSD ?? 0) + (basis.coverage.undatedApiCostUSD ?? 0)
    const api = basis.apiCostUSD + fallbackApi
    const plan = basis.planCostUSD + fallbackApi
    byHarness[harness] = basis.coverage.computable && api > 0 ? plan / api : null
    if (byHarness[harness] !== null && byHarness[harness] !== undefined) {
      totalPlan += plan
      totalApi += api
    }
  }
  return {
    byHarness,
    aggregateFactor: agg.coverage.computable && totalApi > 0
      ? totalPlan / totalApi
      : null,
  }
}

/**
 * Spread a plan cost across rows in proportion to each row's share of A.
 *
 * WITHIN ONE HARNESS this is a linear rescale by C/A, so every ranking, every proportion and every
 * percentage survives EXACTLY. Across harnesses the factors differ, so a plan-basis ordering can
 * legitimately differ from the API one — a Max subscription makes Claude rows cheap — and the
 * LABEL is the only thing that stops that being read as a measurement.
 *
 * It IS an allocation, not a measurement: no row was individually billed, and nobody can say what
 * share of a flat monthly fee a given model "used". Rows whose A sums to zero get zero — never
 * NaN, and deliberately never an even split, which would invent attribution for work that cost
 * nothing.
 */
export function allocatePlanCost<T>(
  rows: readonly T[],
  apiCostOf: (row: T) => number,
  planCostUSD: number,
): number[] {
  const costs = rows.map((row) => {
    const value = apiCostOf(row)
    return Number.isFinite(value) && value > 0 ? value : 0
  })
  const total = costs.reduce((sum, value) => sum + value, 0)
  if (total <= 0 || !Number.isFinite(planCostUSD)) return costs.map(() => 0)
  return costs.map((value) => (value / total) * planCostUSD)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The day-granular API cost series
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DayCost {
  costUSD: number
  tokens: number
  sessions: number
}

/**
 * A, decomposed by day and harness — the input that lets A be cut to the same days as C.
 *
 * `undatedCostUSD` is the residue, and it is not an edge case. In the unfiltered view Claude's
 * total comes from `statsCache.modelUsage`, an ALL-TIME total with no day attribution, while the
 * only day series (`dailyModelTokens`) does not sum to it. So a per-day A that closes exactly on
 * `totalCostUSD` does not exist. That difference is real spend which can be neither included in
 * nor excluded from a windowed comparison honestly, so it is carried here and NAMED in the UI
 * rather than quietly dropped into whichever side happens to be convenient.
 *
 * INVARIANT (pinned by useData.test.ts): Σ days[*][*].costUSD + undatedCostUSD === totalCostUSD.
 */
export interface ApiCostByDay {
  days: Partial<Record<HarnessId, Record<BillingDay, DayCost>>>
  undatedCostUSD: number
  undatedTokens: number
  /** The extremes of `days`, so `resolveWindow` need not rescan. */
  firstDay: BillingDay | null
  lastDay: BillingDay | null
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────────────────────────

const MODES: readonly BillingMode[] = ['subscription', 'api', 'thirdparty', 'unknown']

function normalizePeriod(raw: unknown): BillingPeriod | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  if (typeof r.id !== 'string' || r.id === '') return null
  if (typeof r.mode !== 'string' || !MODES.includes(r.mode as BillingMode)) return null
  if (!isBillingDay(r.from)) return null

  const period: BillingPeriod = { id: r.id, mode: r.mode as BillingMode, from: r.from }

  if (isBillingDay(r.to)) period.to = r.to
  if (typeof r.planId === 'string' && r.planId !== '') period.planId = r.planId
  if (typeof r.label === 'string' && r.label !== '') period.label = r.label

  if (r.price && typeof r.price === 'object') {
    const p = r.price as Record<string, unknown>
    const amount = typeof p.amount === 'number' ? p.amount : Number(p.amount)
    const currency = p.currency === 'BRL' ? 'BRL' : 'USD'
    if (Number.isFinite(amount) && amount > 0) period.price = { amount, currency }
  }

  return period
}

/**
 * Read whatever is in `preferences.json` into a `BillingSettings` we can compute against.
 *
 * Total, and never throws. One malformed period drops itself and the rest survive: this file is
 * hand-editable, and a dashboard that goes blank because a comma moved is a worse failure than a
 * timeline that is missing one row and says so.
 */
export function normalizeBillingSettings(raw: unknown): BillingSettings {
  const settings: BillingSettings = { profiles: {} }
  if (!raw || typeof raw !== 'object') return settings

  const r = raw as Record<string, unknown>
  if (r.introDismissed === true) settings.introDismissed = true
  if (r.costBasis === 'plan' || r.costBasis === 'api') settings.costBasis = r.costBasis

  if (r.profiles && typeof r.profiles === 'object') {
    for (const [key, value] of Object.entries(r.profiles as Record<string, unknown>)) {
      if (!HARNESS_ORDER.includes(key as HarnessId)) continue
      const periodsRaw = (value as Record<string, unknown> | null)?.periods
      if (!Array.isArray(periodsRaw)) continue
      const periods = periodsRaw
        .map(normalizePeriod)
        .filter((p): p is BillingPeriod => p !== null)
      if (periods.length > 0) settings.profiles[key as HarnessId] = { periods }
    }
  }

  return settings
}
