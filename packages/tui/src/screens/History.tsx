/**
 * History — the sessions this machine has RECORDED, and what each of them cost.
 *
 * It was called `Sessions` while the dashboard was an application of its own. Inside the control
 * center that name is taken, by something genuinely different: the `sessions` tab is the fleet
 * running right now — rows you attach to, approve and kill. This screen is the past, which is
 * exactly what the `history` setting preserves, and the two must not share a word.
 */

import React from 'react'
import { Box } from 'ink'
import type { AppData } from '@agentistics/core'
import { fmt, fmtCost } from '@agentistics/core'
import { sessionRows, type SessionRow } from '../selectors'
import { DataTable, Empty, Pager, type Column } from '../components/Primitives'
import { COLORS, harnessColor, harnessLabel } from '../theme'
import { listPlan, pageWindow } from '../dashboard/view'
import type { TuiStrings } from '../i18n'

export function History({ data, s, width, height, page }: {
  data: AppData
  s: TuiStrings
  width: number
  height: number
  /** The requested page, 0-based. Clamped here — the shell may hand over a stale one. */
  page?: number
}) {
  // The WHOLE list the filter left standing. It used to be sliced to the terminal's height with no
  // way to reach anything below the fold, so a machine holding hundreds of sessions answered with
  // the twenty-five that happened to fit.
  const all = sessionRows(data)
  if (all.length === 0) return <Empty message={s.noSessions} />

  // The table spends a row on its header and the pager another, so the rows a page may draw are
  // fewer than the height it was given — drawing over them is overflow, which Ink composites onto
  // whatever is below.
  const plan = listPlan(height, all.length)
  const win = pageWindow(all.length, plan.size, page ?? 0)
  const rows = all.slice(win.from, win.to)

  const labelWidth = 24
  const columns: Column<SessionRow>[] = [
    {
      key: 'label',
      header: s.history,
      width: labelWidth,
      // A live session is the one thing worth interrupting the scan for.
      render: r => (r.live ? `● ${r.label || r.id.slice(0, 8)}` : r.label || r.id.slice(0, 8)),
      color: r => (r.live ? COLORS.success : COLORS.text),
    },
    { key: 'harness', header: s.harness, width: 13, render: r => harnessLabel(r.harness), color: r => harnessColor(r.harness) },
    { key: 'project', header: s.project, width: 16, render: r => r.project },
    { key: 'cost', header: s.cost, width: 13, align: 'right', render: r => fmtCost(r.costUSD), color: () => COLORS.accent },
    { key: 'tokens', header: s.tokens, width: 9, align: 'right', render: r => fmt(r.tokens) },
    { key: 'started', header: s.started, width: 12, align: 'right', render: r => r.startTime.slice(0, 10) },
  ]

  return (
    <Box flexDirection="column" flexShrink={0}>
      <DataTable columns={columns} rows={rows} keyOf={r => r.id} width={width} />
      {plan.pager && <Pager window={win} total={all.length} s={s} />}
    </Box>
  )
}
