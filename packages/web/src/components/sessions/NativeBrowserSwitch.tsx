/**
 * NativeBrowserSwitch — B6.4 (D-T7) in the native chat: the gated browser, off by default. On, the
 * model may delegate to a browser agent; every site it opens still asks. Disabled mid-run.
 */
import { useState } from 'react'

export function NativeBrowserSwitch({ on, running, lang, onSet }: { on: boolean; running: boolean; lang: 'pt' | 'en'; onSet: (on: boolean) => Promise<string | null> }) {
  const pt = lang === 'pt'
  const [error, setError] = useState<string | null>(null)
  return (
    <label data-testid="native-browser" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)' }}
      title={pt ? 'Ligado, o modelo pode delegar a um agente de navegador; cada site pergunta antes.' : 'On, the model may delegate to a browser agent; each site asks first.'}>
      <input type="checkbox" checked={on} disabled={running} onChange={async e => setError(await onSet(e.target.checked))}
        aria-label={pt ? 'Navegador nesta sessão' : 'Browser for this session'} />
      <span>{pt ? 'Navegador' : 'Browser'}</span>
      {error && <span role="alert" style={{ color: 'var(--accent-red)' }}>{error}</span>}
    </label>
  )
}
