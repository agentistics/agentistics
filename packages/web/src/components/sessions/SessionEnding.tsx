/**
 * SessionEnding — what the session view shows between pressing "End session" and the session being
 * gone. The twin of `SessionCreating`: the same loader, the same centred column and the same type
 * tokens, so opening and ending read as one pair of states. It REPLACES the conversation (and with
 * it the composer) for at least 800 ms and until the session leaves Active; `SessionEndingGate` puts the
 * conversation back, untouched, if the kill is refused.
 */
import { useEffect, type ReactNode } from 'react'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { endingLabel, endingTimeoutText, unmarkEnding, useEnding, useEndingTimedOut } from '../../lib/endingSessions'

export function SessionEnding({ lang, label, title, id, onRetry }: { lang: 'pt' | 'en'; label?: string; title?: string; id?: string; onRetry?: () => void }) {
  const pt = lang === 'pt'
  const timedOut = useEndingTimedOut(id)
  const t = endingTimeoutText(pt)
  const btn = { fontSize: 12.5, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' } as const
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={!timedOut}
      data-session-ending
      {...(timedOut ? { 'data-session-ending-timeout': '' } : {})}
      style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 14 }}>
        {!timedOut && <AgentisticsLoader size={56} label={endingLabel(pt)} />}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 650, color: 'var(--text-primary)' }}>
            {timedOut ? t.title : label || endingLabel(pt)}
          </span>
          <span style={{ fontSize: 12.5, lineHeight: '18px', minHeight: 18, color: 'var(--text-secondary)' }}>
            {timedOut ? t.body : title || (pt ? 'Isso leva alguns segundos.' : 'This takes a few seconds.')}
          </span>
        </div>
        {timedOut && (
          <div style={{ display: 'flex', gap: 8 }}>
            {onRetry && <button type="button" data-ending-retry style={btn} onClick={() => { if (id) unmarkEnding(id); onRetry() }}>{t.retry}</button>}
            <button type="button" data-ending-dismiss style={btn} onClick={() => { if (id) unmarkEnding(id) }}>{t.dismiss}</button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Wraps a session's view. The children stay MOUNTED while ending (hidden, `display: none`), so a
 * refused kill restores the conversation, its draft and its scroll exactly as they were; outside
 * the ending window the wrapper is `display: contents` and changes no layout.
 */
export function SessionEndingGate({ id, lang, label, title, ending: heldEnding, onRetry, children }: { ending?: boolean; onRetry?: () => void; id: string; lang: 'pt' | 'en'; label?: string; title?: string; children: ReactNode }) {
  useEffect(() => () => unmarkEnding(id), [id])
  const pending = useEnding(id)
  const ending = heldEnding ?? pending
  return (
    <>
      {ending && <SessionEnding id={id} lang={lang} {...(onRetry ? { onRetry } : {})} {...(label ? { label } : {})} {...(title ? { title } : {})} />}
      <div style={{ display: ending ? 'none' : 'contents' }} {...(ending ? { inert: true } : {})}>{children}</div>
    </>
  )
}
