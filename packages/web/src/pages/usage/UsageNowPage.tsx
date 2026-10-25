import { surfaceHarnesses, SURFACE_HARNESS_ORDER } from '@agentistics/core' // @native-gated: subscription card ordering only.
import { useNavigate, useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PageHeader } from '../../components/nav/PageHeader'
import { Section } from '../../components/Section'
import { StatTile } from '../../components/StatTile'
import { Pill } from '../../components/Pill'
import { PlanUsageCard } from '../../components/PlanLimitMeter'
import { HARNESS_LABELS } from '../../lib/harness'
import { fmtSpan, fmtWhen, usePlanLimits } from '../../lib/planLimits'
import { hasMeasuredPace, usageHeadline, usagePaceState } from '../../lib/usagePlan'
import { dialogButtonStyle } from '../settings/primitives'
import { UsageCharts } from './UsageCharts'
import { accountKey, accountLabel, orderedBudgets, unmeasured, type Lang } from './usageView'

export default function UsageNowPage() {
  const { lang } = useOutletContext<AppContext>()
  return <UsageNowContent lang={lang} />
}

/** Also rendered by fixture tests without mounting the application shell. */
export function UsageNowContent({ lang }: { lang: Lang }) {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const { budgets, limits, registered, readings, now } = usePlanLimits()
  const pt = lang === 'pt'
  const rows = orderedBudgets(budgets)
  // Native calls use provider billing, not a subscription plan; keep the registry's surface order.
  const noPlan = surfaceHarnesses(false).filter(h => !registered.some(r => r.harness === h) && !budgets.some(r => r.harness === h && r.plan) && !limits?.some(r => r.harness === h && r.plan))
  const pending = registered.filter(r => !budgets.some(b => b.harness === r.harness && (b.account ?? 'default') === (r.account ?? 'default')))
  const cards = [...rows, ...pending.map(r => ({ ...r, accountLabel: r.accountLabel ?? HARNESS_LABELS[r.harness] }))].sort((a, b) => SURFACE_HARNESS_ORDER.indexOf(a.harness) - SURFACE_HARNESS_ORDER.indexOf(b.harness) || accountLabel(a).localeCompare(accountLabel(b))) // @native-gated: ordering rows from the subscription store.
  // Share header, meter and metric rows across each pair; forecast wrapping cannot shift tiles.
  const cardRows = { display: 'grid', gridTemplateRows: 'subgrid', gridRow: 'span 3', minWidth: 0 } as const
  const contentRows = { display: 'grid', gridTemplateRows: 'subgrid', gridRow: 'span 2' } as const
  return <div style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="usage" pageId="now" isMobile={isMobile} status={usageHeadline(rows, now, lang) ?? undefined} actions={[
      { label: pt ? 'Ajustar limites' : 'Adjust limits', onClick: () => navigate('/usage/limits') },
      { label: pt ? 'Planejar sessões' : 'Plan sessions', onClick: () => navigate('/usage/plan') },
    ]} />
    {!rows.length && !pending.length && <p style={{ color: 'var(--text-secondary)' }}>{pt ? 'Nenhum plano com leitura de uso ainda.' : 'No plans with usage readings yet.'}</p>}
    <div className="ag-grid cols-2" style={{ marginBottom: 20, ...(isMobile ? { gridTemplateColumns: 'minmax(0, 1fr)' } : {}) }}>
      {cards.map(row => {
        if (!('paceStatus' in row)) return <div key={accountKey(row)} data-usage-account={accountKey(row)} style={cardRows}><Section title={row.plan} style={cardRows} contentStyle={contentRows}>
          <PlanUsageCard embedded showPlan={false} limits={limits?.find(l => l.harness === row.harness && l.account === (row.account ?? 'default')) ?? null} pending={row} accountLabel={row.accountLabel} now={now} lang={lang} />
        </Section></div>
        const limitsForAccount = limits?.find(l => l.harness === row.harness && l.account === (row.account ?? 'default')) ?? null
        const pace = usagePaceState(row)
        const hold = pace === 'hold'
        const over = pace === 'over'
        const under = pace === 'under'
        const measured = hasMeasuredPace(row)
        return <div key={accountKey(row)} data-usage-account={accountKey(row)} style={{ ...cardRows, overflowWrap: 'anywhere' }}>
          <Section title={row.plan} style={cardRows} contentStyle={contentRows} action={<Pill tone={hold ? 'error' : over ? 'warn' : 'ok'}>{hold ? (pt ? 'Em pausa' : 'On hold') : over ? (pt ? 'Acima do ritmo' : 'Over pace') : under ? (pt ? 'Abaixo do ritmo' : 'Under pace') : (pt ? 'No ritmo' : 'On pace')}</Pill>}>
            <PlanUsageCard embedded showPlan={false} limits={limitsForAccount} pending={{ harness: row.harness, plan: row.plan }} accountLabel={accountLabel(row)} now={now} lang={lang} />
            <div data-usage-metrics style={{ alignSelf: 'start', minWidth: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 12 }}>
                {measured && <StatTile label={pt ? 'Em paralelo / recomendado' : 'Parallel / recommended'} value={`${row.liveSessions.length} / ${row.suggestedParallel}`} />}
                <StatTile label={pt ? 'Pausar até' : 'Pause until'} value={row.pauseUntil !== undefined && row.pauseUntil > now ? fmtWhen(row.pauseUntil, now, lang) : (hold || over ? (pt ? 'Sem horário' : 'No time set') : (pt ? 'Sem pausa' : 'No pause'))} />
                {limitsForAccount?.windows.some(w => w.kind === 'week') && row.weekResetsAt > now && <StatTile label={pt ? 'Semana: esperado' : 'Week: expected'} value={`${Math.max(0, Math.min(100, (1 - (row.weekResetsAt - now) / (7 * 24 * 3_600_000)) * 100)).toFixed(1)}%`} />}
                {row.weekResetsAt > now && <StatTile label={pt ? 'Renova em' : 'Renews in'} value={fmtSpan(row.weekResetsAt - now, lang)} />}
              </div>
              {!measured && <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{unmeasured(lang)}</p>}
            </div>
          </Section>
        </div>
      })}
    </div>
    <Section title={pt ? 'Semana: esperado × real' : 'Week: expected × actual'}>
      <UsageCharts budgets={rows} readings={readings} limits={limits} lang={lang} />
    </Section>
    {(noPlan.length > 0 || !cards.length) && <div style={{ marginTop: 20 }}>
      <Section title={pt ? 'Sem plano registrado' : 'No registered plan'} action={<button type="button" style={dialogButtonStyle('secondary', isMobile)} onClick={() => navigate('/settings/billing')}>{pt ? 'Registrar plano' : 'Register plan'}</button>}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{noPlan.map(h => <Pill key={h} tone="muted">{HARNESS_LABELS[h]}</Pill>)}</div>
      </Section>
    </div>}
  </div>
}
