/**
 * IdleSessionsBanner — the slim, always-visible offer sitting above the workspace once
 * `bannerVisible()` (`lib/idleExecution.ts`) says there is something worth reviewing.
 *
 * Snoozing is OWNED here: the write to `sessionStorage['agentistics-idle-snooze']` happens inside
 * this component's own click handler, guarded by try/catch like every other `sessionStorage` touch
 * in this workspace (a private tab, or the accessor thrown, must not crash the page). `onSnooze`
 * still fires, carrying the exact timestamp written, so the page that owns `snoozedUntil` state can
 * hide the banner on this render rather than waiting for a poll or a manual re-read of storage.
 */
import { useIsMobile } from '../../hooks/useIsMobile'
import { idleBannerText } from '../../lib/idleExecution'

const SNOOZE_KEY = 'agentistics-idle-snooze'
const SNOOZE_MS = 3_600_000

export interface IdleSessionsBannerProps {
  lang: 'pt' | 'en'
  count: number
  onReview: () => void
  onSnooze: (until: number) => void
}

export function IdleSessionsBanner({ lang, count, onReview, onSnooze }: IdleSessionsBannerProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const tap = isMobile ? 44 : 30

  function snooze(): void {
    const until = Date.now() + SNOOZE_MS
    try { sessionStorage.setItem(SNOOZE_KEY, String(until)) } catch { /* private tab, quota, disabled */ }
    onSnooze(until)
  }

  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0,
        padding: '8px 16px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-secondary)' }}>
        {idleBannerText(count, lang)}
      </span>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          onClick={snooze}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minHeight: tap, padding: '0 12px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          {pt ? 'Adiar 1h' : 'Snooze 1h'}
        </button>
        <button
          type="button"
          onClick={onReview}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minHeight: tap, padding: '0 14px', borderRadius: 8,
            border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)',
            color: '#fff', fontSize: 12.5, fontWeight: 700,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          {pt ? 'Revisar' : 'Review'}
        </button>
      </div>
    </div>
  )
}
