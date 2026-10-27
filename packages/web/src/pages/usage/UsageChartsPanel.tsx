import { useMemo, useState } from 'react'
import type { SessionMeta, SurfaceHarnessId } from '@agentistics/core'
import { ActivityPercentChart } from '../../components/ActivityChart'
import { WeekHourHeatmap } from '../../components/charts/WeekHourHeatmap'
import { UsageHourlyBars } from '../../components/charts/UsageHourlyBars'
import { SegmentedTabs } from '../../components/nav/SegmentedTabs'
import { Section } from '../../components/Section'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HARNESS_LABELS } from '../../lib/harness'
import { seriesName, type PlanReadings } from '../../lib/planLimits'
import type { UsageBudgetRow } from '../../lib/usagePlan'
import { usageColors } from '../../lib/usageColors'
import { Select } from '../settings/primitives'
import { accountKey, accountLabel, type Lang } from './usageView'
import {
  harnessSeries, hourlyUsage, limitSeries, messageActivity, readingKey, scopeReadings, scopeSessions, toChartRows, topPeaks,
  type UsageScope, type UsageScopeMode,
} from './usageChartsModel'

const HOUR = 3_600_000
const WINDOW_MS = { '5h': 5 * HOUR, week: 7 * 24 * HOUR } as const
const T = {
  pt: {
    modes: { accounts: 'Por conta', all: 'Tudo sobreposto', harnesses: 'Sobreposto por harness', harness: 'Um harness', account: 'Uma conta' },
    filter: 'Visão dos gráficos', account: 'Conta', limits: 'Limites ao longo do tempo', five: 'Janela de 5 h', week: 'Semana', hours: 'Horas de uso',
    fiveDesc: 'Quanto do limite de 5 horas cada conta já usou; uma renovação começa outro trecho.',
    weekDesc: 'Quanto do limite semanal cada conta já usou; a linha recomeça quando o limite renova.',
    harnessDesc: 'Por harness, mostramos a maior porcentagem entre suas contas em cada leitura.',
    none: 'Ainda não há histórico de uso registrado.', noWindow: 'Sem leituras suficientes desta janela.', noMsgs: 'Sem mensagens no período.', noPeaks: 'Sem aumento observado no período.',
    noReading: 'sem leitura de limites', omitted: (n: string) => `Sem janela de 5 h (omitido): ${n}.`,
    perDay: 'Mensagens por dia da semana e hora (14 dias)', hoursDesc: 'Mensagens enviadas nos últimos 14 dias, agrupadas pelo horário local.',
    peaks: 'Quando o limite subiu mais rápido', peaksDesc: 'Os momentos em que uma conta gastou mais do seu limite em pouco tempo.',
    bars: 'Quanto do limite de 5 h foi usado em cada hora. Aumentos entre leituras são distribuídos pelo intervalo observado.',
    messagePeaks: 'Horários com mais mensagens', messagePeaksDesc: 'Sem leituras de limites, os horários de maior atividade vêm das mensagens.',
    messages: 'mensagens', used: 'gastou', of: 'do limite de', in: 'em', min: 'min', weekly: 'uma semana',
  },
  en: {
    modes: { accounts: 'By account', all: 'All overlaid', harnesses: 'Overlaid by harness', harness: 'One harness', account: 'One account' },
    filter: 'Chart view', account: 'Account', limits: 'Limits over time', five: '5 h window', week: 'Week', hours: 'Hours of use',
    fiveDesc: 'How much of each account’s 5-hour limit has been used; a renewal starts a new segment.',
    weekDesc: 'How much of each account’s weekly limit has been used; the line restarts when the limit renews.',
    harnessDesc: 'For each harness, we show the highest percentage across its accounts at each reading.',
    none: 'No usage history recorded yet.', noWindow: 'Not enough readings for this window.', noMsgs: 'No messages in the period.', noPeaks: 'No observed increase in the period.',
    noReading: 'no limit readings', omitted: (n: string) => `No 5 h window (omitted): ${n}.`,
    perDay: 'Messages by weekday and hour (14 days)', hoursDesc: 'Messages sent in the last 14 days, grouped by local time.',
    peaks: 'When the limit was used fastest', peaksDesc: 'The moments when an account used more of its limit in a short time.',
    bars: 'How much of the 5 h limit was used each hour. Increases between readings are spread over the observed interval.',
    messagePeaks: 'Hours with the most messages', messagePeaksDesc: 'Without limit readings, the busiest hours come from messages.',
    messages: 'messages', used: 'used', of: 'of the', in: 'in', min: 'min', weekly: 'one week',
  },
} as const

