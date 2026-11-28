/**
 * projectedDerived.ts: the web's session, cost and tool figures read from the PROJECTIONS
 * (`GET /api/runtime/metrics`, P3 / A4.7). They are laid over `computeDerivedStats`'s answer when the
 * server says this surface reads them (`projectionsWeb` on `/api/session`: the default, unless
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
 * asked. A refusal of the route itself (404 when the gate is off, 409, 503 with no reader)
 * also leaves the legacy figures.
 */
import {
  accumulateUsageCost, allMetricGroups, calcCost, canonicalProjectPath, isUnpricedModel, sumTokens, unpricedTokens, usageTokenTotal, usageTokens,
  type Filters, type MetricsGroupLike, type MetricsParams, type MetricsQueryFn, type ModelUsage, type TokenBreakdown,
} from '@agentistics/core'
import { cacheFiguresOf, type BlendedRate } from './cacheFigures'
import { matchModelKey } from './modelKeyMatch'

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
  const blocked = (filters.tags?.length ?? 0) > 0 || activeOnly
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

/**
 * One model row of the projection. Its cost is the figure the projection already PRICED — a harness's
 * declared cost where it carried one (OpenCode), the table elsewhere — and `totalCostUSD` is the sum of
 * these. So the row is marked settled (`costSource`): `calcCost`, which every by-model surface prices
 * through (ModelBreakdown, `modelCostByHarness`, the PDF), returns it as is instead of repricing the
 * same tokens from the table, which made the "Usage by model" rows disagree with the headline whenever a
 * harness declared its cost (CUSTO.REGRA-UNICA). A row the projection could not price (cost 0, a model
 * the table does not know) keeps its tokens reported as unpriced, exactly as before.
 *
 * HERMES.S2.2: whether the row has a price is the SERVER's answer, never the browser's. A row the projection
 * could not price comes WITHOUT a `cost` metric (or with every row unpriced and 0), and its tokens are unpriced
 * whatever the local table says — once `/api/rates` loads the community table into `MODEL_PRICING`, a prefix
 * match prices an Ollama Cloud `gpt-oss:120b` through `gpt-oss-120b`, and the row became a settled USD 0.00.
 * Only a cell that does not say (`unpricedRows` absent: an older server) falls back to the table.
 */
const usageOf = (g: MetricsGroupLike, model: string): ModelUsage => {
  const cost = g.metrics.cost
  const u: ModelUsage = {
    inputTokens: g.metrics.tokens?.input ?? 0,
    outputTokens: g.metrics.tokens?.output ?? 0,
    cacheReadInputTokens: g.metrics.tokens?.cacheRead ?? 0,
    cacheCreationInputTokens: g.metrics.tokens?.cacheWrite ?? 0,
    webSearchRequests: 0,
    costUSD: cost?.usd ?? 0,
  }
  const serverUnpriced = !cost || (cost.usd === 0 && (cost.unpricedRows ?? 0) > 0)
  const unpriced = serverUnpriced || (u.costUSD === 0 && cost.unpricedRows === undefined && isUnpricedModel(model))
  return { ...u, costSource: 'mixed', unpricedTokens: unpriced ? usageTokenTotal(u) : 0 }
}

/**
 * Adds one legacy row into a projected one under the SAME cost rule the legacy path accumulates with
 * (`accumulateUsageCost`): each side keeps its own cost — settled or declared as given, table-priced
 * otherwise — so the merged row still prices to the sum the headline adds.
 */
