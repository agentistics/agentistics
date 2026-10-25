/**
 * The session panel's "Usage limits" body — the plan-usage list plus the switch right where the
 * limits are (CONTA.LIMITES). ONE component for both homes: the phone drawer's section and the
 * desktop side panel's Metrics tab, so the two can never disagree about what the card holds.
 */
import { usePlanLimits } from '../../lib/planLimits'
import { PlanUsageSummary } from '../PlanLimitMeter'
import { AccountSwitchInline } from './AccountSwitch'

export function SessionLimitsCard({ sessionId, lang, onSwitched, onOpenAll }: {
  sessionId: string
  lang: 'pt' | 'en'
  onSwitched: (newId: string) => void
  /** Opens the full "Plan usage" modal. */
  onOpenAll: () => void
}) {
  const plan = usePlanLimits()
  return (
    <AccountSwitchInline sessionId={sessionId} lang={lang} onSwitched={onSwitched}>
      <button
        type="button"
        onClick={onOpenAll}
        aria-label={lang === 'pt' ? 'Ver todos os limites' : 'See every limit'}
        style={{ all: 'unset', boxSizing: 'border-box', display: 'block', width: '100%', cursor: 'pointer' }}
      >
        <PlanUsageSummary limits={plan.limits} registered={plan.registered} accountLabels={plan.accountLabels} now={plan.now} lang={lang} embedded />
      </button>
    </AccountSwitchInline>
  )
}
