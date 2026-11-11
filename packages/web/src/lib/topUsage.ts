import { canonicalProjectPath, calcCost, sessionCostUSD, sessionModelUsage, sessionTokenTotal } from '@agentistics/core'
import type { SessionMeta } from '@agentistics/core'

/** What the podium is ranked by. Cost answers "where is the money", tokens "where is the volume",
 *  sessions "where do I actually spend my days" — and they routinely disagree, which is the point
 *  of offering all three rather than picking one and calling it "usage". */
export type TopMetric = 'cost' | 'tokens' | 'sessions'

export type TopDimension = 'harness' | 'model' | 'project' | 'repo'

export interface TopEntry {
  key: string
  cost: number
  /** API cost split by harness, so plan basis can price each slice independently. */
  costByHarness?: Record<string, number>
  tokens: number
  sessions: number
}

export interface TopResult {
  entries: TopEntry[]
  /** Total across EVERY entry, not just the ones shown — the share of a podium place is only
   *  meaningful against the whole. */
  total: number
  /** Cost split for the complete result, including entries outside the podium. */
  costByHarness: Record<string, number>
  /** How many distinct entries existed before taking the top N. */
  distinct: number
}

const tokensOf = (s: SessionMeta): number | undefined => sessionTokenTotal(s)

/**
 * Split a session into the keys it contributes to.
 *
 * Every dimension but `model` yields exactly one key, so the session's whole cost lands there. A
 * session CAN span several models (an Antigravity parent with its sub-agents folded in runs Opus
 * and Gemini Flash), so the model dimension splits it per model rather than filing the entire
 * session under one label — otherwise the cheaper model inherits the expensive one's spend.
 */
function contributions(s: SessionMeta, dim: TopDimension): Array<{ key: string; cost: number; tokens: number; harness: string }> {
  if (s.tokens_unavailable) return []
  if (dim === 'model') {
    const entries = sessionModelUsage(s)
    if (entries.length === 0) return []
    return entries.map(([model, usage]) => ({
      key: model,
      cost: calcCost(usage, model),
      harness: s.harness ?? 'claude',
      tokens: usage.inputTokens + usage.outputTokens
        + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    }))
  }

  const key =
    dim === 'harness' ? s.harness
    : dim === 'project' ? canonicalProjectPath(s.project_path ?? '')
    : dim === 'repo' ? (s.git_remote ?? '')
    : ''

  if (!key) return []
  const tokens = tokensOf(s)
  if (tokens === undefined) return []
  return [{ key, cost: sessionCostUSD(s) ?? 0, tokens, harness: s.harness ?? 'claude' }]
}

/**
 * Rank one dimension. Ties break on the runner-up metrics and then the key, so the same data always
 * produces the same podium instead of shuffling between renders.
 */
export function rankTop(
  sessions: SessionMeta[],
  dim: TopDimension,
  metric: TopMetric,
  limit = 3,
): TopResult {
  const acc = new Map<string, TopEntry>()
  for (const s of sessions) {
    for (const c of contributions(s, dim)) {
      const e = acc.get(c.key) ?? { key: c.key, cost: 0, costByHarness: {}, tokens: 0, sessions: 0 }
      e.cost += c.cost
      const byHarness = (e.costByHarness ??= {})
      byHarness[c.harness] = (byHarness[c.harness] ?? 0) + c.cost
      e.tokens += c.tokens
      // A session spanning two models counts once for each: the question is how many sessions
      // touched that model, and a session that used both really did touch both.
      e.sessions += 1
      acc.set(c.key, e)
    }
  }

  const all = [...acc.values()]
  const value = (e: TopEntry): number => (metric === 'cost' ? e.cost : metric === 'tokens' ? e.tokens : e.sessions)
  all.sort((a, b) =>
    value(b) - value(a)
    || b.cost - a.cost
    || b.tokens - a.tokens
    || a.key.localeCompare(b.key))

  const costByHarness: Record<string, number> = {}
  for (const e of all) for (const [h, cost] of Object.entries(e.costByHarness ?? {})) {
    costByHarness[h] = (costByHarness[h] ?? 0) + cost
  }
  return {
    entries: all.slice(0, limit),
    total: all.reduce((sum, e) => sum + value(e), 0),
    costByHarness,
    distinct: all.length,
  }
}

/** Share of the whole, 0–1. Zero when there is nothing to take a share of. */
export function shareOf(entry: TopEntry, result: TopResult, metric: TopMetric): number {
  if (result.total <= 0) return 0
  const v = metric === 'cost' ? entry.cost : metric === 'tokens' ? entry.tokens : entry.sessions
  return v / result.total
}

/** Cost of a row/result after each harness slice uses its own plan factor. */
export function planCostOf(
  costByHarness: Readonly<Record<string, number>> | undefined,
  factors: Readonly<Record<string, number | null>> | null,
): number {
  return Object.entries(costByHarness ?? {}).reduce((sum, [harness, cost]) => {
    const factor = factors?.[harness]
    return sum + cost * (typeof factor === 'number' && Number.isFinite(factor) ? factor : 1)
  }, 0)
}
