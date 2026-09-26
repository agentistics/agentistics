/**
 * money.ts — the board prices in the reader's OWN currency AND basis, like every other screen.
 *
 * `fmtUSD` was the board's own formatter and it hardcoded a dollar sign, so a dashboard set to BRL
 * — the header, the cost page, the session cards, all of it in `R$` — answered `$12.07` on the one
 * screen whose entire subject is what work COST. Nothing was wrong with the number; it was labelled
 * with a currency the reader does not pay in, which is the same class of error as an unlabelled
 * total: it invites a comparison that is off by the exchange rate.
 *
 * The conversion is `@agentistics/core`'s `fmtCost` and the rate is the one `/api/rates` already
 * cached for the rest of the app, read off the page's own `AppContext`. Neither is re-derived here:
 * a second rate is a second answer, and the board would then disagree with the header above it.
 *
 * **The header's API/Plan switch used to do nothing here** — every figure on the board stayed in
 * API terms no matter which basis was selected, because this hook never read `costBasis` at all.
 * `viewCost` (`../../lib/costBasis`) is what every other screen applies before formatting.
 *
 * **The factor is PER HARNESS, and the caller must hand over the split.** The first fix used
 * `planAllocation(...).aggregateFactor` — the cross-harness ΣC/ΣA — for every row, on the reasoning
 * that a row may span harnesses. It priced an Antigravity-only delivery at what the CLAUDE
 * subscription is worth: flipping API → Plan took it from USD 5.17 to USD 124.81 with no plan
 * registered for Antigravity at all. So a figure is now formatted WITH its `costByHarness` split
 * (`AttemptRollup.costByHarness`, the overview's own splits) and `splitPlanFactor` prices each
 * slice at its own harness's factor, leaving an uncovered slice at its API figure. The split is a
 * REQUIRED argument so a new call site cannot quietly get the aggregate back; passing
 * `undefined` (an older server that sends no split) refuses the plan basis, which `viewCost` turns
 * into the API figure — true, where a guessed factor would not be.
 *
 * `null` stays `N/A`. A delivery nobody could price is not a delivery that cost nothing, and the
 * conversion must not turn one into `R$0,00`.
 */

import { useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { fmtCost } from '@agentistics/core'
import { NA } from './board'
import { splitPlanFactor, viewCost } from '../../lib/costBasis'
import type { AppContext } from '../../lib/app-context'

/** What the figure is made of, by harness — see the header. `undefined`/`null` refuses the plan basis. */
export type CostSplit = Readonly<Record<string, number>> | null | undefined

export type Money = (usd: number | null | undefined, byHarness: CostSplit) => string

/** The formatter with nothing to read the preference from — dollars, unconverted. */
export const usdOnly: Money = n => (n === null || n === undefined ? NA : fmtCost(n))

/**
 * Every board surface renders under a route, so the page's context is there to be read.
 *
 * It is read DEFENSIVELY all the same: a component mounted outside a router (a test, a future
 * embed) gets dollars rather than a crash, which is the one behaviour that cannot mislead — an
 * unconverted figure under its own `USD` label is true.
 */
export function useMoney(): Money {
  const ctx = useOutletContext<AppContext | null>()
  const currency = ctx?.currency ?? 'USD'
  const rate = ctx?.brlRate ?? 1
  const costBasis = ctx?.costBasis ?? 'api'
  const planBasis = ctx?.planBasis?.basis ?? null
  return useCallback(
    (n, byHarness) => {
      if (n === null || n === undefined) return NA
      const factor = costBasis === 'plan' ? splitPlanFactor(planBasis, byHarness) : null
      const view = viewCost(n, { basis: costBasis, factor, allocated: true })
      return fmtCost(view.usd, currency, rate)
    },
    [currency, rate, costBasis, planBasis],
  )
}
