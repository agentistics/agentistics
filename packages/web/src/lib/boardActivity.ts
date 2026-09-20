/**
 * boardActivity.ts — reshapes `BoardOverview.daily` (the board's own counts, already computed
 * server-side by `task-overview.ts`) into the generic `{date, value, sessions, tools}` shape
 * `ActivityChart` expects.
 *
 * This is presentation-only renaming, never arithmetic: every number here was already summed by
 * the server, so this file may not add, filter or reinterpret a single one of them — the same rule
 * `lib/tasks.ts` states for itself ("It holds NO arithmetic").
 *
 * Money is deliberately left OUT of this mapping. `ActivityChart`'s three slots are always plain
 * counts (Messages/Sessions/Tool Calls everywhere else it is used) with no currency or plan-basis
 * conversion wired in, and `components/tasks/money.ts` exists specifically because this board must
 * never print a dollar figure that ignores the reader's own currency/basis — reusing the chart for a
 * per-day cost series would reintroduce exactly that bug. `RepoDetailPage`/`TagDetailPage` hit the
 * same wall and answered it by building their OWN small area chart for money, rather than stretching
 * this component to do currency math it was never given the plumbing for. The board's cost figures
 * stay on the existing (currency-correct) KPI cards; this chart carries only counts.
 */

import type { BoardDailyPoint } from './tasks'

export interface BoardChartPoint {
  date: string
  value: number
  sessions: number
  tools: number
}

/**
 * `value` -> sessions started that day, `sessions` -> tasks delivered that day,
 * `tools` -> tasks created that day. The labels callers see come from `ActivityChart`'s own
 * `metricLabels` override — this function only carries the numbers across.
 */
export function toBoardChartData(daily: readonly BoardDailyPoint[]): BoardChartPoint[] {
  return daily.map(d => ({
    date: d.date,
    value: d.sessionsStarted,
    sessions: d.delivered,
    tools: d.created,
  }))
}
