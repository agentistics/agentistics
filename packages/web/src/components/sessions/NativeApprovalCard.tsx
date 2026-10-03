/**
 * NativeApprovalCard — a native session's policy ask, or a question the model asked (UI.3). The SAME
 * look as `ApprovalCard` (orange frame, the uppercase header), which is tied to a fleet row's screen
 * scrape; this one is fed by the runtime's own question (`ask` frame): its text, what the call would
 * touch, and its options. Answering is `POST …/tools/:execId/approve` (the hook's). The buttons lock
 * while an answer is in flight, so one question cannot be answered twice.
 */
import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import type { NativeAsk } from '../../lib/nativeChat'
import { isDenyOption, optionLabel } from '../../lib/nativeSession'

export interface NativeApprovalCardProps {
  ask: NativeAsk
  lang: 'pt' | 'en'
  onAnswer: (a: { choice?: number; text?: string }) => Promise<void> | void
}

export function NativeApprovalCard({ ask, lang, onAnswer }: NativeApprovalCardProps) {
  const pt = lang === 'pt'
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const answer = async (a: { choice?: number; text?: string }) => {
    if (busy) return
    setBusy(true)
    try { await onAnswer(a) } finally { setBusy(false) }
  }
  const heading = ask.kind === 'permission'
    ? (pt ? 'Aprovação necessária' : 'Approval needed')
    : (pt ? 'O assistente pergunta' : 'The assistant asks')
  return (
    <div
      data-testid="native-approval"
      role="group"
      aria-label={heading}
      style={{
        display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
        border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)', borderRadius: 14, padding: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--anthropic-orange)' }}>
        <AlertCircle size={13} />
        {heading}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{ask.text}</div>
      {ask.subjects.length > 0 && ask.kind === 'permission' && !ask.text.includes(ask.subjects[0]!) && (
        <pre style={{ margin: 0, padding: 8, borderRadius: 8, background: 'var(--bg-input)', fontSize: 11.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {ask.subjects.join('\n')}
        </pre>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {ask.options.map((o, i) => {
          const deny = isDenyOption(o.label)
          return (
            <button
              key={i}
              type="button"
              disabled={busy}
              title={o.description}
              onClick={() => void answer({ choice: i })}
              style={{
                minHeight: 36, padding: '6px 12px', borderRadius: 9, cursor: busy ? 'default' : 'pointer', fontSize: 12.5, fontFamily: 'inherit',
                border: deny ? '1px solid var(--border)' : 'none',
                background: deny ? 'transparent' : 'var(--anthropic-orange)',
                color: deny ? 'var(--text-primary)' : '#fff',
                opacity: busy ? 0.6 : 1, maxWidth: '100%', textAlign: 'left',
              }}
            >
              {optionLabel(o.label, lang)}
            </button>
          )
        })}
      </div>
      {ask.allowFreeText && (
        <form onSubmit={e => { e.preventDefault(); if (text.trim()) void answer({ text: text.trim() }) }} style={{ display: 'flex', gap: 8 }}>
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            disabled={busy}
            placeholder={pt ? 'Ou responda com suas palavras…' : 'Or answer in your own words…'}
            aria-label={pt ? 'Resposta' : 'Answer'}
            style={{ flex: 1, minWidth: 0, minHeight: 36, padding: '6px 10px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit' }}
          />
          <button type="submit" disabled={busy || !text.trim()} style={{ minHeight: 36, padding: '6px 12px', borderRadius: 9, border: 'none', background: 'var(--anthropic-orange)', color: '#fff', cursor: 'pointer' }}>
            {pt ? 'Responder' : 'Answer'}
          </button>
        </form>
      )}
    </div>
  )
}
