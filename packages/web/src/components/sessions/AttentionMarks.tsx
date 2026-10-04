/**
 * AttentionMarks — LIVE.2's history lines and recorded-numbers block for the session chat.
 *
 * HISTORY, never a control: whether a card can be answered NOW is the live fleet row's word alone, so
 * nothing here is a button. Wraps at any width (mobile at 390 px: flex-wrap, no fixed widths).
 */
import { attentionLine, recordedFigures, type ChatAttentionMark, type ChatRecorded } from '../../lib/sessionRecorded'

export function AttentionMarkLine({ mark, pt }: { mark: ChatAttentionMark; pt: boolean }) {
  return (
    <p
      role="note"
      data-attention-mark
      style={{
        margin: '2px 0', textAlign: 'center', fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)',
        overflowWrap: 'anywhere',
      }}
    >
      {attentionLine(mark, pt)}
    </p>
  )
}

/** What the journal remembers of a conversation whose transcript is gone: numbers, nothing else (Q3). */
export function RecordedBlock({ recorded, pt }: { recorded: ChatRecorded; pt: boolean }) {
  const dates = [recorded.firstAt, recorded.lastAt].filter((x): x is string => !!x).map(x => new Date(x).toLocaleDateString(pt ? 'pt-BR' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' }))
  return (
    <section
      aria-label={pt ? 'O que o agentistics registrou' : 'What agentistics recorded'}
      data-recorded-metrics
      style={{ margin: '14px 0 0', width: '100%', textAlign: 'left' }}
    >
      <p style={{ margin: '0 0 6px', fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}>
        {pt ? 'O que o agentistics registrou (só números — o texto da conversa não é guardado aqui)' : 'What agentistics recorded (numbers only — the conversation text is not kept here)'}
        {dates.length > 0 ? ` · ${dates.join(' – ')}` : ''}
      </p>
      <dl style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: '6px 18px', justifyContent: 'center', fontSize: 12, color: 'var(--text-secondary)' }}>
        {recordedFigures(recorded, pt).map(f => (
          <div key={f.label} style={{ display: 'flex', gap: 6, minWidth: 0 }}>
            <dt style={{ color: 'var(--text-tertiary)' }}>{f.label}</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
