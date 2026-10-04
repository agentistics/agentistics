/**
 * NativeReasoning — B9.1: the model's reasoning in the native chat, apart from its answer. Folded by
 * default once written (it can be long); open while it streams, so the person sees the model working.
 */
import { Brain } from 'lucide-react'

export function NativeReasoning({ text, live, lang }: { text: string; live?: boolean; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  return (
    <details data-testid="native-reasoning" open={live ? true : undefined}
      style={{ alignSelf: 'flex-start', maxWidth: '100%', minWidth: 0, borderLeft: '2px solid var(--border)', padding: '2px 0 2px 10px', color: 'var(--text-tertiary)', fontSize: 12.5 }}>
      <summary style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, userSelect: 'none' }}>
        <Brain size={12} />
        {live ? (pt ? 'Raciocinando…' : 'Thinking…') : (pt ? 'Raciocínio' : 'Reasoning')}
      </summary>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 6, lineHeight: 1.5 }}>{text}</div>
    </details>
  )
}
