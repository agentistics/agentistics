/**
 * The MCP analytics tools read off the PROJECTIONS (`GET /api/runtime/metrics`, P3 / A4.4) — the same
 * JSON shapes as `legacy-analytics.ts`, so a surface that opted in (`AGENTISTICS_PROJECTIONS_SURFACES`
 * names `mcp`) answers the same questions from the journal instead of `/api/data`.
 *
 * Every row carries `source: "projections"`. Where the projection's figure means something else than
 * the legacy field, the legacy field is NOT reused under the old name:
 * - `personTurns` replaces `messages`: the journal counts the person's turns, the legacy counted every
 *   user AND assistant transcript line. `messages` stays one bundle as a DEPRECATED alias of
 *   `personTurns` (the leader's A4.4 decision 4), so a reader of the old field does not break.
 * - Tokens and cost are the MAIN agent's (`subagent=false`), the legacy session total's meaning;
 *   subagents' spend is reported beside them (`subagentTokens`, `subagentCostUSD`), never folded in.
 * - `lastActive` is a UTC day (`yyyy-MM-dd`), the API's day rule — no timestamp is projected.
 * - Cost is API-equivalent from the provider / harness / price table (`costPartial` when some
 *   responses could not be priced: the figure is a floor).
 *
 * The query client (paging, the three-query rollup, `ProjectionUnavailable`) is core's
 * `projection-client.ts`, shared with the TUI.
 */
import {
  allMetricGroups as allGroups, harnessScope as scope, projectedRollup as rollup,
  type MetricsGroupLike, type MetricsQueryFn, type Rollup,
} from "@agentistics/core";

export { ProjectionUnavailable, type MetricsAnswer, type MetricsQueryFn } from "@agentistics/core";

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

function spend(r: Rollup, places: number) {
  return {
    inputTokens: r.main.input,
    outputTokens: r.main.output,
    cacheReadTokens: r.main.cacheRead,
    cacheWriteTokens: r.main.cacheWrite,
    totalTokens: r.main.input + r.main.output + r.main.cacheRead + r.main.cacheWrite,
    estimatedCostUSD: round(r.mainCost, places),
    costPartial: r.costPartial,
    subagentTokens: Math.max(0, r.allTokens - r.main.total),
    subagentCostUSD: round(Math.max(0, r.allCost - r.mainCost), places),
  }
}

export async function projectedHarnesses(q: MetricsQueryFn): Promise<unknown> {
  const rows = [...(await rollup(q, 'harness')).values()].map(r => ({
    harness: r.key,
    sessions: r.sessions,
    personTurns: r.personTurns,
    /** @deprecated alias of `personTurns`, kept for one bundle (A4.4 decision 4). */
    messages: r.personTurns,
    ...spend(r, 2),
    lastActive: r.lastActive,
    source: 'projections' as const,
  }))
  return rows.sort((a, b) => b.totalTokens - a.totalTokens)
}

export async function projectedProjects(q: MetricsQueryFn, harness?: string): Promise<unknown> {
  const rows = [...(await rollup(q, 'project', harness)).values()]
    .filter(r => r.key)
    .map(r => {
      const s = spend(r, 4)
      return {
        name: r.key!.split(/[\\/]/).filter(Boolean).pop() ?? r.key,
        path: r.key,
        sessions: r.sessions,
        personTurns: r.personTurns,
        /** @deprecated alias of `personTurns`, kept for one bundle (A4.4 decision 4). */
        messages: r.personTurns,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        // The legacy field's meaning: input + output only.
        totalTokens: s.inputTokens + s.outputTokens,
        estimatedCostUSD: s.estimatedCostUSD,
        costPartial: s.costPartial,
        subagentTokens: s.subagentTokens,
        subagentCostUSD: s.subagentCostUSD,
        lastActive: r.lastActive,
        // Not projected (P3 keeps no per-file facts).
        languages: null,
        source: 'projections' as const,
      }
    })
  return rows.sort((a, b) => b.totalTokens - a.totalTokens)
}

