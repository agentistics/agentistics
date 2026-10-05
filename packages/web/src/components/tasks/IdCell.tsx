import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../../lib/clipboard'

/**
 * The optional ID column: a task's or subtask's id (`t-e1dea7cd6f`, `s-b71b2e6f73`) in monospace, one
 * click copies it — through the app's own `copyText`, which also works over plain HTTP. The click never
 * reaches the row (it would expand it / open it): copying an id is its own gesture. A real `<button>`,
 * so the keyboard reaches it; the title says what it does in the board's language.
 */
export function IdCell({ id, lang }: { id: string; lang: 'pt' | 'en' }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const pt = lang === 'pt'
  const label = state === 'ok' ? (pt ? 'Copiado' : 'Copied') : state === 'fail' ? (pt ? 'Não foi possível copiar' : 'Could not copy') : (pt ? `Copiar ${id}` : `Copy ${id}`)
  return (
    <button
      type="button"
      data-id-cell
      title={label}
      aria-label={label}
      onClick={e => {
        e.stopPropagation()
        void copyText(id).then(ok => {
          setState(ok ? 'ok' : 'fail')
          setTimeout(() => setState('idle'), 1500)
        })
      }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5, whiteSpace: 'nowrap',
        color: state === 'ok' ? 'var(--accent-green, #22c55e)' : 'var(--text-secondary)',
      }}
    >
      {id}
      {state === 'ok' ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden style={{ opacity: 0.55 }} />}
    </button>
  )
}
