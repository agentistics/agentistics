import type { DashboardFigures } from '../projected-figures'
import React from 'react'
import { Box, Text } from 'ink'
import type { AppData } from '@agentistics/core'
import { fmt, fmtCost } from '@agentistics/core'
import { harnessRows, overviewTotals, activitySeries } from '../selectors'
import { Kpi, KpiRow, BarRow, Section, Empty, truncate } from '../components/Primitives'
import { Sparkline } from '../components/Sparkline'
import { COLORS, harnessColor, harnessLabel } from '../theme'
import { costByTaskLines, costByTaskRows, overviewPlan } from '../dashboard/view'
import type { CostByTask } from '../control/types'
import type { TuiStrings } from '../i18n'

const ACTIVITY_DAYS = 30

interface KpiSpec {
  label: string
  value: string
  color?: string
  width: number
}

/** Each Kpi adds a 2-column right margin, so its real footprint is width + 2. */
const KPI_MARGIN = 2

/**
 * Keeps the leading KPIs that fit the terminal and drops the rest.
 *
 * Exported for tests: the failure this prevents (a 74-column KPI row rendered into 60 columns,
 * wrapping and misaligning every row beneath it) is invisible until a narrow terminal is used.
 */
export function fitKpis(kpis: KpiSpec[], width: number): KpiSpec[] {
  const out: KpiSpec[] = []
  let used = 0
  for (const k of kpis) {
    const next = used + k.width + KPI_MARGIN
    if (out.length > 0 && next > width) break
    out.push(k)
    used = next
  }
  return out
}

export function Overview({ data, figures = null, s, width, height, streak, byTask = null, filtered = false }: {
  data: AppData
  /** Projected figures (A4.6); absent → the selectors over `data`. */
  figures?: DashboardFigures | null
  s: TuiStrings
  width: number
  /** Rows this screen may use. It is drawn inside a pane now, so it is not the terminal's. */
  height: number
  streak: number
  /** EX-01: today's cost by task, from the host; `null` = not read (the panel is not drawn). */
  byTask?: CostByTask | null
  /** A harness filter is on — the panel is NOT filtered, and its title says so. */
  filtered?: boolean
}) {
  const totals = figures?.totals ?? overviewTotals(data)
  const rows = figures?.harnesses ?? harnessRows(data)
  const series = activitySeries(data, ACTIVITY_DAYS, new Date())
  const totalCost = rows.reduce((n, r) => n + r.costUSD, 0)

  const LABEL_W = 13
  const barValues = rows.map(r => `${fmtCost(r.costUSD)}  ${fmt(r.tokens)} tok`)
  const widestValue = barValues.reduce((n, v) => Math.max(n, v.length), 0)
  // Size the bar from what is actually LEFT after the label and the value, rather than a fixed
  // guess — otherwise a long "USD 8,363.48  13.3B tok" pushes the row past the terminal edge.
  const barWidth = Math.max(6, Math.min(30, width - LABEL_W - widestValue - 2))

  // KPIs are dropped from the right as the terminal narrows rather than wrapping: a wrapped KPI
  // row pushes everything below it down and misaligns the whole screen. Cost is never dropped.
  const visibleKpis = fitKpis(
    [
      { label: s.cost, value: fmtCost(totals.costUSD), color: COLORS.accent, width: 18 },
      { label: s.tokens, value: fmt(totals.tokens), color: COLORS.info, width: 12 },
      { label: s.sessionsCount, value: fmt(totals.sessions), width: 12 },
      { label: s.messages, value: totals.messages === null ? '—' : fmt(totals.messages), width: 12 },
      { label: s.streak, value: s.days(streak), color: COLORS.success, width: 10 },
    ],
    width,
  )

  // What this screen can afford: the KPI row stays, the sparkline is the first thing to go, and the
  // harness bars are trimmed last. See `overviewPlan` for why that order and not another.
  const plan = overviewPlan(height, rows.length, costByTaskRows(byTask))
  const taskLines = byTask ? costByTaskLines(byTask, plan.tasks) : []
  const taskMax = taskLines.reduce((n, l) => Math.max(n, l.cost), 0)
  const TASK_LABEL_W = Math.min(32, Math.max(14, Math.floor(width / 3)))
  const taskBarW = Math.max(6, Math.min(30, width - TASK_LABEL_W - 12))
  const bars = rows.slice(0, plan.bars)

  return (
    <Box flexDirection="column">
      {plan.kpis && (
        <KpiRow>
          {visibleKpis.map(k => (
            <Kpi key={k.label} label={k.label} value={k.value} color={k.color} width={k.width} />
          ))}
        </KpiRow>
      )}

      {plan.activity && (
        <Section title={s.activity30d}>
          <Sparkline values={series} color={COLORS.accent} />
        </Section>
      )}

      {(plan.empty || plan.bars > 0) && (
      <Section title={s.harnesses}>
        {plan.empty ? (
          <Empty message={s.empty} />
        ) : (
          bars.map((r, i) => (
            <BarRow
              key={r.harness}
              label={harnessLabel(r.harness)}
              color={harnessColor(r.harness)}
              pct={totalCost > 0 ? r.costUSD / totalCost : 0}
              value={barValues[i] ?? ''}
              labelWidth={LABEL_W}
              barWidth={barWidth}
            />
          ))
        )}
      </Section>
      )}

      {plan.tasks > 0 && byTask && (
        <Section title={truncate(filtered ? s.costByTaskAll : s.costByTaskToday, width)}>
          {taskLines.map((l, i) => l.kind === 'none'
            ? <Text key={i} dimColor>{s.noSessionToday}</Text>
            : (
              <BarRow
                key={i}
                label={l.kind === 'not-filed' ? s.notFiled : l.label}
                color={l.kind === 'not-filed' ? COLORS.danger : COLORS.accent}
                pct={taskMax > 0 ? l.cost / taskMax : 0}
                value={fmtCost(l.cost)}
                labelWidth={TASK_LABEL_W}
                barWidth={taskBarW}
              />
            ))}
        </Section>
      )}
    </Box>
  )
}
