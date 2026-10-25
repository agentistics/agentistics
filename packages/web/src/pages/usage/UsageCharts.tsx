import type { PlanLimits } from '@agentistics/core'
import { ActivityPercentChart } from '../../components/ActivityChart'
import { Section } from '../../components/Section'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import type { PlanReadings } from '../../lib/planLimits'
import type { UsageBudgetRow } from '../../lib/usagePlan'
import { accountKey, accountLabel, orderedBudgets, type Lang } from './usageView'

const WEEK = 7 * 24 * 3_600_000
export function usageChartData(reading: PlanReadings, kind: 'week' | '5h', reset?: number, currentWindowOnly = false) {
  const duration = kind === 'week' ? WEEK : 5 * 3_600_000
  const start = reset === undefined ? undefined : reset - duration
  const points = new Map<number, { at: number; actual: number | null; expected: number | null }>()
  for (const p of reading.points) {
    const pct = kind === 'week' ? p.weekPct : p.fiveHourPct
    // Agora compares the current window; history retains all observed percentages.
    if (currentWindowOnly && start !== undefined && (p.at < start || p.at > reset!)) continue
    points.set(p.at, { at: p.at, actual: pct, expected: start === undefined || p.at < start || p.at > reset! ? null : (p.at - start) / duration * 100 })
  }
  if (![...points.values()].some(p => p.actual !== null)) return []
  if (start !== undefined && reset !== undefined) {
    if (!points.has(start)) points.set(start, { at: start, actual: null, expected: 0 })
    if (!points.has(reset)) points.set(reset, { at: reset, actual: null, expected: 100 })
  }
  return [...points.values()].sort((a, b) => a.at - b.at)
}

/** Both pages compose the same chart and account matching rules. */
export function UsageCharts({ budgets, readings, limits, lang, bothWindows = false }: {
  budgets: UsageBudgetRow[]; readings: PlanReadings[]; limits: PlanLimits[] | null; lang: Lang; bothWindows?: boolean
}) {
  const pt = lang === 'pt'
  const rows = orderedBudgets(budgets)
  // Keep readings visible even if their budget is temporarily unavailable.
  const accounts = [...rows.map(r => ({ account: r.account ?? 'default', harness: r.harness, label: `${HARNESS_LABELS[r.harness]} · ${accountLabel(r)}`, budget: r })),
    ...readings.filter(r => !rows.some(b => accountKey(b) === `${r.harness}:${r.account}`)).map(r => ({ ...r, label: `${HARNESS_LABELS[r.harness]} · ${r.account}`, budget: undefined }))]
  const labels = accounts.map(row => row.label)
  for (const row of accounts) {
    if (labels.filter(label => label === row.label).length > 1) row.label += ` · ${row.account}`
  }
  const empty = <p style={{ color: 'var(--text-secondary)' }}>{pt ? 'Ainda não há histórico de uso registrado desde que o servidor iniciou. As leituras atuais aparecem em Agora.' : 'No usage history recorded since the server started. Current readings appear in Now.'}</p>
  const charts = accounts.map(row => {
    const reading = readings.find(r => r.account === row.account && r.harness === row.harness)
    if (!reading) return { row, windows: [] }
    const windows = (bothWindows ? ['week', '5h'] as const : ['week'] as const).flatMap(kind => {
      const limit = limits?.find(l => l.account === row.account && l.harness === row.harness)?.windows.find(w => w.kind === kind)
      const reset = kind === 'week' ? row.budget?.weekResetsAt ?? limit?.resetsAt : limit?.resetsAt
      const data = usageChartData(reading, kind, reset, !bothWindows)
      return data.length ? [{ kind, reset, data }] : []
    })
    return { row, windows }
  }).filter(c => c.windows.length)
  if (!charts.length) return empty
  if (!bothWindows) {
    const points = new Map<number, { at: number; [key: string]: number | null }>()
    const series = charts.flatMap(({ row, windows }, i) => {
      const window = windows[0]!
      for (const p of window.data) {
        const point = points.get(p.at) ?? { at: p.at }
        point[`actual${i}`] = p.actual
        point[`expected${i}`] = p.expected
        points.set(p.at, point)
      }
      const color = Object.values(HARNESS_COLORS)[i % Object.values(HARNESS_COLORS).length]!
      return [
        { key: `actual${i}`, label: `${row.label} · ${pt ? 'real' : 'actual'}`, color, connectNulls: true },
        ...(window.reset === undefined ? [] : [{ key: `expected${i}`, label: `${row.label} · ${pt ? 'esperado' : 'expected'}`, color, expected: true }]),
      ]
    })
    // Fill expected values at the union of account timestamps; leave absent actual readings null.
    const data = [...points.values()].sort((a, b) => a.at - b.at).map(p => {
      charts.forEach(({ windows }, i) => {
        p[`actual${i}`] ??= null
        const reset = windows[0]!.reset
        p[`expected${i}`] = reset !== undefined && p.at >= reset - WEEK && p.at <= reset ? (p.at - (reset - WEEK)) / WEEK * 100 : null
      })
      return p
    })
    return <ActivityPercentChart lang={lang} data={data} series={series} />
  }
  return <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>{charts.map(({ row, windows }) => <Section key={`${row.harness}:${row.account}`} title={row.label}>
    {windows.map(({ kind, reset, data }) => <div key={kind}>
      <h2 style={{ fontSize: 13 }}>{kind === 'week' ? (pt ? 'Semana' : 'Week') : '5 h'}</h2>
      <ActivityPercentChart lang={lang} data={data} series={[
        { key: 'actual', label: pt ? 'Real' : 'Actual', color: HARNESS_COLORS[row.harness] },
        ...(reset === undefined ? [] : [{ key: 'expected', label: pt ? 'Esperado' : 'Expected', color: 'var(--text-secondary)', expected: true }]),
      ]} />
      {reset === undefined && <p>{pt ? 'Sem horário de renovação para calcular o esperado.' : 'No renewal time to calculate expected usage.'}</p>}
    </div>)}
  </Section>)}</div>
}
