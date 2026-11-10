/**
 * projectedDerived.ts: the web's session, cost and tool figures read from the PROJECTIONS
 * (`GET /api/runtime/metrics`, P3 / A4.7). They are laid over `computeDerivedStats`'s answer when the
 * server says this surface reads them (`projectionsWeb` on `/api/team/session`: the default, unless
 * `AGENTISTICS_PROJECTIONS_SURFACES=legacy`, whenever the server serves projections).
 *
 * What it replaces is the `derived` fields that the pages and the custom page's widgets (the "gallery":
 * `componentCatalog.tsx`) read for sessions, costs and tools:
 * - `totalSessions` and `totalCostUSD`;
 * - `modelUsage`, `tokenTotals`, `inputTokens` and `outputTokens`;
 * - the cache figures, through the same `cacheFiguresOf`;
 * - `toolCounts` and `totalToolCalls`, the MAIN agent's (`subagent=false`). The legacy `tool_counts`
 *   are the main transcript's alone, and the run facts carry each tool's subagent share (A4.7
 *   decision 2), so the same quantity sits under the same name;
 * - `projectStats`, keyed by project root: sessions, the person's messages (`user_message_count` on
 *   both paths) and the main agent's tool calls.
 *
 * Everything else (streaks, the heatmap, hours, git, languages, agents, the session list) stays on
 * `/api/data`.
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
  toolCounts: Record<string, number>
  totalToolCalls: number
  projectStats: Record<string, { sessions: number; messages: number; tools: number }>
  /** Harnesses the projection holds at least one session for, in this scope. Absent in hand-built overlays. */
  coveredHarnesses?: string[]
  /** USD the projection priced per harness. A covered harness at 0 here has NO projected price (the replay carried no
   *  declared cost and the table cannot price its models), which is "not priced", never "free". */
  costByHarness?: Record<string, number>
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

interface ToolsCellLike { byTool?: { name: string; calls: number }[]; calls?: number }
const toolsOf = (g: MetricsGroupLike | undefined) => (g?.metrics as { tools?: ToolsCellLike } | undefined)?.tools

