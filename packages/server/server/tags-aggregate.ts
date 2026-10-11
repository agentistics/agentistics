/**
 * tags-aggregate.ts — PURE aggregation of a session set into a tag's headline numbers.
 *
 * Always per-session sums: `stats-cache.json` is Claude-only and must never back a tag total.
 * Cost goes through calcCost() from @agentistics/core — never inline pricing.
 *
 * No Mongo, no auth, no I/O.
 */
import {
  EMPTY_TOKENS, addTokens, calcCost, sessionCostUSD, sessionTokens, unpricedTokens,
  type SessionMeta, type TokenBreakdown,
} from '@agentistics/core'

export interface TagAggregate {
  sessions: number
  costUSD: number
  /** `costUSD` split by harness — so a plan basis prices each slice at ITS harness's own plan. */
  costByHarness: Record<string, number>
  /** The two conversational counters. NOT the total — read `tokens` for that. */
  inputTokens: number
  outputTokens: number
  /**
   * All four billed counters.
   *
   * The tag cards and the tag detail page printed `inputTokens + outputTokens` under the word
   * "Tokens", which on a cached workload is a fraction of a percent of the real figure. The
   * aggregate had no field to hold the rest, so the bug could not be fixed in the UI alone.
   */
  tokens: TokenBreakdown
  /** Tokens of models/sessions with NO price (PRICE.UNKNOWN): `costUSD` is a floor when this is above 0. */
  unpricedTokens: number
  topProject: string | null
  topModel: string | null
  topHarness: string | null
}

/** Most frequent non-empty value, or null when nothing qualifies. Ties resolve to first-seen. */
function topOf(values: (string | undefined | null)[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) {
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c }
  }
  return best
}

export function aggregateSessions(sessions: SessionMeta[]): TagAggregate {
  let costUSD = 0
  let inputTokens = 0
  let outputTokens = 0
  let tokens: TokenBreakdown = EMPTY_TOKENS
  let unpriced = 0
  const costByHarness: Record<string, number> = {}
  for (const s of sessions) {
    const input = s.input_tokens ?? 0
    const output = s.output_tokens ?? 0
    inputTokens += input
    outputTokens += output
    tokens = addTokens(tokens, sessionTokens(s))
    unpriced += unpricedTokens(s)
    // Priced per model (multi-model sessions carry a `model_usage` breakdown).
    // No model at all → calcCost falls back to the default price, same as everywhere else.
    const sessionCost = sessionCostUSD(s) ?? calcCost({
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: s.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: s.cache_creation_input_tokens ?? 0,
      webSearchRequests: 0,
      costUSD: 0,
    }, '')
    costUSD += sessionCost
    const harness = s.harness ?? 'claude'
    costByHarness[harness] = (costByHarness[harness] ?? 0) + sessionCost
  }
  return {
    sessions: sessions.length,
    costUSD,
    costByHarness,
    inputTokens,
    outputTokens,
    tokens,
    unpricedTokens: unpriced,
    topProject: topOf(sessions.map(s => s.project_path)),
    topModel: topOf(sessions.map(s => s.model)),
    topHarness: topOf(sessions.map(s => s.harness)),
  }
}