export async function projectedRepos(q: MetricsQueryFn, harness?: string): Promise<unknown> {
  const rows = [...(await rollup(q, 'repo', harness)).values()].map(r => ({
    repo: r.key || 'unlinked',
    remote: r.key || null,
    sessions: r.sessions,
    personTurns: r.personTurns,
    /** @deprecated alias of `personTurns`, kept for one bundle (A4.4 decision 4). */
    messages: r.personTurns,
    ...spend(r, 4),
    lastActive: r.lastActive,
    source: 'projections' as const,
  }))
  return rows.sort((a, b) => b.totalTokens - a.totalTokens)
}

export async function projectedCosts(q: MetricsQueryFn, harness?: string): Promise<unknown> {
  const rows = [...(await rollup(q, 'model', harness)).values()].map(r => {
    const { costPartial, subagentTokens, subagentCostUSD, ...s } = spend(r, 4)
    return { model: r.key ?? 'unknown', ...s, costPartial, subagentTokens, subagentCostUSD, source: 'projections' as const }
  })
  return rows.sort((a, b) => b.totalTokens - a.totalTokens)
}

/** Consecutive UTC days with activity, ending today or yesterday (a day not over yet does not break it). */
export function streakOf(days: Iterable<string>, today: string): number {
  const set = new Set(days)
  const prev = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  let d = set.has(today) ? today : prev(today)
  let n = 0
  while (set.has(d)) { n++; d = prev(d) }
  return n
}

export async function projectedSummary(q: MetricsQueryFn, harness?: string, now: () => Date = () => new Date()): Promise<unknown> {
  const unified = !harness || harness === 'all'
  const base = scope(harness)
  const [totals, models, projects, days] = await Promise.all([
    rollup(q, null, harness),
    allGroups(q, { ...base, groupBy: 'model', subagent: 'false', metrics: 'tokens' }),
    allGroups(q, { ...base, groupBy: 'project', metrics: 'sessions' }),
    allGroups(q, { ...base, groupBy: 'day', metrics: 'sessions' }),
  ])
  const t = totals.get(null) ?? null
  const top = <G extends MetricsGroupLike>(gs: G[], dim: string, n: (g: G) => number) =>
    gs.filter(g => g.key[dim]).sort((a, b) => n(b) - n(a))[0]?.key[dim] ?? '—'
  const activeDays = days.groups.map(g => g.key.day).filter((d): d is string => !!d)
  const s = t ? spend(t, 2) : null
  return {
    harness: unified ? 'all' : harness,
    totalInputTokens: s?.inputTokens ?? 0,
    totalOutputTokens: s?.outputTokens ?? 0,
    totalCacheReadTokens: s?.cacheReadTokens ?? 0,
    totalCacheWriteTokens: s?.cacheWriteTokens ?? 0,
    estimatedCostUSD: s?.estimatedCostUSD ?? 0,
    costPartial: s?.costPartial ?? false,
    subagentTokens: s?.subagentTokens ?? 0,
    subagentCostUSD: s?.subagentCostUSD ?? 0,
    totalSessions: t?.sessions ?? 0,
    topModel: top(models.groups, 'model', g => (g.metrics.tokens?.input ?? 0) + (g.metrics.tokens?.output ?? 0)),
    topProject: top(projects.groups, 'project', g => g.metrics.sessions?.count ?? 0),
    activeDays: activeDays.length,
    currentStreak: streakOf(activeDays, now().toISOString().slice(0, 10)),
    freshness: days.basis?.freshness ?? null,
    source: 'projections' as const,
  }
}

export const PROJECTED_TOOLS = {
  agentistics_summary: projectedSummary,
  agentistics_harnesses: (q: MetricsQueryFn) => projectedHarnesses(q),
  agentistics_projects: projectedProjects,
  agentistics_costs: projectedCosts,
  agentistics_repos: projectedRepos,
} as const
export type ProjectedTool = keyof typeof PROJECTED_TOOLS
