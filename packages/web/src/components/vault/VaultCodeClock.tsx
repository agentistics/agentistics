import { useEffect, useState } from 'react'
import { Clock3 } from 'lucide-react'
import { codeCountdownText } from '../../lib/vaultCountdown'
import { useVaultWatch } from '../../lib/vaultWatch'

/** Re-render on a slow tick (the text has minute granularity): every 20 s while mounted. */
export function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => setNow(Date.now()), 20_000)
    return () => clearInterval(t)
  }, [enabled])
  return now
}

/** The countdown sentence for this page, live, or null when no window is running. */
export function useCodeCountdown(lang: 'pt' | 'en', enabled = true): string | null {
  const ends = useVaultWatch(enabled).codeWindowEndsAt
  const now = useMinuteClock(enabled && ends !== null)
  return enabled ? codeCountdownText(ends, now, lang) : null
}

/**
 * VAULT.UX-R2 — a small clock: "Código do autenticador pedido de novo em 5 h 12 min". The app's muted
 * caption style (12px, tertiary text), a 13px lucide clock in front. Draws NOTHING when no window runs
 * (always / Hello-only, or the code is already owed) — never a `0 min`.
 */
export function VaultCodeClock({ lang, center, style }: { lang: 'pt' | 'en'; center?: boolean; style?: React.CSSProperties }) {
  const text = useCodeCountdown(lang)
  if (!text) return null
  return (
    <div data-vault-code-clock role="note" style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: 1.4, color: 'var(--text-tertiary)',
      justifyContent: center ? 'center' : 'flex-start', ...style,
    }}>
      <Clock3 size={13} aria-hidden style={{ flexShrink: 0 }} />
      <span>{text}</span>
    </div>
  )
}
