/**
 * A session reduced to a range of days, ready to be priced like any other session.
 *
 * `daily` records the four counters per UTC day, but not the cache-write TTL split, and not the
 * per-model breakdown. Replacing only the counters left those two at their LIFETIME values, and
 * `calcCost` prices the TTL split when one is present: a cut session was billed for every cache
 * write it had ever made, under a heading that said "today".
 *
 * So both are scaled to the cut:
 * - the 1h/5m split keeps the session's own ratio, applied to the cut's cache writes;
 * - each model's counters keep their share of the session's counters.
 *
 * That is a proportion of measured totals, never a guess at behaviour, and it is exact whenever the
 * range is the whole session.
 */
import type { ModelUsage } from './types'

type Counters = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
type Cuttable = Partial<Counters> & {
  model?: string
  model_usage?: Record<string, ModelUsage>
  cache_creation_1h_input_tokens?: number
  cache_creation_5m_input_tokens?: number
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0)

export function cutSessionUsage<S extends Cuttable>(s: S, cut: Counters): S {
  const out: S = { ...s, ...cut }
  const h1 = s.cache_creation_1h_input_tokens
  const m5 = s.cache_creation_5m_input_tokens
  if (h1 !== undefined && m5 !== undefined) {
    const share = ratio(h1, h1 + m5)
    out.cache_creation_1h_input_tokens = Math.round(cut.cache_creation_input_tokens * share)
    out.cache_creation_5m_input_tokens = cut.cache_creation_input_tokens - out.cache_creation_1h_input_tokens
  }
  if (s.model_usage) {
    const k = {
      input: ratio(cut.input_tokens, s.input_tokens ?? 0),
      output: ratio(cut.output_tokens, s.output_tokens ?? 0),
      cacheRead: ratio(cut.cache_read_input_tokens, s.cache_read_input_tokens ?? 0),
      cacheWrite: ratio(cut.cache_creation_input_tokens, s.cache_creation_input_tokens ?? 0),
    }
    const scaled: Record<string, ModelUsage> = {}
    for (const [model, u] of Object.entries(s.model_usage)) {
      if (!u) continue
      const cw = u.cacheCreationInputTokens * k.cacheWrite
      const next: ModelUsage = {
        ...u,
        inputTokens: u.inputTokens * k.input,
        outputTokens: u.outputTokens * k.output,
        cacheReadInputTokens: u.cacheReadInputTokens * k.cacheRead,
        cacheCreationInputTokens: cw,
      }
      if (u.cacheCreation1hInputTokens !== undefined && u.cacheCreation5mInputTokens !== undefined) {
        const share = ratio(u.cacheCreation1hInputTokens, u.cacheCreation1hInputTokens + u.cacheCreation5mInputTokens)
        next.cacheCreation1hInputTokens = cw * share
        next.cacheCreation5mInputTokens = cw - cw * share
      }
      scaled[model] = next
    }
    out.model_usage = scaled
  }
  return out
}
