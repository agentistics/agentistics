/**
 * ToolCallCard — one tool call of a NATIVE session (UI.3): what was called, on what, how it went, and
 * — folded — what it returned. The fleet chat has no such card (an external harness's tool calls are
 * only a status line, `WorkingNote`); a native session's calls are events the runtime emits, so they
 * are drawn. Status and facts from the events, input and output from the persisted window
 * (`lib/nativeChat.ts`). The output is a native `<details>`: folded by default, keyboard-reachable,
 * and it scrolls inside itself so a long log never widens the page (390 px).
 */
import { Ban, Check, Clock, Loader, Square, Wrench, X } from 'lucide-react'
import type { ToolCard } from '../../lib/nativeChat'
import { formatDuration } from '../../lib/nativeSession'

const STATUS: Record<ToolCard['status'], { pt: string; en: string; color: string }> = {
  running: { pt: 'executando', en: 'running', color: 'var(--text-secondary)' },
  awaiting: { pt: 'aguardando aprovação', en: 'awaiting approval', color: 'var(--anthropic-orange)' },
  completed: { pt: 'concluída', en: 'done', color: 'var(--accent-green)' },
  failed: { pt: 'falhou', en: 'failed', color: 'var(--accent-red)' },
  denied: { pt: 'negada', en: 'denied', color: 'var(--accent-red)' },
  cancelled: { pt: 'não executada', en: 'not run', color: 'var(--text-tertiary)' },
}

function StatusIcon({ status }: { status: ToolCard['status'] }) {
  const color = STATUS[status].color
  const p = { size: 13, style: { color, flexShrink: 0 } }
  if (status === 'running') return <Loader {...p} className="ag-working-spin" />
  if (status === 'awaiting') return <Clock {...p} />
  if (status === 'completed') return <Check {...p} />
  if (status === 'failed') return <X {...p} />
  if (status === 'denied') return <Ban {...p} />
  return <Square {...p} />
}

export function ToolCallCard({ card, lang }: { card: ToolCard; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const st = STATUS[card.status]
  const meta = [
    pt ? st.pt : st.en,
    ...(card.exitCode !== undefined ? [`exit ${card.exitCode}`] : []),
    ...(card.durationMs !== undefined ? [formatDuration(card.durationMs)] : []),
  ].join(' · ')
  return (
    <div
      data-testid="tool-card"
      data-status={card.status}
      style={{
        display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, maxWidth: '100%',
        border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '8px 10px',
        background: 'var(--bg-elevated)', fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <Wrench size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <span style={{ fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>{card.name}</span>
        {card.detail && (
          <code style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: 11.5 }}>
            {card.detail}
          </code>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, color: st.color, flexShrink: 0, fontSize: 11 }}>
          <StatusIcon status={card.status} />
          {meta}
        </span>
      </div>
      {card.result !== undefined && card.result !== '' && (
        <details>
          <summary style={{ cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 11 }}>
            {card.isError ? (pt ? 'Ver o erro' : 'Show the error') : (pt ? 'Ver o resultado' : 'Show the output')}
          </summary>
          <pre style={{
            margin: '6px 0 0', padding: 8, borderRadius: 8, background: 'var(--bg-input)', maxHeight: 260, overflow: 'auto',
            fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre', color: card.isError ? 'var(--accent-red)' : 'var(--text-secondary)',
          }}>{card.result}</pre>
        </details>
      )}
    </div>
  )
}