/** One filter selects both plan readings and message activity. Accounts remain below this panel. */
export function UsageChartsPanel({ budgets, readings, sessions, harnesses: available = [], lang, now = Date.now() }: {
  budgets: readonly UsageBudgetRow[]; readings: readonly PlanReadings[]; sessions: readonly SessionMeta[];
  harnesses?: readonly SurfaceHarnessId[]; lang: Lang; now?: number
}) {
  const t = T[lang], isMobile = useIsMobile()
  const [mode, setMode] = useState<UsageScopeMode>('accounts')
  const [picked, setPicked] = useState<{ harness?: string; account?: string }>({})
  const budgetOf = (r: PlanReadings) => budgets.find(b => accountKey(b) === readingKey(r))
  const labelOf = (r: PlanReadings) => seriesName(HARNESS_LABELS[r.harness], budgetOf(r) ? accountLabel(budgetOf(r)!) : r.account)
  const harnesses = useMemo(() => [...new Set([...available, ...sessions.map(s => s.harness), ...readings.map(r => r.harness)])], [available, sessions, readings])
  const accounts = useMemo(() => [...readings].sort((a, b) => readingKey(a).localeCompare(readingKey(b))).map(r => ({ value: readingKey(r), label: labelOf(r) })), [readings, budgets]) // eslint-disable-line react-hooks/exhaustive-deps
  const colors = useMemo(() => usageColors([...budgets.map(accountKey), ...readings.map(readingKey)]), [budgets, readings])
  const harnessColors = useMemo(() => usageColors(harnesses), [harnesses])
  const key = mode === 'harness' ? picked.harness ?? harnesses[0] : mode === 'account' ? picked.account ?? accounts[0]?.value : undefined
  const scope: UsageScope = { mode, key }
  const color = (identity: string) => (mode === 'harnesses' ? harnessColors : colors).get(mode === 'harnesses' ? identity.split(':')[0]! : identity) ?? 'var(--anthropic-orange)'
  const view = useMemo(() => {
    const rs = scopeReadings(readings, scope).sort((a, b) => readingKey(a).localeCompare(readingKey(b))), ss = scopeSessions(sessions, scope)
    const rawFive = limitSeries(rs, '5h', labelOf, now - 48 * HOUR)
    const rawWeek = limitSeries(rs, 'week', labelOf)
    const group = (data: typeof rawFive, kind: '5h' | 'week') => mode === 'harnesses'
      ? { ...data, series: harnessSeries(data.series, WINDOW_MS[kind], h => HARNESS_LABELS[h]) } : data
    const five = group(rawFive, '5h'), week = group(rawWeek, 'week')
    const peaks = [...topPeaks(rawFive.series, '5h'), ...topPeaks(rawWeek.series, 'week')].sort((a, b) => b.ratePerHour - a.ratePerHour).slice(0, 4)
    const msgs = messageActivity(ss, now)
    const hourlyMessages = new Map<number, { at: number; messages: number }>()
    for (const s of ss) for (const stamp of s.user_message_timestamps ?? []) {
      const at = Date.parse(stamp)
      if (!Number.isFinite(at) || at < now - 14 * 24 * HOUR || at > now) continue
      const hour = Math.floor(at / HOUR) * HOUR
      const row = hourlyMessages.get(hour) ?? { at: hour, messages: 0 }
      row.messages++; hourlyMessages.set(hour, row)
    }
    const missing = (mode === 'harness' && key ? [key] : mode === 'account' ? [] : harnesses).filter(h => !rs.some(r => r.harness === h && r.points.some(p => p.fiveHourPct != null || p.weekPct != null)))
    return { five, week, msgs, peaks, missing, hourly: hourlyUsage(mode === 'harnesses' ? rawFive.series.map(s => ({ ...s, key: s.harness })) : rawFive.series, now - 48 * HOUR, now),
      messageRows: [...hourlyMessages.values()].sort((a, b) => a.at - b.at) }
  }, [readings, sessions, harnesses, mode, key, now]) // eslint-disable-line react-hooks/exhaustive-deps

  const description = (text: string) => <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px', lineHeight: 1.5 }}>{text}</p>
  const heading = (text: string) => <h2 style={{ fontSize: 13, margin: '0 0 6px' }}>{text}</h2>
  const two = { display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: 16 } as const
  const lineChart = (kind: '5h' | 'week', series: typeof view.five.series) => {
    const { rows, keys } = toChartRows(series, WINDOW_MS[kind])
    return rows.length ? <ActivityPercentChart lang={lang} data={rows} step timeRange={kind === '5h' ? [Math.floor((now - 48 * HOUR) / HOUR) * HOUR, now] : undefined} height={mode === 'accounts' ? 150 : 220}
      series={keys.map(k => ({ key: k.key, label: k.label, color: color(k.identity), connectNulls: false }))} /> : description(t.noWindow)
  }
  const pair = (five: typeof view.five.series, week: typeof view.week.series) => <div style={two}>
    <div style={{ minWidth: 0 }}>{heading(t.five)}{description(t.fiveDesc)}{lineChart('5h', five)}</div>
    <div style={{ minWidth: 0 }}>{heading(t.week)}{description(t.weekDesc)}{lineChart('week', week)}</div>
  </div>
  const date = (at: number) => new Date(at).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const hasLimits = view.five.series.length + view.week.series.length > 0

  return <Section title={t.limits} contentStyle={{ minWidth: 0 }}>
    <style>{`.usage-view-tabs [role=tablist] { flex-wrap: wrap; } .usage-view-tabs [role=tab] { flex-basis: 140px !important; } @media (max-width: 767px) { .usage-view-tabs [role=tab] { min-height: 44px !important; } }`}</style>
    <div data-usage-filter style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 16 }}>
      <div style={{ flex: '1 1 600px', minWidth: 0 }}><span className="usage-view-tabs"><SegmentedTabs ariaLabel={t.filter} value={mode} onChange={setMode} equal
        tabs={(['accounts', 'harnesses', 'all', 'harness', 'account'] as const).map(id => ({ id, label: t.modes[id] }))} /></span></div>
      {mode === 'harness' && <div style={{ minWidth: 200 }} data-usage-harness><Select value={key ?? ''}
        onChange={harness => setPicked(p => ({ ...p, harness }))} options={harnesses.map(h => ({ value: h, label: HARNESS_LABELS[h] }))} /></div>}
      {mode === 'account' && <div style={{ minWidth: 200 }}><Select value={key ?? ''} onChange={account => setPicked(p => ({ ...p, account }))} options={accounts} placeholder={t.account} /></div>}
    </div>
    <div style={{ display: 'grid', gap: 24, minWidth: 0 }}>
      <div data-usage-chart="limits">
        {mode === 'harnesses' && description(t.harnessDesc)}
        {mode === 'accounts' ? accounts.map(account => <div key={account.value} data-usage-account={account.value} style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 12 }}>
          <h3 style={{ fontSize: 13, margin: '0 0 12px', color: color(account.value) }}>{account.label}</h3>
          {pair(view.five.series.filter(s => s.key === account.value), view.week.series.filter(s => s.key === account.value))}
        </div>) : pair(view.five.series, view.week.series)}
        {!hasLimits && description(t.none)}
        {view.five.omitted.length > 0 && description(t.omitted(view.five.omitted.join(', ')))}
        {view.missing.map(h => <p key={h} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{HARNESS_LABELS[h as SurfaceHarnessId] ?? h} — {t.noReading}</p>)}
      </div>
      <div data-usage-chart="hours">
        {heading(t.hours)}{description(t.hoursDesc)}
        {view.msgs.total === 0 ? description(t.noMsgs) : <>{heading(t.perDay)}<WeekHourHeatmap cells={view.msgs.cells} lang={lang} /></>}
      </div>
      <div data-usage-chart="peaks">
        {heading(hasLimits ? t.peaks : t.messagePeaks)}{description(hasLimits ? t.peaksDesc : t.messagePeaksDesc)}
        {hasLimits ? <>
          {view.peaks.length === 0 ? description(t.noPeaks) : <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
            {view.peaks.map(p => <p key={`${p.key}:${p.kind}:${p.at}`} style={{ margin: 0, borderLeft: `3px solid ${color(p.key)}`, padding: '10px 12px', fontSize: 13, lineHeight: 1.5, background: 'var(--bg-elevated)', borderRadius: 6 }}>
              <strong style={{ color: color(p.key) }}>{p.label}</strong> — {t.used} {p.rise.toLocaleString(lang, { maximumFractionDigits: 1 })}% {t.of} {p.kind === '5h' ? '5 h' : t.weekly}{lang === 'en' ? ' limit' : ''} {t.in} {Math.round(p.duration / 60_000)} {t.min} · {date(p.at)}
            </p>)}
          </div>}
          {view.five.series.length > 0 && <>{description(t.bars)}<UsageHourlyBars lang={lang} timeRange={[Math.floor((now - 48 * HOUR) / HOUR) * HOUR, now]} data={view.hourly} series={view.five.series.map(s => ({ key: s.key, label: s.label, color: color(s.key) }))} /></>}
        </> : view.messageRows.length ? <>
          {description([...view.messageRows].sort((a, b) => b.messages - a.messages).slice(0, 4).map(row => `${date(row.at)}: ${row.messages} ${t.messages}`).join(' · '))}
          <UsageHourlyBars lang={lang} messages data={view.messageRows} series={[{ key: 'messages', label: t.messages, color: 'var(--anthropic-orange)' }]} />
        </> : description(t.noMsgs)}
      </div>
    </div>
  </Section>
}
