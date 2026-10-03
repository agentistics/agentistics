import type { DashboardFigures } from '../projected-figures'
import React from 'react'
import { Box } from 'ink'
import type { AppData } from '@agentistics/core'
import { fmt, fmtCost } from '@agentistics/core'
import { projectRows, type ProjectRow } from '../selectors'
import { DataTable, Empty, Pager, type Column } from '../components/Primitives'
import { COLORS } from '../theme'
import { listPlan, pageWindow } from '../dashboard/view'
import type { TuiStrings } from '../i18n'

export function Projects({ data, figures = null, s, width, height, page }: {
  data: AppData
  /** Projected figures (A4.6); absent → the selectors over `data`. */
  figures?: DashboardFigures | null
  s: TuiStrings
  width: number
  height: number
  /** The requested page, 0-based. Clamped here — the shell may hand over a stale one. */
  page?: number
}) {
  const all = figures?.projects ?? projectRows(data)
  if (all.length === 0) return <Empty message={s.noProjects} />

  const plan = listPlan(height, all.length)
  const win = pageWindow(all.length, plan.size, page ?? 0)

  // fitColumns gives the name column whatever the numeric columns leave over.
  const nameWidth = 24
  const columns: Column<ProjectRow>[] = [
    { key: 'name', header: s.project, width: nameWidth, render: r => r.name, color: () => COLORS.text },
    { key: 'cost', header: s.cost, width: 14, align: 'right', render: r => fmtCost(r.costUSD), color: () => COLORS.accent },
    { key: 'tokens', header: s.tokens, width: 10, align: 'right', render: r => fmt(r.tokens) },
    { key: 'sessions', header: s.sessionsCount, width: 10, align: 'right', render: r => String(r.sessions) },
    { key: 'last', header: s.lastActivity, width: 12, align: 'right', render: r => r.lastActivity.slice(0, 10) },
  ]

  // Fewer rows than the height: the table draws a header before the first result and the pager a
  // line under the last, and asking for `height` results would overflow by exactly those rows —
  // which Ink composites rather than clips.
  return (
    <Box flexDirection="column" flexShrink={0}>
      <DataTable
        columns={columns}
        rows={all.slice(win.from, win.to)}
        keyOf={r => r.path}
        width={width}
      />
      {plan.pager && <Pager window={win} total={all.length} s={s} />}
    </Box>
  )
}
