/**
 * Header pill shown ONLY while away mode is active — beside the bell, so the person sees at a glance
 * that the fleet believes they are out. Click → confirm → off ("I'm back"). Mobile: icon-only, its 44px projected by `.ag-tap-icon`.
 */
import { AwayImpact } from './AwayImpact'
import React, { useState } from 'react'
import { Moon } from 'lucide-react'
import { ConfirmModal } from '../pages/settings/primitives'
import { awayUntilLabel, setAway, useAway } from '../lib/awayMode'
import { useIsMobile } from '../hooks/useIsMobile'
import { SESSION_CHIP_STYLE } from './sessions/RoleChip'

/**
 * How the top-bar pill looks — change this ONE constant to swap it.
 * A: the small outlined chip the session role chip uses, accent coloured, moon + "Ausente".
 * B: icon-only moon button, the same 32px square as the vault and bell beside it, tinted.
 * C: plain "Ausente" text in the bar's quiet type, accent coloured, no box.
 */
export type AwayPillVariant = 'A' | 'B' | 'C'
export const AWAY_PILL_VARIANT: AwayPillVariant = 'A'

export default function AwayPill({ lang, enabled, variant = AWAY_PILL_VARIANT }: { lang: 'pt' | 'en'; enabled: boolean; variant?: AwayPillVariant }) {
  const pt = lang === 'pt'
  const away = useAway()
  const isMobile = useIsMobile()
  const [confirm, setConfirm] = useState(false)
  if (!enabled || !away.active || !away.state) return null
  const until = awayUntilLabel(away.state, lang, Date.now())
  const label = pt ? `Modo ausente ${until} — clique para desligar` : `Away mode ${until} — click to turn off`
  const accent = 'var(--anthropic-orange)'
  const word = pt ? 'Ausente' : 'Away'
  const base = { flexShrink: 0, cursor: 'pointer', fontFamily: 'inherit', background: 'transparent', color: accent } as const
  let style: React.CSSProperties; let content: React.ReactNode
  if (variant === 'B' || isMobile) {
    style = { ...base, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8,
      border: '1px solid var(--border)', background: 'var(--anthropic-orange-dim)' }
    content = <Moon size={14} aria-hidden />
  } else if (variant === 'C') {
    style = { ...base, display: 'inline-flex', alignItems: 'center', border: 'none', padding: '0 2px', fontSize: 11, fontWeight: 600 }
    content = word
  } else {
    style = { ...base, ...SESSION_CHIP_STYLE, color: accent }
    content = <><Moon size={11} aria-hidden />{word}</>
  }
  return (
    <>
      <button type="button" data-testid="away-pill" title={label} aria-label={label}
        onClick={() => setConfirm(true)} className={isMobile ? 'ag-tap-icon' : undefined} style={style}>
        {content}
      </button>
      <ConfirmModal
        open={confirm}
        tone="default"
        icon={<Moon size={17} />}
        title={pt ? 'Voltou?' : 'Back?'}
        message={pt
          ? `O modo ausente está ligado ${until}. Desligar limpa o modo ausente de todas as sessões, inclusive as que já estão abertas.`
          : `Away mode is on ${until}. Turning it off clears away mode for every session, including those already open.`}
        confirmLabel={pt ? 'Desligar — voltei' : "Turn off — I'm back"}
        cancelLabel={pt ? 'Continuar fora' : 'Stay away'}
        onConfirm={() => { setConfirm(false); void setAway({ on: false }) }}
        onCancel={() => setConfirm(false)}
      ><AwayImpact pt={pt} open={confirm} /></ConfirmModal>
    </>
  )
}
