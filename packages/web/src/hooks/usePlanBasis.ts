/**
 * usePlanBasis.ts — turn the day-decomposed API cost plus the user's billing timeline into the
 * plan basis, once per render of the whole app.
 *
 * Computed ONE place and passed down, never re-derived per surface: two surfaces that each cut A
 * their own way would tell two different stories about the same filter, and the whole point of
 * the basis is that every cost on the page agrees.
 *
 * This module is wiring. Every decision lives in `@agentistics/core/billing`; what happens here is
 * the walk over `apiCostByDay` that splits A into "on subscription days", "on api days" and
 * "excluded", using `coveredDayKeys` as the only authority on which day is which.
 */
import { useMemo } from 'react'
import {
  aggregatePlanBasis,
  computePlanCost,
  type PlanAccountRef,
  resolvePlanBasis,
  resolveWindow,
  type AggregatePlanBasis,
  type ApiCostByDay,
  type BillingSettings,
  type Filters,
  type HarnessId,
  type HarnessPlanBasis,
  type PlanWindow,
} from '@agentistics/core'
import { getDateRangeFilter } from './useData'

export type PlanBasisBlock = 'no-window' | 'inconsistent-history' | 'central' | null

export interface PlanBasisView {
  /** `null` when no plan basis can be produced for this filter at all. */
  basis: AggregatePlanBasis | null
  /**
   * The days actually measured.
   *
   * Rendered BESIDE the multiple, always. A user who filtered "all time" and got a number over the
   * last 90 days — because that is as far back as the daily series reaches — has a correct figure
   * under a misleading heading, and the window is the only thing that corrects it.
   */
  window: PlanWindow | null
  blocked: PlanBasisBlock
}

const EMPTY: PlanBasisView = { basis: null, window: null, blocked: 'no-window' }
/**
 * A central produces NO basis at all.
 *
 * Forcing `costBasis` to `'api'` there is not enough: two surfaces read `planBasis` directly
 * rather than through the basis switch — Home's "API vs your plan" panel and the compare page's
 * per-side Plan button — so a central whose `preferences.json` still carried a timeline (a machine
 * that used to be solo, or a hand edit) would price a whole FLEET from its operator's own
 * subscription. Refusing at the single place the basis is computed is what makes that
 * unreachable rather than merely unrendered.
 */
const CENTRAL: PlanBasisView = { basis: null, window: null, blocked: 'central' }

/**
 * @param today injected for tests; defaults to the real UTC day.
 */
export function computePlanBasisView(args: {
  apiCostByDay: ApiCostByDay
  billing: BillingSettings
  brlRate: number
  filters: Filters
  /** This instance aggregates other machines — see `CENTRAL` above. */
  central?: boolean
  today?: string
  /** The machine's billable accounts. Absent, every harness prices on its single timeline. */
  accounts?: readonly PlanAccountRef[]
}): PlanBasisView {
  const { apiCostByDay, billing, brlRate, filters } = args
  if (args.central) return CENTRAL
  const today = args.today ?? new Date().toISOString().slice(0, 10)

  // A NEGATIVE residue means the day series accounts for more than the cumulative total it
  // decomposes. That used to withhold the basis, on the reading that the two local sources were
  // contradicting each other. It is no longer a contradiction: the Claude day series is now the
  // max-merge of the daily token series and the per-session costs, so a series richer than the
  // cumulative aggregate is the expected outcome, not a fault. Nothing of the headline is then
  // missing from the comparison, which is exactly what a zero residue says.

  const range = getDateRangeFilter(filters.dateRange, filters.customStart, filters.customEnd)
  const window = resolveWindow({
    filterStartMs: range.start.getTime(),
    filterEndMs: range.end.getTime(),
    dataFirstDay: apiCostByDay.firstDay,
    dataLastDay: apiCostByDay.lastDay,
    today,
  })
  if (!window) return EMPTY

  const parts: HarnessPlanBasis[] = []
  for (const [key, byDay] of Object.entries(apiCostByDay.days)) {
    const harness = key as HarnessId
    if (!byDay) continue

    const plan = computePlanCost({
      timeline: billing.profiles[harness], window, brlRate,
      accounts: args.accounts?.filter(a => a.harness === harness),
      accountProfiles: billing.accountProfiles,
    })

    let apiOnSubscriptionDays = 0
    let apiOnApiDays = 0
    let tokensCovered = 0
    let excludedSessions = 0
    let excludedApiCostUSD = 0

    for (const [day, entry] of Object.entries(byDay)) {
      // Days outside the window are not "uncovered" — they are not in scope at all, and counting
      // them as excluded would report a coverage gap the user cannot act on.
      if (day < window.from || day > window.to) continue
      if (!plan.coveredDayKeys.has(day)) {
        excludedSessions += entry.sessions
        excludedApiCostUSD += entry.costUSD
        continue
      }
      tokensCovered += entry.tokens
      if (plan.apiDayKeys.has(day)) apiOnApiDays += entry.costUSD
      else apiOnSubscriptionDays += entry.costUSD
    }

    parts.push({
      harness,
      basis: resolvePlanBasis({
        plan,
        apiCostOnSubscriptionDaysUSD: apiOnSubscriptionDays,
        apiCostOnApiDaysUSD: apiOnApiDays,
        tokensCovered,
        excludedSessions,
        excludedApiCostUSD,
        // The undated residue is Claude's alone — it comes from `statsCache.modelUsage`, which no
        // other harness has. Attributing it to each harness would multiply one fact by six.
        // Floored at zero: see the note above on a negative residue.
        undatedApiCostUSD: harness === 'claude' ? Math.max(0, apiCostByDay.undatedCostUSD) : 0,
      }),
    })
  }

  if (parts.length === 0) return { basis: null, window, blocked: 'no-window' }
  return { basis: aggregatePlanBasis(parts), window, blocked: null }
}

export function usePlanBasis(args: {
  apiCostByDay: ApiCostByDay | undefined
  billing: BillingSettings
  brlRate: number
  filters: Filters
  central?: boolean
  accounts?: readonly PlanAccountRef[]
}): PlanBasisView {
  const { apiCostByDay, billing, brlRate, filters, central, accounts } = args
  return useMemo(() => {
    if (central) return CENTRAL
    if (!apiCostByDay) return EMPTY
    return computePlanBasisView({ apiCostByDay, billing, brlRate, filters, accounts })
  }, [apiCostByDay, billing, brlRate, filters, central, accounts])
}
