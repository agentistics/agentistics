/**
 * ShellCloseStatus — what the Shell's X is doing, in words (`lib/shellClose.ts`).
 *
 * While the close is in flight: a small indeterminate progress bar and "Encerrando o processo deste
 * terminal…". Then ONE sentence saying what happened — ended, already gone, or failed and still
 * running — for `CLOSE_RESULT_MS`, and then nothing. `role="status"` so a screen reader hears each
 * step without the focus moving. Renders `null` when there is nothing to say, so a bar that holds it
 * spends no width on it the rest of the time.
 */

import { useEffect, useState } from 'react'
import { CLOSE_RESULT_MS, closeFlowVisible, shellCloseText, useShellClose } from '../../lib/shellClose'

export function ShellCloseStatus({ sessionId, lang }: { sessionId: string | null | undefined; lang: 'pt' | 'en' }) {
  const { flow } = useShellClose(sessionId)
  const [now, setNow] = useState(() => Date.now())
  // Re-render once the result has been up long enough to go away.
  useEffect(() => {
    if (flow.phase !== 'done') return
    setNow(Date.now())
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, CLOSE_RESULT_MS - (Date.now() - flow.at)) + 20)
    return () => clearTimeout(t)
  }, [flow])
  const text = shellCloseText(flow, lang)
  const visible = closeFlowVisible(flow, flow.phase === 'done' ? now : Date.now())
  if (!visible || text === null) return null
  const failed = flow.phase === 'done' && flow.outcome === 'failed'
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1,
        fontSize: 11, color: failed ? 'var(--accent-red)' : 'var(--text-secondary)',
      }}
    >
      {flow.phase === 'closing' && (
        <span
          aria-hidden="true"
          style={{
            position: 'relative', flexShrink: 0, width: 56, height: 4, borderRadius: 2, overflow: 'hidden',
            background: 'var(--border)',
          }}
        >
          <span className="ag-close-progress" style={{
            position: 'absolute', top: 0, bottom: 0, width: '40%', borderRadius: 2,
            background: 'var(--anthropic-orange)',
          }} />
        </span>
      )}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
    </div>
  )
}
