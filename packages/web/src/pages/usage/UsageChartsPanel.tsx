import { useMemo, useState } from 'react'
import type { SessionMeta, SurfaceHarnessId } from '@agentistics/core'
import { ActivityHeatmap } from '../../components/ActivityHeatmap'
import { ActivityPercentChart } from '../../components/ActivityChart'
import { HarnessFilter } from '../../components/HarnessFilter'
import { HourChart } from '../../components/HourChart'
import { SegmentedTabs } from '../../components/nav/SegmentedTabs'
import { Section } from '../../components/Section'
import { StatTile } from '../../components/StatTile'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import { seriesName, type PlanReadings } from '../../lib/planLimits'
import type { UsageBudgetRow } from '../../lib/usagePlan'
import { Select } from '../settings/primitives'
import { accountKey, accountLabel, type Lang } from './usageView'
import {
  limitSeries, messageActivity, rateRows, readingKey, scopeReadings, scopeSessions, toChartRows, topPeaks,
  type UsageScope, type UsageScopeMode,
} from './usageChartsModel'

const HOUR = 3_600_000
const WINDOW_MS = { '5h': 5 * HOUR, week: 7 * 24 * HOUR } as const

const T = {
  pt: {
    modes: { all: 'Tudo sobreposto', harness: 'Um harness', account: 'Uma conta' }, filter: 'Visão dos gráficos', account: 'Conta',
    limits: 'Limites ao longo do tempo', five: 'Janela de 5 h', week: 'Semana', hours: 'Horas de uso', peaks: 'Picos',
    none: 'Ainda não há histórico de uso registrado.', noWindow: 'Sem leituras desta janela.', noMsgs: 'Sem mensagens no período.', noPeaks: 'Sem subida no período.',
    omitted: (n: string) => `Sem janela de 5 h (omitido): ${n}.`, perDay: 'Mensagens por dia (14 dias)', perHour: 'Mensagens por hora do dia',
    top: (i: number) => `Pico ${i}`, rate: 'Subida (pontos %/h)', messages: 'mensagens',
  },
  en: {
    modes: { all: 'All overlaid', harness: 'One harness', account: 'One account' }, filter: 'Chart view', account: 'Account',
    limits: 'Limits over time', five: '5 h window', week: 'Week', hours: 'Hours of use', peaks: 'Peaks',
    none: 'No usage history recorded yet.', noWindow: 'No readings for this window.', noMsgs: 'No messages in the period.', noPeaks: 'No rise in the period.',
    omitted: (n: string) => `No 5 h window (omitted): ${n}.`, perDay: 'Messages per day (14 days)', perHour: 'Messages by hour of day',
    top: (i: number) => `Peak ${i}`, rate: 'Rise (% points/h)', messages: 'messages',
  },
} as const

