/**
 * The cache figures of one model-usage map: hit rate, totals, the savings estimate and the per-model
 * hit rate. Moved verbatim out of `computeDerivedStats` so the projected path (A4.7,
 * `projectedDerived.ts`) prices its own usage with exactly the same arithmetic.
 */
import type { ModelUsage } from '@agentistics/core'

export interface BlendedRate { input: number; cacheRead: number; cacheWrite: number }

export function cacheFiguresOf(modelUsage: Record<string, ModelUsage>, blended: BlendedRate) {
  const cacheTotals = Object.values(modelUsage).reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + (u.inputTokens ?? 0),
      cacheReadInputTokens: acc.cacheReadInputTokens + (u.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: acc.cacheCreationInputTokens + (u.cacheCreationInputTokens ?? 0),
    }),
    { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  )
  const cacheDenominator = cacheTotals.inputTokens + cacheTotals.cacheReadInputTokens + cacheTotals.cacheCreationInputTokens
  const cacheHitRate = cacheDenominator > 0 ? cacheTotals.cacheReadInputTokens / cacheDenominator : 0

  // What cacheRead tokens would have cost as plain input
  const cacheHypotheticalInputUSD = (cacheTotals.cacheReadInputTokens / 1_000_000) * blended.input
  // What cacheRead tokens actually cost
  const cacheActualReadUSD = (cacheTotals.cacheReadInputTokens / 1_000_000) * blended.cacheRead
  // Gross savings vs paying as regular input
  const cacheGrossSavedUSD = cacheHypotheticalInputUSD - cacheActualReadUSD
  // Premium paid for cache writes (extra over regular input)
  const cacheWriteOverheadUSD = Math.max(
    0,
    (cacheTotals.cacheCreationInputTokens / 1_000_000) * (blended.cacheWrite - blended.input),
  )
  // Net savings
  const cacheNetSavedUSD = cacheGrossSavedUSD - cacheWriteOverheadUSD

  // Per-model hit rate (only for models with data)
  const cachePerModel: Record<string, { hitRate: number; cacheReadTokens: number; inputTokens: number }> = {}
  for (const [modelId, u] of Object.entries(modelUsage)) {
    const denom = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
    if (denom === 0) continue
    cachePerModel[modelId] = {
      hitRate: (u.cacheReadInputTokens ?? 0) / denom,
      cacheReadTokens: u.cacheReadInputTokens ?? 0,
      inputTokens: u.inputTokens ?? 0,
    }
  }
  return { cacheTotals, cacheHitRate, cacheGrossSavedUSD, cacheWriteOverheadUSD, cacheNetSavedUSD, cachePerModel }
}
