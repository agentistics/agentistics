import { Users } from 'lucide-react'
import { canSwitch, type SwitchInfo } from '../lib/accountSwitch'
import { unavailableReason } from '../lib/accountPicker'
import { useIsMobile } from '../hooks/useIsMobile'
import { dialogButtonStyle } from '../pages/settings/primitives'

/** The shell's selected session and the same account names used by the usage list. */
export interface PlanUsageSession {
  id: string
  title: string
  accountLabel: string
  info: SwitchInfo | null
  onSwitch: () => void
}

export function PlanUsageSessionSwitch({ session, lang }: { session?: PlanUsageSession; lang: 'pt' | 'en' }) {
  const isMobile = useIsMobile()
  if (!session) return null
  const pt = lang === 'pt'
  return (
    <div data-plan-usage-session style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', flexShrink: 0, minWidth: 0 }}>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
        {pt ? 'Sessão aberta: ' : 'Open session: '}{session.title} · {pt ? 'conta ' : 'account '}{session.accountLabel}
      </p>
      {canSwitch(session.info)
        ? <button type="button" data-plan-usage-switch onClick={session.onSwitch}
            style={{ ...dialogButtonStyle('secondary', isMobile), width: '100%', gap: 8 }}>
            <Users size={15} style={{ flexShrink: 0 }} />{pt ? 'Trocar conta da sessão aberta' : "Switch the open session's account"}
          </button>
        : <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>
            {session.info === null ? (pt ? 'Verificando contas…' : 'Checking accounts…')
              : unavailableReason(session.info.unavailable?.[0]?.reason ?? 'unavailable', lang)}
          </p>}
    </div>
  )
}
