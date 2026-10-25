/**
 * SessionEnding — what the session view shows between pressing "End session" and the session being
 * gone. The twin of `SessionCreating`: the same loader, the same centred column and the same type
 * tokens, so opening and ending read as one pair of states. It REPLACES the conversation (and with
 * it the composer) for exactly as long as the kill is in flight; `SessionEndingGate` puts the
 * conversation back, untouched, if the kill is refused.
 */
import type { ReactNode } from 'react'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { useEnding } from '../../lib/endingSessions'

export function SessionEnding({ lang, label }: { lang: 'pt' | 'en'; label?: string }) {
  const pt = lang === 'pt'
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy
      data-session-ending
      style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <AgentisticsLoader size={56} label={pt ? 'Encerrando' : 'Ending'} style={{ alignSelf: 'center' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 650, color: 'var(--text-primary)' }}>
            {label || (pt ? 'Encerrando…' : 'Ending…')}
          </span>
          <span style={{ fontSize: 12.5, lineHeight: '18px', minHeight: 18, color: 'var(--text-secondary)' }}>
            {pt ? 'Isso leva alguns segundos.' : 'This takes a few seconds.'}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Wraps a session's view. The children stay MOUNTED while ending (hidden, `display: none`), so a
 * refused kill restores the conversation, its draft and its scroll exactly as they were; outside
 * the ending window the wrapper is `display: contents` and changes no layout.
 */
export function SessionEndingGate({ id, lang, label, children }: { id: string; lang: 'pt' | 'en'; label?: string; children: ReactNode }) {
  const ending = useEnding(id)
  return (
    <>
      {ending && <SessionEnding lang={lang} {...(label ? { label } : {})} />}
      <div style={{ display: ending ? 'none' : 'contents' }} {...(ending ? { inert: true } : {})}>{children}</div>
    </>
  )
}
