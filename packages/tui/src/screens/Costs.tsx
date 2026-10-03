import type { DashboardFigures } from '../projected-figures'
import React from 'react'
import { Box } from 'ink'
import type { AppData } from '@agentistics/core'
import { fmt, fmtCost, formatModel } from '@agentistics/core'
import { modelRows, type ModelRow } from '../selectors'
import { DataTable, Empty, BarRow, Pager, Section, type Column } from '../components/Primitives'
import { COLORS } from '../theme'
import { costsPlan, pageWindow } from '../dashboard/view'
import type { TuiStrings } from '../i18n'

export function Costs({ data, figures = null, s, width, height, page }: {
  data: AppData
  /** Projected figures (A4.6); absent → the selectors over `data`. */
  figures?: DashboardFigures | null
  s: TuiStrings
  width: number
  height: number
  /** The requested page, 0-based. Clamped here — the shell may hand over a stale one. */
  page?: number
}) {
  const rows = figures?.models ?? modelRows(data)
  if (rows.length === 0) return <Empty message={s.empty} />

  const total = rows.reduce((n, r) => n + r.costUSD, 0)
  const nameWidth = 24
  const barWidth = Math.max(8, Math.min(24, width - 46))

  const columns: Column<ModelRow>[] = [
    { key: 'model', header: s.model, width: nameWidth, render: r => formatModel(r.model) || r.model },
    { key: 'cost', header: s.cost, width: 14, align: 'right', render: r => fmtCost(r.costUSD), color: () => COLORS.accent },
    { key: 'tokens', header: s.tokens, width: 10, align: 'right', render: r => fmt(r.tokens) },
    { key: 'share', header: s.share, width: 8, align: 'right', render: r => total > 0 ? `${Math.round((r.costUSD / total) * 100)}%` : '0%' },
  ]

  // The table is the screen and the share panel re-states its top five as bars, so the panel is what
  // gives way — whole, never partially. See `costsPlan`.
  const plan = costsPlan(height, rows.length)
  const win = pageWindow(rows.length, plan.table, page ?? 0)

  return (
    <Box flexDirection="column" flexShrink={0}>
      <DataTable columns={columns} rows={rows.slice(win.from, win.to)} keyOf={r => r.model} width={width} />
      {plan.pager && <Pager window={win} total={rows.length} s={s} />}
      {plan.share > 0 && (
        <Section title={s.share}>
          {rows.slice(0, plan.share).map(r => (
            <BarRow
              key={r.model}
              label={formatModel(r.model) || r.model}
              pct={total > 0 ? r.costUSD / total : 0}
              value={fmtCost(r.costUSD)}
              color={COLORS.accent}
              labelWidth={Math.min(22, Math.max(12, nameWidth))}
              barWidth={barWidth}
            />
          ))}
        </Section>
      )}
    </Box>
  )
}