/** The Usage screen's one panel: a single filter drives the limits, hours and peaks charts together. */
export function UsageChartsPanel({ budgets, readings, sessions, lang, now = Date.now() }: {
  budgets: readonly UsageBudgetRow[]; readings: readonly PlanReadings[]; sessions: readonly SessionMeta[]; lang: Lang; now?: number
}) {
  const t = T[lang]
  const isMobile = useIsMobile()
  const [mode, setMode] = useState<UsageScopeMode>('all')
  const [picked, setPicked] = useState<{ harness?: string; account?: string }>({})
  const budgetOf = (r: PlanReadings) => budgets.find(b => accountKey(b) === readingKey(r))
  const labelOf = (r: PlanReadings) => seriesName(HARNESS_LABELS[r.harness], budgetOf(r) ? accountLabel(budgetOf(r)!) : r.account)
  const harnesses = useMemo(() => [...new Set(readings.map(r => r.harness))] as SurfaceHarnessId[], [readings])
  const accounts = useMemo(() => readings.map(r => ({ value: readingKey(r), label: labelOf(r) })), [readings, budgets]) // eslint-disable-line react-hooks/exhaustive-deps
  const key = mode === 'harness' ? picked.harness ?? harnesses[0] : mode === 'account' ? picked.account ?? accounts[0]?.value : undefined
  const scope: UsageScope = { mode, key }

  const view = useMemo(() => {
    const rs = scopeReadings(readings, scope)
    const five = limitSeries(rs, '5h', labelOf, now - 48 * HOUR)
    const week = limitSeries(rs, 'week', labelOf)
    const msgs = messageActivity(scopeSessions(sessions, scope), now)
    const peaks = [...topPeaks(five.series, '5h'), ...topPeaks(week.series, 'week')].sort((a, b) => b.ratePerHour - a.ratePerHour).slice(0, 4)
    return { five, week, msgs, peaks, rate: rateRows([...five.series, ...week.series]) }
  }, [readings, sessions, mode, key, now]) // eslint-disable-line react-hooks/exhaustive-deps

  const lineChart = (kind: '5h' | 'week', data: typeof view.five, first = false) => {
    const { rows, keys } = toChartRows(data.series, WINDOW_MS[kind])
    return rows.length
      ? <ActivityPercentChart lang={lang} data={rows} series={keys.map(k => ({ key: k.key, label: k.label, color: colorOf(k.harness, k.key, keys), connectNulls: false }))} />
      : <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{view.five.series.length + view.week.series.length ? t.noWindow : first ? t.none : ''}</p>
  }
  const heading = (text: string) => <h2 style={{ fontSize: 13, margin: '0 0 8px' }}>{text}</h2>
  const sub = { minWidth: 0 } as const
  const two = { display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: 16 } as const

  return <Section title={t.limits} contentStyle={{ minWidth: 0 }}>
    <div data-usage-filter style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 16 }}>
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>
        <SegmentedTabs ariaLabel={t.filter} value={mode} onChange={setMode} equal tabs={(['all', 'harness', 'account'] as const).map(id => ({ id, label: t.modes[id] }))} />
      </div>
      {mode === 'harness' && <HarnessFilter lang={lang} harnesses={harnesses} selected={key ? [key as SurfaceHarnessId] : []}
        onChange={next => setPicked(p => ({ ...p, harness: next.filter(h => h !== p.harness && h !== key)[0] ?? key }))} />}
      {mode === 'account' && <div style={{ minWidth: 200 }}><Select value={key ?? ''} onChange={account => setPicked(p => ({ ...p, account }))} options={accounts} placeholder={t.account} /></div>}
    </div>

    <div style={{ display: 'grid', gap: 24, minWidth: 0 }}>
      <div data-usage-chart="limits" style={two}>
        <div style={sub}>{heading(t.five)}{lineChart('5h', view.five, true)}{view.five.omitted.length > 0 && <p style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t.omitted(view.five.omitted.join(', '))}</p>}</div>
        <div style={sub}>{heading(t.week)}{lineChart('week', view.week)}</div>
      </div>

      <div data-usage-chart="hours" style={sub}>
        {heading(t.hours)}
        {view.msgs.total === 0 ? <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t.noMsgs}</p> : <div style={two}>
          <div style={sub}><div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>{t.perDay}</div><ActivityHeatmap data={view.msgs.perDay} weeks={8} /></div>
          <div style={sub}><div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>{t.perHour}</div><HourChart hourCounts={view.msgs.hourCounts} height={isMobile ? 220 : 260} /></div>
        </div>}
      </div>

      <div data-usage-chart="peaks" style={sub}>
        {heading(t.peaks)}
        {view.peaks.length === 0 ? <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t.noPeaks}</p> : <>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
            {view.peaks.map((p, i) => <StatTile key={`${p.label}:${p.kind}:${p.at}`} label={`${t.top(i + 1)} · ${p.label} · ${p.kind === 'week' ? t.week : '5 h'}`}
              value={`+${p.ratePerHour.toFixed(1)} pp/h`} title={new Date(p.at).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US')} />)}
          </div>
          <ActivityPercentChart lang={lang} data={view.rate} series={[{ key: 'rate', label: t.rate, color: 'var(--anthropic-orange)', connectNulls: true }]} height={160} />
        </>}
      </div>
    </div>
  </Section>
}

/** One colour per line: the harness's own; the nth line of the same harness shifts to the shared palette. */
function colorOf(harness: SurfaceHarnessId | string, key: string, keys: { key: string; harness: string }[]): string {
  const same = keys.filter(k => k.harness === harness)
  const n = same.findIndex(k => k.key === key)
  const palette = Object.values(HARNESS_COLORS)
  return n <= 0 ? HARNESS_COLORS[harness as SurfaceHarnessId] : palette[(palette.indexOf(HARNESS_COLORS[harness as SurfaceHarnessId]) + n) % palette.length]!
}
