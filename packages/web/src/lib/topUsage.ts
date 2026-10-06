import { canonicalProjectPath, sessionCostUSD, sessionModelUsage, calcCost } from '@agentistics/core'
import type { SessionMeta, StatsCache, Filters } from '@agentistics/core'
import { format, parseISO } from 'date-fns'

/** What the podium is ranked by. Cost answers "where is the money", tokens "where is the volume",
 *  sessions "where do I actually spend my days" — and they routinely disagree, which is the point
 *  of offering all three rather than picking one and calling it "usage". */
export type TopMetric = 'cost' | 'tokens' | 'sessions'

export type TopDimension = 'harness' | 'model' | 'project' | 'repo' | 'user' | 'machine'

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

const tokensOf = (s: SessionMeta): number =>
  (s.input_tokens ?? 0) + (s.output_tokens ?? 0)
  + (s.cache_read_input_tokens ?? 0) + (s.cache_creation_input_tokens ?? 0)

/**
 * Split a session into the keys it contributes to.
 *
 * Every dimension but `model` yields exactly one key, so the session's whole cost lands there. A
 * session CAN span several models (an Antigravity parent with its sub-agents folded in runs Opus
 * and Gemini Flash), so the model dimension splits it per model rather than filing the entire
 * session under one label — otherwise the cheaper model inherits the expensive one's spend.
 */
function contributions(s: SessionMeta, dim: TopDimension): Array<{ key: string; cost: number; tokens: number; harness: string }> {
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
    : dim === 'user' ? (s.user ?? '')
    : (s.memberId ?? '')

  if (!key) return []
  return [{ key, cost: sessionCostUSD(s) ?? 0, tokens: tokensOf(s), harness: s.harness ?? 'claude' }]
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

/**
 * True when the podium may be built from the per-member/-machine statsCaches instead of from the
 * sessions.
 *
 * Those caches are the authoritative deep history — the sessions are only what still exists as
 * individual documents, which is a fraction of it (a real machine showed R$54.5k of history against
 * R$19.3k of surviving session docs, so its person and machine podiums under-reported by 65%). The
 * caches are all-time totals with no project / repo / tag / model granularity, so ANY filter along
 * one of those dimensions — or a date range — makes them the wrong answer and the per-session sum
 * the right one, undercount and all. Member / machine / team / presence filters are fine: they
 * select WHICH caches to read, not a slice inside them. Pure.
 */
export function cacheTotalsUsable(filters: Filters): boolean {
  return (filters.projects?.length ?? 0) === 0
    && (filters.repos?.length ?? 0) === 0
    && (filters.tags?.length ?? 0) === 0
    && (filters.models?.length ?? 0) === 0
    && (filters.harnesses?.length ?? 0) === 0   // statsCache is Claude-only
    && !filters.harness
    && filters.dateRange === 'all'
    && !filters.customStart
    && !filters.customEnd
}

/** One podium entry's totals, read from a statsCache rather than summed from sessions. */
function entryFromCache(key: string, c: StatsCache): TopEntry {
  let cost = 0, tokens = 0
  for (const [model, u] of Object.entries(c.modelUsage ?? {})) {
    cost += calcCost(u, model)
    // Every billed counter, same as tokensOf — cache reads are ~96% of the volume, so leaving
    // them out would rank the podium by the 4% that barely costs anything.
    tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
      + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
  }
  const sessions = (c.dailyActivity ?? []).reduce((s, d) => s + (d.sessionCount ?? 0), 0)
  return { key, cost, costByHarness: { claude: cost }, tokens, sessions }
}

/**
 * Rank a dimension from per-key statsCaches (person → display name, machine → machine id),
 * supplemented by the sessions the caches cannot represent.
 *
 * Who is in scope comes from the already-filtered session set — the sessions went through every
 * filter, presence and teams included — while how much comes from the caches. A key with no
 * surviving session is left out rather than guessed at.
 *
 * The supplement is not optional: `stats-cache.json` is **Claude-only**, so a person's Codex or
 * Gemini spend appears in NO cache. Reading the caches alone reported a mixed-harness person at
 * $4.50 instead of $225 and inverted the podium. Mirrors `useDerivedStats` exactly, so the two
 * pages agree: non-Claude sessions contribute their full cost, tokens and count, while a Claude
 * session on a day the cache has not computed yet contributes only its COUNT — its money is
 * already whole inside `modelUsage`, and adding it again would double-count.
 */
export function rankTopFromCaches(
  caches: Record<string, StatsCache>,
  sessions: SessionMeta[],
  keyOf: (s: SessionMeta) => string,
  metric: TopMetric,
  limit = 3,
): TopResult {
  const acc = new Map<string, TopEntry>()
  const cachedDays = new Map<string, Set<string>>()

  for (const s of sessions) {
    const key = keyOf(s)
    if (!key) continue
    let e = acc.get(key)
    if (!e) {
      const c = caches[key]
      // A key with sessions but no cache still belongs on the podium — its sessions are all the
      // history there is, which is exactly the case for a member who only runs a non-Claude CLI.
      e = c ? entryFromCache(key, c) : { key, cost: 0, costByHarness: {}, tokens: 0, sessions: 0 }
      acc.set(key, e)
      cachedDays.set(key, new Set((c?.dailyActivity ?? []).map(d => d.date)))
    }
    if ((s.harness ?? 'claude') !== 'claude') {
      const cost = sessionCostUSD(s) ?? 0
      e.cost += cost
      const harness = s.harness ?? 'claude'
      const byHarness = (e.costByHarness ??= {})
      byHarness[harness] = (byHarness[harness] ?? 0) + cost
      e.tokens += tokensOf(s)
      e.sessions += 1
    } else if (s.start_time && !cachedDays.get(key)!.has(format(parseISO(s.start_time), 'yyyy-MM-dd'))) {
      e.sessions += 1
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
