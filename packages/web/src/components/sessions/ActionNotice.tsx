import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { dialogButtonStyle } from '../../pages/settings/primitives'

/** Keep operational diagnostics available without letting them take over the conversation list. */
export function actionNoticeSummary(message: string, lang: string): string {
  const pt = lang === 'pt'
  if (/mem[oó]ria|memory/i.test(message) && /fila|queue/i.test(message)) {
    return pt ? 'Sem memória livre. A sessão está na fila e começa quando houver espaço.'
      : 'No free memory. The session is queued and starts when space is available.'
  }
  if (/nenhuma conversa|no conversation|no transcript/i.test(message)) {
    return pt ? 'Esta sessão ainda não tem conversa para reabrir.' : 'This session has no conversation to reopen yet.'
  }
  if (message.length <= 100 && !/\bpid\b|agentop|[\r\n]|`/i.test(message)) return message
  return pt ? 'A ação tem uma atualização. Abra os detalhes para saber mais.' : 'There is an update to this action. Open the details to learn more.'
}

/** How long a short confirmation ("Maestro encerrada.") stays on screen. */
export const NOTICE_MS = 2000

/**
 * One tiny confirmation — "<session> encerrada." — or a diagnostic with a "Details" disclosure.
 *
 * A SHORT message (nothing hidden behind Details) is a TRANSIENT toast: it appears at the BOTTOM of
 * the screen (above the phone's bottom bar), stays at most `NOTICE_MS`, and a thin bar along its
 * foot shrinks to zero over exactly that time. Hovering or focusing it pauses the clock (the bar
 * stops with it); the X closes it early. A message that carries Details is a diagnostic somebody
 * may need to read and copy, so it stays where it was — inline, until dismissed.
 */
export function ActionNotice({ message, lang, onDismiss }: { message: string; lang: string; onDismiss: () => void }) {
  const summary = actionNoticeSummary(message, lang)
  const transient = summary === message
  const [paused, setPaused] = useState(false)
  // What is left of the 2 s, carried across pauses so hovering does not restart the full wait.
  const left = useRef(NOTICE_MS)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => { left.current = NOTICE_MS }, [message])
  useEffect(() => {
    if (!transient || paused) return
    const startedAt = Date.now()
    const timer = setTimeout(() => dismiss.current(), left.current)
    return () => { clearTimeout(timer); left.current = Math.max(0, left.current - (Date.now() - startedAt)) }
  }, [transient, paused, message])

  const body = (
    <div data-action-notice data-transient={transient || undefined} className={transient ? 'ag-action-toast' : undefined}
      {...(transient ? {
        onMouseEnter: () => setPaused(true), onMouseLeave: () => setPaused(false),
        onFocus: () => setPaused(true), onBlur: () => setPaused(false),
      } : {})}
      style={{ flexShrink: 0, minWidth: 0, padding: '6px 8px', borderRadius: 6,
        display: 'flex', flexDirection: 'column', gap: 6,
        background: 'var(--bg-card)', color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.45,
        ...(transient ? { fontSize: 12.5, padding: '10px 12px 12px' } : {}) }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span role="status" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{summary}</span>
        <button type="button" aria-label={lang === 'pt' ? 'Fechar aviso' : 'Dismiss notice'} onClick={onDismiss}
          className="ag-tap-icon" style={{ ...dialogButtonStyle('secondary', false), padding: 3, minHeight: 22, flexShrink: 0 }}><X size={13} /></button>
      </div>
      {summary !== message && <details style={{ minWidth: 0 }}><summary style={{ cursor: 'pointer' }}>{lang === 'pt' ? 'Detalhes' : 'Details'}</summary>
        <div role="region" aria-label={lang === 'pt' ? 'Detalhes do aviso' : 'Notice details'} tabIndex={0}
          style={{ maxHeight: 'min(180px, calc(20dvh / var(--ui-zoom, 1)))', overflowY: 'scroll', scrollbarGutter: 'stable',
            border: '1px solid var(--border-subtle)', borderRadius: 4, padding: 6, marginTop: 4,
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message}</div>
      </details>}
      {transient && (
        <span data-notice-progress aria-hidden="true" key={message}
          style={{ position: 'absolute', left: 0, bottom: 0, height: 3, width: '100%', background: 'var(--anthropic-orange)',
            transformOrigin: 'left center', animation: `ag-notice-shrink ${NOTICE_MS}ms linear forwards`,
            animationPlayState: paused ? 'paused' : 'running' }} />
      )}
    </div>
  )
  // A transient toast lives on <body> so no ancestor's overflow, transform or stacking context can
  // clip it or move it off the bottom edge; the server-side render (tests, no DOM) draws it inline.
  return transient && typeof document !== 'undefined' ? createPortal(body, document.body) : body
}
