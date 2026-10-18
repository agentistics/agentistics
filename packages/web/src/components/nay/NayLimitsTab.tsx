/**
 * Nay's "Limites" tab — every plan this machine knows: the ones whose harness reported its windows
 * (each window's % used, when it renews — absolute and "in X min" — the last update and the
 * source), and the ones registered in Settings → Billing that have reported nothing yet (named,
 * with NO meters: nothing observed is not nothing used). Same meter as the composer circle and the
 * new-session cards (`PlanLimitMeter.tsx`).
 */
import { useNavigate } from 'react-router-dom'
import { subscriptionRows, usePlanLimits, fmtSpan } from '../../lib/planLimits'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { PlanUsageCard } from '../PlanLimitMeter'

export function NayLimitsTab({ lang, isMobile, onNavigate, embedded = false }: { lang: 'pt' | 'en'; isMobile: boolean; onNavigate?: () => void; embedded?: boolean }) {
  const pt = lang === 'pt'
  const navigate = useNavigate()
  const { limits, registered, accountLabels, now } = usePlanLimits()
  const rows = subscriptionRows(limits, registered, accountLabels)
  const newest = Math.max(0, ...(limits ?? []).map(l => l.updatedAt))
  return (
    <div data-nay-limits style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: embedded ? 0 : isMobile ? '8px 10px' : '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {limits === null ? (
        <AgentisticsLoader size={14} />
      ) : rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {pt
            ? 'Nenhum limite de plano observado ainda. O Claude Code informa os limites nas sessões abertas pela web; o Codex, em toda sessão.'
            : 'No plan limits observed yet. Claude Code reports them in sessions started from the web; Codex in every session.'}
        </p>
      ) : (<>
        {rows.map(r => r.limits
          ? <PlanUsageCard key={`${r.harness}:${r.limits.account}`} limits={r.limits} accountLabel={r.accountLabel} now={now} lang={lang} />
          : <PlanUsageCard key={`${r.harness}:${r.plan}`} limits={null} accountLabel={r.accountLabel} pending={{ harness: r.harness, plan: r.plan ?? '' }} now={now} lang={lang} />)}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-tertiary)', padding: '2px 2px 0' }}>
          {newest > 0 && <span>{pt ? `Atualizado há ${fmtSpan(Math.max(0, now - newest), lang)}` : `Updated ${fmtSpan(Math.max(0, now - newest), lang)} ago`}</span>}
          {newest > 0 && <span aria-hidden>·</span>}
          <button type="button" onClick={() => { onNavigate?.(); navigate('/settings/billing') }} style={{ border: 0, background: 'transparent', padding: 0, font: 'inherit', color: 'var(--anthropic-orange)', cursor: 'pointer' }}>{pt ? 'Gerenciar planos' : 'Manage plans'}</button>
        </div>
      </>)}
    </div>
  )
}
