/**
 * Nay's "Limites" tab — every plan this machine knows: the ones whose harness reported its windows
 * (each window's % used, when it renews — absolute and "in X min" — the last update and the
 * source), and the ones registered in Settings → Billing that have reported nothing yet (named,
 * with NO meters: nothing observed is not nothing used). Same meter as the composer circle and the
 * new-session cards (`PlanLimitMeter.tsx`).
 */
import { HARNESS_LABELS } from '../../lib/harness'
import { usePlanLimits } from '../../lib/planLimits'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { PlanLimitsBlock } from '../PlanLimitMeter'
import { HarnessMark } from '../sessions/HarnessMark'

export function NayLimitsTab({ lang, isMobile }: { lang: 'pt' | 'en'; isMobile: boolean }) {
  const pt = lang === 'pt'
  const { limits, registered, now } = usePlanLimits()
  const card = {
    display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 10,
    border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  } as const
  return (
    <div data-nay-limits style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: isMobile ? '8px 10px' : '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {limits === null ? (
        <AgentisticsLoader size={14} />
      ) : limits.length === 0 && registered.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {pt
            ? 'Nenhum limite de plano observado ainda. O Claude Code informa os limites nas sessões abertas pela web; o Codex, em toda sessão.'
            : 'No plan limits observed yet. Claude Code reports them in sessions started from the web; Codex in every session.'}
        </p>
      ) : (<>
        {limits.map(l => (
          <div key={`${l.harness}:${l.account}`} style={card}>
            <HarnessMark harness={l.harness} size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <PlanLimitsBlock limits={l} now={now} lang={lang} header details forecast />
            </div>
          </div>
        ))}
        {registered.map(r => (
          <div key={r.harness} style={card} data-plan-registered={r.harness}>
            <HarnessMark harness={r.harness} size={18} />
            <div style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
              <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{HARNESS_LABELS[r.harness]}</span>
              {' '}<span style={{ color: 'var(--text-secondary)' }}>{r.plan}</span>
              <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 4 }}>
                {pt ? 'este harness ainda não informou seus limites' : 'this harness has not reported its limits yet'}
              </div>
            </div>
          </div>
        ))}
      </>)}
    </div>
  )
}
