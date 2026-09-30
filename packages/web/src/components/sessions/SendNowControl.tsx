/**
 * SendNowControl — the "Send now" pill under the queued messages, and what it turns into once
 * pressed: a small PROGRESS BAR with a live caption, then one sentence saying what really happened.
 *
 * It is never a silent spinner. The server drives the pane in two steps (claude's own send-now,
 * then an interrupt if that did not drain the queue — see `@agentistics/core`'s `sendNow.ts`) and can
 * take several seconds; the caption follows the server's own clock, so "interrupting" is said when
 * the server starts to interrupt, and the answer is the server's sentence, read off the screen.
 *
 * The RESULT outlives the button: a successful send retires the queued bubble, which is what hides
 * the button, and a sentence that vanished with it would be the silence this replaces.
 */
import { useEffect, useState } from 'react'
import { Send, X } from 'lucide-react'
import { sendNowProgress } from '@agentistics/core'
import { sendNowHint, sendNowLabel } from '../../lib/promptHistory'

export type SendNowRun =
  | { kind: 'running'; startedAt: number }
  | { kind: 'done'; ok: boolean; message: string }

interface Props {
  /** Offer the pill (claude working with something queued, no dialog open). */
  offered: boolean
  count: number
  run: SendNowRun | null
  pt: boolean
  onSend: () => void
  onDismiss: () => void
}

const TICK_MS = 120

export function SendNowControl({ offered, count, run, pt, onSend, onDismiss }: Props) {
  const [now, setNow] = useState(() => Date.now())
  const running = run?.kind === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [running])

  if (!offered && run === null) return null

  const box: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6,
  }

  if (run?.kind === 'running') {
    const p = sendNowProgress(now - run.startedAt, pt)
    const pct = Math.round(p.fraction * 100)
    return (
      <div style={box} data-testid="send-now-progress">
        <div style={{ width: 'min(320px, 100%)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div
            role="progressbar"
            aria-label={pt ? 'Enviando agora' : 'Sending now'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            style={{
              height: 4, borderRadius: 999, overflow: 'hidden',
              background: 'color-mix(in srgb, var(--anthropic-orange) 18%, transparent)',
            }}
          >
            <div style={{
              width: `${pct}%`, height: '100%', borderRadius: 999,
              background: 'var(--anthropic-orange)',
              transition: `width ${TICK_MS}ms linear`,
            }} />
          </div>
          <div aria-live="polite" style={{ fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'right' }}>
            {p.caption}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={box}>
      {offered && (
        <button
          onClick={onSend}
          // A pill keeps its natural height; `.ag-tap` projects the 44px touch target around it on a
          // phone instead of painting it (see index.css).
          className="ag-tap"
          title={sendNowHint(count, pt)}
          aria-label={sendNowHint(count, pt)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            minHeight: 28, padding: '0 12px',
            borderRadius: 999, border: '1px solid var(--anthropic-orange)',
            background: 'transparent', color: 'var(--anthropic-orange)',
            fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <Send size={12} style={{ flexShrink: 0 }} />
          {sendNowLabel(count, pt)}
        </button>
      )}
      {run?.kind === 'done' && (
        <div
          data-testid="send-now-result"
          role={run.ok ? 'status' : 'alert'}
          style={{ width: 'min(360px, 100%)', display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <div style={{
            height: 4, borderRadius: 999,
            background: run.ok ? 'var(--accent-green, #22c55e)' : 'var(--accent-red, #ef4444)',
          }} />
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, justifyContent: 'flex-end' }}>
            <span style={{
              fontSize: 11.5, textAlign: 'right', lineHeight: 1.4,
              color: run.ok ? 'var(--text-secondary)' : 'var(--accent-red, #ef4444)',
            }}>
              {run.message}
            </span>
            <button
              onClick={onDismiss}
              className="ag-tap"
              aria-label={pt ? 'Fechar' : 'Dismiss'}
              style={{
                flexShrink: 0, display: 'inline-flex', padding: 2, border: 'none', background: 'transparent',
                color: 'var(--text-tertiary, var(--text-secondary))', cursor: 'pointer',
              }}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
