import type { Lang } from '@agentistics/core'

/**
 * The line under the cost KPI when part of a date-filtered window had to be priced by
 * `apportionModelUsage`'s global-proportions guess rather than the sessions' own counters.
 *
 * `useDerivedStats` now prices every day it can from `claudeExactUsageByDay` and falls back to
 * apportionment only for the days nothing in scope can answer — typically because Claude Code's
 * ~30-day retention already deleted the transcript, so `stats-cache.json` still has the day's
 * total but nothing per-session to slice it with. The house rule this note exists for: an
 * estimate that says it is one is fine, an estimate that reads like a measurement is the bug.
 *
 * `null` when nothing was estimated — appending an empty caveat to every cost card would be noise
 * on the overwhelming majority of windows, which sessions cover completely.
 */
export function costEstimateNote(estimatedDays: number, lang: Lang): string | null {
  if (estimatedDays <= 0) return null
  const pt = lang === 'pt'
  if (estimatedDays === 1) {
    return pt ? '1 dia estimado (sessão exata indisponível)' : '1 day estimated (no exact session)'
  }
  return pt
    ? `${estimatedDays} dias estimados (sessão exata indisponível)`
    : `${estimatedDays} days estimated (no exact session)`
}
