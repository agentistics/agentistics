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

export function ActionNotice({ message, lang, onDismiss }: { message: string; lang: string; onDismiss: () => void }) {
  const summary = actionNoticeSummary(message, lang)
  return <div data-action-notice style={{ flexShrink: 0, minWidth: 0, padding: '6px 8px', borderRadius: 6,
    // The disclosure's 2px focus outline + 2px offset must clear the last line of feedback.
    display: 'flex', flexDirection: 'column', gap: 6,
    background: 'var(--bg-card)', color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.45 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <span role="status" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{summary}</span>
      <button type="button" aria-label={lang === 'pt' ? 'Fechar aviso' : 'Dismiss notice'} onClick={onDismiss}
        className="ag-tap-icon" style={{ ...dialogButtonStyle('secondary', false), padding: 3, minHeight: 22, flexShrink: 0 }}><X size={13} /></button>
    </div>
    {summary !== message && <details style={{ minWidth: 0 }}><summary style={{ cursor: 'pointer' }}>{lang === 'pt' ? 'Detalhes' : 'Details'}</summary>
      <div role="region" aria-label={lang === 'pt' ? 'Detalhes do aviso' : 'Notice details'} tabIndex={0}
        style={{ maxHeight: 'min(180px, 20dvh)', overflowY: 'scroll', scrollbarGutter: 'stable',
          border: '1px solid var(--border-subtle)', borderRadius: 4, padding: 6, marginTop: 4,
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message}</div>
    </details>}
  </div>
}
