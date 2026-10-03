/**
 * projectedDerived.ts: the web's session, cost and tool figures read from the PROJECTIONS
 * (`GET /api/runtime/metrics`, P3 / A4.7). They are laid over `computeDerivedStats`'s answer when the
 * server says this surface opted in (`projectionsWeb` on `/api/team/session`, which is
 * `AGENTISTICS_PROJECTIONS_SURFACES` naming `web`).
 *
 * What it replaces is the `derived` fields that the pages and the custom page's widgets (the "gallery":
 * `componentCatalog.tsx`) read for sessions, costs and tools:
 * - `totalSessions` and `totalCostUSD`;
 * - `modelUsage`, `tokenTotals`, `inputTokens` and `outputTokens`;
 * - the cache figures, through the same `cacheFiguresOf`.
 *
 * Everything else (streaks, the heatmap, hours, git, languages, agents, the session list) stays on
 * `/api/data`. So do the **tool counts and `projectStats`**: the projection's tool figures count
 * every agent of a run, subagents included, while the legacy `tool_counts` are the main transcript's
 * alone. On this machine that is 58,800 subagent calls beside 120,302 main ones. The API cannot split
 * tools by agent (`subagent` does not combine with `tools`), so overlaying them would put a different
 * quantity under the old name. They move when the run facts carry that split.
 *
 * Tokens and cost are the MAIN agent's (`subagent=false`), which is the per-session figures' meaning.
 * The web reports subagent spend apart (`totalAgentCostUSD`).
 *
 * **A scope the API cannot express is never approximated.** With a tag, member, team, machine or
 * presence filter, or with "active only", `projectedScope` is `null` and the legacy figures stay.
 * The API refuses those filters, and dropping one silently would answer a wider question than the one
 * asked. A refusal of the route itself (404 when the gate is off, 409 on a central, 503 with no reader)
 * also leaves the legacy figures.
 */
import {
  allMetricGroups, canonicalProjectPath, sumTokens, usageTokens,
  type Filters, type MetricsGroupLike, type MetricsParams, type MetricsQueryFn, type ModelUsage, type TokenBreakdown,
} from '@agentistics/core'
import { cacheFiguresOf, type BlendedRate } from './cacheFigures'

export interface ProjectedDerived {
  totalSessions: number
  totalCostUSD: number
  modelUsage: Record<string, ModelUsage>
  tokenTotals: TokenBreakdown
  inputTokens: number
  outputTokens: number
  cacheTotals: ReturnType<typeof cacheFiguresOf>['cacheTotals']
  cacheHitRate: number
  cacheGrossSavedUSD: number
  cacheWriteOverheadUSD: number
  cacheNetSavedUSD: number
  cachePerModel: ReturnType<typeof cacheFiguresOf>['cachePerModel']
  /** Marks the overlay, so a page can say where its numbers came from. */
  figuresSource: 'projections'
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The API parameters for the current filters, or `null` when a filter cannot be expressed.
 * `range` is `getDateRangeFilter`'s answer (UTC bounds, the API's own day rule).
 */
export function projectedScope(filters: Filters, activeOnly: boolean, range: { start: Date; end: Date }): MetricsParams | null {
  const blocked = (filters.tags?.length ?? 0) > 0 || (filters.users?.length ?? 0) > 0 || (filters.teams?.length ?? 0) > 0
    || (filters.machines?.length ?? 0) > 0 || filters.presence !== undefined || activeOnly
  if (blocked) return null
  const p: MetricsParams = {}
  if (range.start.getTime() > 0) p.from = utcDay(range.start)
  p.to = utcDay(range.end)
  const harnesses = [...new Set([...(filters.harnesses ?? []), ...(filters.harness ? [filters.harness] : [])])]
  if (harnesses.length > 0) p.harness = harnesses
  // The projections key projects on the ROOT; a worktree chosen in the picker selects its root's rows.
  if (filters.projects.length > 0) p.project = [...new Set(filters.projects.map(canonicalProjectPath))]
  if ((filters.repos?.length ?? 0) > 0) p.repo = filters.repos!
  if (filters.models.length > 0) p.model = filters.models
  return p
}

const usageOf = (g: MetricsGroupLike): ModelUsage => ({
  inputTokens: g.metrics.tokens?.input ?? 0,
  outputTokens: g.metrics.tokens?.output ?? 0,
  cacheReadInputTokens: g.metrics.tokens?.cacheRead ?? 0,
  cacheCreationInputTokens: g.metrics.tokens?.cacheWrite ?? 0,
  webSearchRequests: 0,
  costUSD: g.metrics.cost?.usd ?? 0,
})

export async function projectedDerived(
  q: MetricsQueryFn,
  scope: MetricsParams,
  /** The blended rate the cache-savings estimate uses: `blendedCostPerToken` over all-time usage. */
  blendedOf: (usage: Record<string, ModelUsage>) => BlendedRate,
): Promise<ProjectedDerived> {
  const [byModel, whole] = await Promise.all([
    allMetricGroups(q, { ...scope, groupBy: 'model', subagent: 'false', metrics: 'tokens,cost' }),
    allMetricGroups(q, { ...scope, metrics: 'sessions' }),
  ])
  const modelUsage: Record<string, ModelUsage> = {}
  let totalCostUSD = 0
  for (const g of byModel.groups) {
    const u = usageOf(g)
    totalCostUSD += u.costUSD
    // A response with no model is spend all the same: it keeps its own row rather than vanishing.
    modelUsage[g.key.model ?? 'unknown'] = u
  }
  const tokenTotals = sumTokens(Object.values(modelUsage).map(usageTokens))
  const t = whole.groups[0]
  return {
    totalSessions: t?.metrics.sessions?.count ?? 0,
    totalCostUSD,
    modelUsage,
    tokenTotals,
    inputTokens: tokenTotals.input,
    outputTokens: tokenTotals.output,
    ...cacheFiguresOf(modelUsage, blendedOf(modelUsage)),
    figuresSource: 'projections',
  }
}
