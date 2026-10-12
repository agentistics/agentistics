/**
 * Header pill shown ONLY while away mode is active — beside the bell, so the person sees at a glance
 * that the fleet believes they are out. Click → confirm → off ("I'm back"). Mobile: icon-only, its 44px projected by `.ag-tap-icon`.
 */
import React, { useState } from 'react'
import { Moon } from 'lucide-react'
import { ConfirmModal } from '../pages/settings/primitives'
import { awayUntilLabel, setAway, useAway } from '../lib/awayMode'
import { useIsMobile } from '../hooks/useIsMobile'

export default function AwayPill({ lang, enabled }: { lang: 'pt' | 'en'; enabled: boolean }) {
  const pt = lang === 'pt'
  const away = useAway()
  const isMobile = useIsMobile()
  const [confirm, setConfirm] = useState(false)
  if (!enabled || !away.active || !away.state) return null
  const until = awayUntilLabel(away.state, lang, Date.now())
  const label = pt ? `Modo ausente ${until}` : `Away ${until}`
  return (
    <>
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() => setConfirm(true)}
        className={isMobile ? 'ag-tap-icon' : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
          height: 32, minWidth: 32,
          justifyContent: 'center', padding: isMobile ? '0 8px' : '0 10px', borderRadius: 8,
          border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)',
          color: 'var(--anthropic-orange)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
          whiteSpace: 'nowrap',
        }}
      >
        <Moon size={14} />
        {!isMobile && <span>{pt ? 'Ausente' : 'Away'} · {until.replace(/^(até|until) /, '')}</span>}
      </button>
      <ConfirmModal
        open={confirm}
        tone="default"
        icon={<Moon size={17} />}
        title={pt ? 'Voltou?' : 'Back?'}
        message={pt
          ? `O modo ausente está ligado ${until}. Desligar faz as próximas sessões voltarem a perguntar a você quando precisarem.`
          : `Away mode is on ${until}. Turning it off lets new sessions ask you again when they need to.`}
        confirmLabel={pt ? 'Desligar — voltei' : "Turn off — I'm back"}
        cancelLabel={pt ? 'Continuar fora' : 'Stay away'}
        onConfirm={() => { setConfirm(false); void setAway({ on: false }) }}
        onCancel={() => setConfirm(false)}
      />
    </>
  )
}
