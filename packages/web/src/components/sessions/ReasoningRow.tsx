/**
 * ReasoningRow — the model's reasoning as an activity line (`lib/reasoningRow.ts`): a brain, `Raciocinando… · 12 s` and a pulse
 * while it streams, `Raciocinou · 12 s ⌄` once over, opening onto the text. The same shape and slot as `ToolActivity`'s inline line,
 * so the two read as one family. Closed until asked; the person's choice survives live updates.
 */
import { useEffect, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { SYS_TEXT } from './ChatBubble'
import { useIsMobile } from '../../hooks/useIsMobile'
import { EMPTY_REASONING_CLOCK, reasoningLabel, reasoningSpanMs, stepReasoningClock, type ReasoningClock } from '../../lib/reasoningRow'

export function ReasoningRow({ text, running, clock, lang }: { text: string; running: boolean; clock: ReasoningClock; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  const label = reasoningLabel(running, reasoningSpanMs(clock, now), pt)
  return (
    <div data-testid="reasoning-row" data-running={running ? 'true' : 'false'} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, fontSize: 11, color: SYS_TEXT, margin: '2px 0' }}>
      <div style={{ display: 'flex', minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%',
            border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer',
            ...(isMobile ? { minHeight: 44 } : {}),
          }}
        >
          <span aria-hidden="true" style={{ display: 'inline-flex', width: 14, height: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Brain size={14} className={running ? 'ag-reasoning-pulse' : undefined} />
          </span>
          <span role={running ? 'status' : undefined} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <ChevronDown size={13} style={{ flexShrink: 0, transition: 'transform 140ms', transform: open ? 'rotate(180deg)' : 'none' }} />
        </button>
      </div>
      {open && (
        <div style={{
          padding: '6px 10px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflowY: 'auto',
          background: 'color-mix(in srgb, var(--bg-surface) 70%, transparent)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        }}>{text}</div>
      )}
    </div>
  )
}

/** The clock of the live turn's reasoning, from what this component has SEEN (`stepReasoningClock`); measured here because no source states it. */
export function useReasoningClock(hasReasoning: boolean, answerStarted: boolean, working: boolean): ReasoningClock {
  const [clock, setClock] = useState<ReasoningClock>(EMPTY_REASONING_CLOCK)
  useEffect(() => {
    setClock(prev => stepReasoningClock(prev, { hasReasoning, answerStarted, working, now: Date.now() }))
  }, [hasReasoning, answerStarted, working])
  return clock
}
