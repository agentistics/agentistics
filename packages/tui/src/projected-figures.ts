/**
 * projected-figures.ts — the dashboard's figures read off the PROJECTIONS (`GET /api/runtime/metrics`,
 * P3 / A4.6): the default (`AGENTISTICS_PROJECTIONS_SURFACES=legacy` is the fallback).
 *
 * The screens draw `DashboardFigures`, which have two producers:
 * - `legacyFigures(data)` is the selectors over `/api/data`, unchanged;
 * - `projectedFigures(query, harness)` is the same figures from the journal.
 *
 * No legacy figure is reused with another meaning:
 * - `messages` (per harness, and in total) is `null`. The journal counts the person's turns, while the
 *   legacy counted every user and assistant transcript line.
 * - `agents` is `null`. The API has no count of agent invocations.
 * - Tokens and cost are the MAIN agent's (`subagent=false`), which is the legacy session total's
 *   meaning. Subagent spend is not folded in.
 * - A project's `lastActivity` is a UTC day.
 *
 * `History` (the session list) and the activity sparkline stay on `/api/data`: the API has no session
 * list, and its message figure is a different quantity.
 */

import type { AppData, SurfaceHarnessId } from '@agentistics/core'
import { SURFACE_HARNESS_ORDER, projectedRollup, type MetricsQueryFn, type Rollup } from '@agentistics/core'
import { harnessRows, modelRows, overviewTotals, projectRows, type HarnessRow, type ModelRow, type ProjectRow, type Totals } from './selectors'

export interface DashboardFigures {
  harnesses: HarnessRow[]
  totals: Totals
  projects: ProjectRow[]
  models: ModelRow[]
  source: 'legacy' | 'projections'
}

export function legacyFigures(data: AppData): DashboardFigures {
  return { harnesses: harnessRows(data), totals: overviewTotals(data), projects: projectRows(data), models: modelRows(data), source: 'legacy' }
}

/** Every counter of the main agent: the legacy `sessionTokenTotal`'s meaning. */
const mainTokens = (r: Rollup) => r.main.input + r.main.output + r.main.cacheRead + r.main.cacheWrite

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export async function projectedFigures(q: MetricsQueryFn, harness: SurfaceHarnessId | null = null): Promise<DashboardFigures> {
  const scope = harness ?? undefined
  const [byHarness, byProject, byModel] = await Promise.all([
    projectedRollup(q, 'harness', scope),
    projectedRollup(q, 'project', scope),
    projectedRollup(q, 'model', scope),
  ])
  const harnesses: HarnessRow[] = [...byHarness.values()]
    .filter(r => r.key)
    .map(r => ({ harness: r.key as SurfaceHarnessId, sessions: r.sessions, messages: null, tokens: mainTokens(r), costUSD: r.mainCost, agents: null }))
    // The legacy screen's order: SURFACE_HARNESS_ORDER.
    .sort((a, b) => SURFACE_HARNESS_ORDER.indexOf(a.harness) - SURFACE_HARNESS_ORDER.indexOf(b.harness))
  const totals = harnesses.reduce<Totals>(
    (acc, r) => ({ sessions: acc.sessions + r.sessions, tokens: acc.tokens + r.tokens, costUSD: acc.costUSD + r.costUSD, messages: null }),
    { sessions: 0, tokens: 0, costUSD: 0, messages: null },
  )
  const projects: ProjectRow[] = [...byProject.values()]
    .map(r => ({ name: basename(r.key ?? ''), path: r.key ?? '', sessions: r.sessions, tokens: mainTokens(r), costUSD: r.mainCost, lastActivity: r.lastActive ?? '' }))
    .sort((a, b) => b.costUSD - a.costUSD)
  const models: ModelRow[] = [...byModel.values()]
    .filter(r => r.key)
    .map(r => ({ model: r.key!, tokens: mainTokens(r), costUSD: r.mainCost }))
    .sort((a, b) => b.costUSD - a.costUSD)
  return { harnesses, totals, projects, models, source: 'projections' }
}