function mergeUsage(cur: ModelUsage, u: ModelUsage, model: string): ModelUsage {
  const out: ModelUsage = { ...cur }
  accumulateUsageCost(out, u, model)
  out.inputTokens += u.inputTokens
  out.outputTokens += u.outputTokens
  out.cacheReadInputTokens += u.cacheReadInputTokens
  out.cacheCreationInputTokens += u.cacheCreationInputTokens
  out.webSearchRequests += u.webSearchRequests
  return out
}

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
    // A response with no model is spend all the same: it keeps its own row rather than vanishing.
    const model = g.key.model ?? 'unknown'
    const u = usageOf(g, model)
    totalCostUSD += u.costUSD
    modelUsage[model] = u
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
      modelUsage[m] = cur ? mergeUsage(cur, u, m) : u
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
 *
 * CUSTO.MODELO-OPENCODE (owner print 2521fdb5, 2.229.3): the correction is per ROW, not only per harness, and the
 * legacy row is matched to the projected one by `matchModelKey`. The replay keys an OpenCode model by its raw id
 * (`fable-5.1`) and records OpenCode's `cost: 0` as a declared zero; the legacy adapter keys it by its route
 * (`upx/fable-5.1`) and prices it from the tokens. Matching only the identical key gave the cost to the TOTAL and to
 * no row: the headline was right and every "Usage by model" row read R$0,00. Now a cost is added ONLY where it
 * lands in a row, so the rows always add up to the headline; a model no source can price stays unpriced.
 */
export function overlayProjected<D extends LegacyFigures>(legacy: D | null, overlay: ProjectedDerived | null, coverage?: OverlayCoverage<D>): D | null {
  const out = overlayProjectedFigures(legacy, overlay, coverage)
  if (!out || !overlay || !coverage || out === legacy || !overlay.costByHarness || !overlay.coveredHarnesses) return out
  const covered = coverage.candidates
    .filter(h => overlay.coveredHarnesses!.includes(h))
    .map(h => ({ harnessZero: (overlay.costByHarness![h] ?? 0) === 0, d: coverage.legacyFor(h) }))
    // A harness whose legacy total is 0 still counts: its rows can say a model is LOCAL (a known 0), which the
    // projection reports as unpriced (HERMES.S2.2: `ollama/llama3.2` is free, not unknown).
    .filter((c): c is { harnessZero: boolean; d: D } => c.d !== null && c.d.totalSessions > 0)
  if (covered.length === 0) return out
  const modelUsage: Record<string, ModelUsage> = { ...out.modelUsage }
  // Decided on the projection's OWN rows, before any correction: a second harness must not read the first one's.
  const projectedZero = (k: string) => (overlay.modelUsage[k]?.costUSD ?? 0) === 0
  let added = 0
  let changed = false
  for (const { harnessZero, d } of covered) {
    for (const [m, u] of Object.entries(d.modelUsage)) {
      // The legacy adapter keys a model by its route (`upx/fable-5.1`), the projection by the raw id
      // (`fable-5.1`): find the projected row the legacy one is (CUSTO.MODELO-OPENCODE).
      const k = matchModelKey(m, Object.keys(modelUsage))
      const cur = k ? modelUsage[k] : undefined
      // The projection gave this row no price — the whole harness at 0, or this model at 0 (OpenCode's `cost: 0` on a
      // gateway/subscription route, which the replay records as a DECLARED zero). Its tokens are already in the
      // projected row; only the cost is added, by the legacy rule (declared where declared, the table otherwise),
      // and those tokens stop being unpriced. Cost and total move together, so the rows always add up to the top.
      if (!k || !cur || !(harnessZero || projectedZero(k))) continue
      const cost = calcCost(u, m)
      const unpriced = Math.max(0, (cur.unpricedTokens ?? 0) - usageTokenTotal(u)) + unpricedTokens([[m, u]])
      // Nothing to add and nothing it settles (a local model's known 0 settles the tokens it carries).
      if (cost <= 0 && unpriced === (cur.unpricedTokens ?? 0)) continue
      modelUsage[k] = { ...cur, costUSD: calcCost(cur, k) + cost, costSource: cur.costSource ?? 'mixed', unpricedTokens: unpriced }
      added += cost
      changed = true
    }
  }
  if (!changed) return out
  return { ...out, modelUsage, totalCostUSD: out.totalCostUSD + added }
}
