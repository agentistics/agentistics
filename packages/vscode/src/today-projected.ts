/**
 * today-projected.ts: today's totals read from the PROJECTIONS (`GET /api/runtime/metrics`, P3 / A4.5)
 * instead of `/api/data`. Used when the person opted this surface in: the `agentistics.readProjections`
 * setting, or `AGENTISTICS_PROJECTIONS_SURFACES` naming `vscode` in the editor's environment.
 *
 * The question is the same: what today has cost, by the UTC day the dashboard also uses. The answer is
 * a few hundred bytes instead of the whole `/api/data` payload. It is also more exact for a session
 * that crosses midnight:
 * - the legacy rule (`today.ts`) files a WHOLE session under the day it STARTED;
 * - the journal files each response under the day it was billed.
 *
 * So yesterday's long session no longer hides tonight's spend, and today's figure no longer carries
 * yesterday's.
 *
 * Tokens (all four counters) and cost are the main agent's (`subagent=false`), which is the legacy
 * per-session figure's meaning. `sessions` counts the sessions with activity today.
 *
 * A refusal (404 when the gate is off, 409 on a central, 503 with no reader) throws
 * `ProjectionUnavailable`, and the caller reads `/api/data` as before.
 */
import { allMetricGroups, type MetricsQueryFn } from '@agentistics/core'
import { dayKey, type TodayTotals } from './today'

export async function projectedToday(q: MetricsQueryFn, now: Date): Promise<TodayTotals> {
  const day = dayKey(now)
  const [spend, sessions] = await Promise.all([
    allMetricGroups(q, { from: day, to: day, subagent: 'false', metrics: 'tokens,cost' }),
    allMetricGroups(q, { from: day, to: day, metrics: 'sessions' }),
  ])
  const g = spend.groups[0]
  return {
    costUSD: g?.metrics.cost?.usd ?? 0,
    tokens: g?.metrics.tokens?.total ?? 0,
    sessions: sessions.groups[0]?.metrics.sessions?.count ?? 0,
  }
}
