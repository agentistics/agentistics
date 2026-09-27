/**
 * IdleReviewCard — the compact offer that used to be `IdleSessionsBanner`'s full-width strip above
 * the workspace body. There the header's own hanging tabs ("Filtros", the metrics percentage tab)
 * covered its right end, where its buttons were — reported as the buttons being unreachable. It now
 * lives INSIDE the sessions list, right above the "Groups" section, in `SessionsAside.tsx`.
 *
 * Mounting it there — rather than in `SessionsPage.tsx`, which is where the candidates are actually
 * computed (`useIdleSessions`) — is what covers BOTH surfaces the brief asks for with one change:
 * `SessionsAside` is the SAME component for the desktop sidebar (mounted from `App.tsx`) and the
 * mobile "Sessions" tab (mounted from `SessionsPage.tsx` itself), each behind its own `useFleet()`
 * poll. Reading `lib/idleReviewStore.ts` instead of taking props is what lets both mounts show the
 * one true count without either of them running `useIdleSessions` a second time.
 */
import { Moon, X } from 'lucide-react'
import { requestIdleReview } from '../../lib/idleReviewRequest'
import { idleCardText } from '../../lib/idleExecution'
import { dismissIdleReview, snoozeIdleReview, useIdleReviewCard } from '../../lib/idleReviewStore'
import { fmtGB } from '../../hooks/useIdleSessions'

export function IdleReviewCard({ lang, tap }: { lang: 'pt' | 'en'; tap?: number }) {
  const pt = lang === 'pt'
  const { count, freedBytes, visible } = useIdleReviewCard()
  if (!visible) return null

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14,
      padding: '10px 11px', borderRadius: 10,
      background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
        <Moon size={13} style={{ flexShrink: 0, marginTop: 1, color: 'var(--text-tertiary)' }} />
        <span style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--text-secondary)' }}>
          {idleCardText(count, freedBytes !== null ? fmtGB(freedBytes) : null, lang)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={requestIdleReview}
          style={{
            flex: 1, minWidth: 0, minHeight: tap ?? 30, padding: '0 10px',
            borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)',
            color: '#141414', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700,
          }}
        >
          {pt ? 'Revisar' : 'Review'}
        </button>
        <button
          type="button"
          onClick={snoozeIdleReview}
          style={{
            flex: 1, minWidth: 0, minHeight: tap ?? 30, padding: '0 10px',
            borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--border-subtle)', background: 'transparent',
            color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
          }}
        >
          {pt ? 'Adiar 1h' : 'Snooze 1h'}
        </button>
        <button
          type="button"
          onClick={dismissIdleReview}
          aria-label={pt ? 'Dispensar' : 'Dismiss'}
          title={pt ? 'Dispensar' : 'Dismiss'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            width: tap ?? 30, minHeight: tap ?? 30, padding: 0,
            borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--border-subtle)', background: 'transparent',
            color: 'var(--text-tertiary)', fontFamily: 'inherit',
          }}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
