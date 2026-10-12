/**
 * AwayChip — "this session is in away mode on its own" (`ControlSession.away`), worn beside the
 * session's title in the header. The same outlined shape `RoleChip` uses (`SESSION_CHIP_STYLE`), in
 * the away accent the header's global `AwayPill` wears. Absent when the session's own flag is off —
 * the global switch already has its pill.
 */
import { Moon } from 'lucide-react'
import { SESSION_CHIP_STYLE } from './RoleChip'

export function AwayChip({ pt, compact = false }: { pt: boolean; compact?: boolean }) {
  const label = pt ? 'Ausente' : 'Away'
  return (
    <span data-testid="session-away-chip" title={pt ? 'Modo ausente nesta sessão' : 'Away mode on this session'}
      aria-label={pt ? 'Modo ausente nesta sessão' : 'Away mode on this session'}
      style={{ ...SESSION_CHIP_STYLE, color: 'var(--anthropic-orange)', alignSelf: 'center' }}>
      <Moon size={11} aria-hidden />{!compact && label}
    </span>
  )
}
