/**
 * Header pill shown ONLY while away mode is active — beside the bell, so the person sees at a glance
 * that the fleet believes they are out. Click → Leadership → Away mode. Mobile: icon-only, its 44px projected by `.ag-tap-icon`.
 */
import React from 'react'
import { Link } from 'react-router-dom'
import { Moon } from 'lucide-react'
import { awayUntilLabel, useAway } from '../lib/awayMode'
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
  if (!enabled || !away.active || !away.state) return null
  const until = awayUntilLabel(away.state, lang, Date.now())
  const label = pt ? `Modo ausente ${until} — abrir modo ausente` : `Away mode ${until} — open away mode`
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
    <Link to="/leadership/away" data-testid="away-pill" title={label} aria-label={label}
      className={isMobile ? 'ag-tap-icon' : undefined} style={{ ...style, textDecoration: 'none' }}>
      {content}
    </Link>
  )
}