export async function projectedDerived(
  q: MetricsQueryFn,
  scope: MetricsParams,
  /** The blended rate the cache-savings estimate uses: `blendedCostPerToken` over all-time usage. */
  blendedOf: (usage: Record<string, ModelUsage>) => BlendedRate,
): Promise<ProjectedDerived> {
  const [byModel, whole, mainTools, byProject, projectTools, byHarness] = await Promise.all([
    allMetricGroups(q, { ...scope, groupBy: 'model', subagent: 'false', metrics: 'tokens,cost' }),
    allMetricGroups(q, { ...scope, metrics: 'sessions' }),
    allMetricGroups(q, { ...scope, subagent: 'false', metrics: 'tools' }),
    allMetricGroups(q, { ...scope, groupBy: 'project', metrics: 'sessions,messages' }),
    allMetricGroups(q, { ...scope, groupBy: 'project', subagent: 'false', metrics: 'tools' }),
    allMetricGroups(q, { ...scope, groupBy: 'harness', metrics: 'sessions,cost' }),
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
  const toolCounts: Record<string, number> = {}
  for (const row of toolsOf(mainTools.groups[0])?.byTool ?? []) toolCounts[row.name] = row.calls
  const projectStats: ProjectedDerived['projectStats'] = {}
  const projectKey = (g: MetricsGroupLike) => g.key.project || 'Unknown'
  for (const g of byProject.groups) {
    projectStats[projectKey(g)] = { sessions: g.metrics.sessions?.count ?? 0, messages: g.metrics.messages?.value ?? 0, tools: 0 }
  }
  for (const g of projectTools.groups) {
    const p = (projectStats[projectKey(g)] ??= { sessions: 0, messages: 0, tools: 0 })
    p.tools = toolsOf(g)?.calls ?? 0
  }
  return {
    totalSessions: t?.metrics.sessions?.count ?? 0,
    totalCostUSD,
    modelUsage,
    tokenTotals,
    inputTokens: tokenTotals.input,
    outputTokens: tokenTotals.output,
    ...cacheFiguresOf(modelUsage, blendedOf(modelUsage)),
    toolCounts,
    totalToolCalls: toolsOf(mainTools.groups[0])?.calls ?? 0,
    projectStats,
    coveredHarnesses: byHarness.groups.filter(g => (g.metrics.sessions?.count ?? 0) > 0).map(g => String(g.key.harness)),
    costByHarness: Object.fromEntries(byHarness.groups.map(g => [String(g.key.harness), g.metrics.cost?.usd ?? 0])),
    figuresSource: 'projections',
  }
}

/** The legacy figures one harness contributes: what `computeDerivedStats` answers, narrowed to that harness. */
export interface LegacyFigures {
  totalSessions: number
  totalCostUSD: number
  modelUsage: Record<string, ModelUsage>
  tokenTotals: TokenBreakdown
  toolCounts: Record<string, number>
  totalToolCalls: number
  projectStats: Record<string, { sessions: number; messages: number; tools: number }>
}

export interface OverlayCoverage<D> {
  /** Harnesses the current filters select (all the data's harnesses when none is chosen). */
  candidates: readonly string[]
  /** The legacy answer narrowed to one harness, or null. */
  legacyFor(harness: string): D | null
  blendedOf(usage: Record<string, ModelUsage>): BlendedRate
}

const addRecord = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v
  return out
}

/**
 * Lays the projection over the legacy answer, harness by harness.
 *
 * Messages, the longest session, streaks and the heatmap stay on the legacy path. A harness whose
 * reader has not fed the journal has NO projection: its sessions, tokens, cost and tools come from the
 * legacy (adapter) figures, added to the projection of the harnesses that do have one. That keeps
 * "Codex + OpenCode" equal to Codex plus OpenCode, whichever of the two the projection covers, and
 * never shows "259 messages, 0 sessions". Without coverage information (`coverage` absent or a
 * hand-built overlay) an empty projection never overrides a non-empty legacy figure.
 */
function overlayProjectedFigures<D extends LegacyFigures>(legacy: D | null, overlay: ProjectedDerived | null, coverage?: OverlayCoverage<D>): D | null {
  if (!legacy || !overlay) return legacy
  const covered = overlay.coveredHarnesses
  if (!coverage || !covered) {
    if (overlay.totalSessions === 0 && legacy.totalSessions > 0) return legacy
    return { ...legacy, ...overlay }
  }
  const parts = coverage.candidates.filter(h => !covered.includes(h))
    .map(h => coverage.legacyFor(h)).filter((d): d is D => d !== null && d.totalSessions > 0)
  if (overlay.totalSessions === 0 && parts.length === 0 && legacy.totalSessions > 0) return legacy
  if (parts.length === 0) return { ...legacy, ...overlay }
  const modelUsage: Record<string, ModelUsage> = { ...overlay.modelUsage }
  for (const d of parts) {
    for (const [m, u] of Object.entries(d.modelUsage)) {
      const cur = modelUsage[m]
      modelUsage[m] = cur ? {
        inputTokens: cur.inputTokens + u.inputTokens, outputTokens: cur.outputTokens + u.outputTokens,
        cacheReadInputTokens: cur.cacheReadInputTokens + u.cacheReadInputTokens,
        cacheCreationInputTokens: cur.cacheCreationInputTokens + u.cacheCreationInputTokens,
        webSearchRequests: cur.webSearchRequests + u.webSearchRequests, costUSD: cur.costUSD + u.costUSD,
      } : u
    }
  }
  const tokenTotals = sumTokens([overlay.tokenTotals, ...parts.map(d => d.tokenTotals)])
  const projectStats = { ...overlay.projectStats }
  for (const d of parts) {
    for (const [k, v] of Object.entries(d.projectStats)) {
      const cur = projectStats[k]
      projectStats[k] = cur ? { sessions: cur.sessions + v.sessions, messages: cur.messages + v.messages, tools: cur.tools + v.tools } : v
    }
  }
  return {
    ...legacy, ...overlay,
    totalSessions: overlay.totalSessions + parts.reduce((a, d) => a + d.totalSessions, 0),
    totalCostUSD: overlay.totalCostUSD + parts.reduce((a, d) => a + d.totalCostUSD, 0),
    modelUsage, tokenTotals, inputTokens: tokenTotals.input, outputTokens: tokenTotals.output,
    ...cacheFiguresOf(modelUsage, coverage.blendedOf(modelUsage)),
    toolCounts: parts.reduce((a, d) => addRecord(a, d.toolCounts), overlay.toolCounts),
    totalToolCalls: overlay.totalToolCalls + parts.reduce((a, d) => a + d.totalToolCalls, 0),
    projectStats,
  }
}

/**
 * `overlayProjected`, plus one correction: a harness the projection COVERS but did not PRICE keeps its legacy cost.
 *
 * The projection reports `cost.usd = 0` for a harness whose replay carries no declared cost and whose models the
 * price table cannot name (OpenCode's gateway models: `opencode-go/glm-5.3`). Laying that 0 over the legacy answer
 * turned the Est. cost card into R$0,00 while the per-session read (cost declared by the harness, `costSource:
 * 'harness'`) held US$23,57. A covered harness at exactly 0 whose adapter sessions DO carry a cost contributes
 * that cost back, into the total and into the matching per-model rows.
 */
export function overlayProjected<D extends LegacyFigures>(legacy: D | null, overlay: ProjectedDerived | null, coverage?: OverlayCoverage<D>): D | null {
  const out = overlayProjectedFigures(legacy, overlay, coverage)
  if (!out || !overlay || !coverage || out === legacy || !overlay.costByHarness || !overlay.coveredHarnesses) return out
  const missing = coverage.candidates
    .filter(h => overlay.coveredHarnesses!.includes(h) && (overlay.costByHarness![h] ?? 0) === 0)
    .map(h => coverage.legacyFor(h)).filter((d): d is D => d !== null && d.totalCostUSD > 0)
  if (missing.length === 0) return out
  const modelUsage: Record<string, ModelUsage> = { ...out.modelUsage }
  for (const d of missing) {
    for (const [m, u] of Object.entries(d.modelUsage)) {
      const cur = modelUsage[m]
      if (cur) modelUsage[m] = { ...cur, costUSD: cur.costUSD + u.costUSD }
    }
  }
  return { ...out, modelUsage, totalCostUSD: out.totalCostUSD + missing.reduce((a, d) => a + d.totalCostUSD, 0) }
}
