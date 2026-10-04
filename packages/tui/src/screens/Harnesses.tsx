import type { DashboardFigures } from '../projected-figures'
import React from 'react'
import { Box, Text } from 'ink'
import type { AppData, SurfaceHarnessId } from '@agentistics/core'
import { fmt, fmtCost, HARNESS_CAPABILITIES } from '@agentistics/core'
import { harnessRows, type HarnessRow } from '../selectors'
import { DataTable, Empty, type Column } from '../components/Primitives'
import { COLORS, harnessColor, harnessLabel } from '../theme'
import { listRows } from '../dashboard/view'
import type { TuiStrings } from '../i18n'

/**
 * Renders a metric the harness cannot produce as N/A.
 *
 * A harness with no token data must never render a confident `0` — the whole point of
 * HARNESS_CAPABILITIES is that an admitted gap beats a wrong number.
 */
function capable(harness: SurfaceHarnessId, metric: 'tokens' | 'cost' | 'agents'): boolean {
  return HARNESS_CAPABILITIES[harness]?.[metric] ?? false
}

export function Harnesses({ data, figures = null, s, width, height }: {
  data: AppData
  /** Projected figures (A4.6); absent → the selectors over `data`. */
  figures?: DashboardFigures | null
  s: TuiStrings
  width: number
  /** Rows this screen may use — its table draws a header before the first harness. */
  height: number
}) {
  const rows = figures?.harnesses ?? harnessRows(data)
  if (rows.length === 0) return <Empty message={s.empty} />

  const nameWidth = 14
  const columns: Column<HarnessRow>[] = [
    { key: 'h', header: s.harness, width: nameWidth, render: r => harnessLabel(r.harness), color: r => harnessColor(r.harness) },
    {
      key: 'cost', header: s.cost, width: 14, align: 'right',
      render: r => (capable(r.harness, 'cost') ? fmtCost(r.costUSD) : 'N/A'),
      color: r => (capable(r.harness, 'cost') ? COLORS.accent : undefined),
    },
    {
      key: 'tokens', header: s.tokens, width: 10, align: 'right',
      render: r => (capable(r.harness, 'tokens') ? fmt(r.tokens) : 'N/A'),
    },
    { key: 'sessions', header: s.sessionsCount, width: 10, align: 'right', render: r => fmt(r.sessions) },
    {
      // Only Claude records Agent invocations. Everywhere else this is structurally 0, and a
      // confident 0 would read as "no agents used" rather than "not measurable here".
      key: 'agents', header: s.agents, width: 9, align: 'right',
      render: r => (capable(r.harness, 'agents') && r.agents !== null ? fmt(r.agents) : 'N/A'),
    },
  ]

  return (
    <Box flexDirection="column">
      <DataTable columns={columns} rows={rows.slice(0, listRows(height))} keyOf={r => r.harness} width={width} />
    </Box>
  )
}
