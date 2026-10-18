/**
 * SessionRowLine — what a sidebar row says about its session, on ONE line (the explorer-style list):
 * status dot, harness mark, title (fades out at the edge, never an ellipsis), leader crown, and a short
 * state at the right. The task, harness name, model and full state live in the hover card
 * (`SessionHoverCard`, the same `SessionFacts` the collapsed rail's tooltip draws) and in the open
 * session's header — so a long task title can never wrap or grow the row.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Crown } from 'lucide-react'
import { sessionNotify, type ControlSession } from '@agentistics/tui/control/session-fleet'
import { sessionDisplayTitle } from '../../lib/sessionDisplayTitle'
import { STATE_COLOR } from '../../lib/sessionCardStyle'
import { HarnessMark } from './HarnessMark'
import { ClosingRing } from './ClosingRing'
import { SessionFacts } from './SessionFacts'
import { ENDED } from '../../lib/sessionTabs'
import { FadeText } from './FadeText'

/** The short state at the right of a row. */
export function rowTail(s: Pick<ControlSession, 'state'>, pt: boolean, closing: boolean): { text: string; accent: boolean } | null {
  if (closing) return { text: pt ? 'encerrando' : 'closing', accent: false }
  if (sessionNotify(s as ControlSession)) return { text: pt ? 'você' : 'you', accent: true }
  if (s.state === 'working') return { text: pt ? 'rodando' : 'working', accent: false }
  if (ENDED.has(s.state)) return { text: pt ? 'encerrada' : 'ended', accent: false }
  return null
}

export function SessionRowLine({ session, selected, pt, closing, leader, reopening, showHarness = true }: {
  session: ControlSession; selected: boolean; pt: boolean; closing: boolean; leader: boolean; reopening?: ReactNode; showHarness?: boolean
}) {
  const color = STATE_COLOR[session.state] ?? 'var(--text-tertiary)'
  const wants = sessionNotify(session)
  const tail = rowTail(session, pt, closing)
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', minWidth: 0 }}>
      {closing
        ? <ClosingRing label={pt ? 'Encerrando' : 'Closing'} />
        : <span role="img" aria-label={session.stateLabel} title={session.stateLabel} style={{
          width: 8, height: 8, flexShrink: 0, borderRadius: '50%', boxSizing: 'border-box',
          background: ENDED.has(session.state) ? 'transparent' : color, border: ENDED.has(session.state) ? `1.5px solid ${color}` : 'none',
        }} />}
      {showHarness && <span style={{ display: 'inline-flex', flexShrink: 0 }}><HarnessMark harness={session.harness} size={14} /></span>}
      <FadeText data-row-title style={{
        flex: 1, minWidth: 0, lineHeight: 1.4, fontWeight: selected || wants ? 650 : 500,
      }}>{sessionDisplayTitle(session.title)}</FadeText>
      {leader && <Crown size={11} aria-label={pt ? 'Líder' : 'Leader'} style={{ color: 'var(--accent-purple)', flexShrink: 0 }} />}
      {reopening}
      {tail && <span data-row-tail style={{
        flexShrink: 0, fontSize: 11, fontWeight: tail.accent ? 650 : 400,
        color: tail.accent ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
      }}>{tail.text}</span>}
    </span>
  )
}

/** Hover/focus card for a row: everything the one-line row leaves out. A portal, like the rail's tooltip. */
export function useRowHoverCard(delayMs = 350) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null } }
  useEffect(() => clear, [])
  return {
    rect,
    onEnter: (el: HTMLElement) => { clear(); timer.current = setTimeout(() => setRect(el.getBoundingClientRect()), delayMs) },
    onLeave: () => { clear(); setRect(null) },
  }
}

export function SessionHoverCard({ session, rect, pt }: { session: ControlSession; rect: DOMRect | null; pt: boolean }) {
  if (rect === null) return null
  const left = Math.min(rect.right + 8, Math.max(8, window.innerWidth - 268))
  return createPortal(
    <div role="tooltip" data-session-hover-card style={{
      position: 'fixed', top: Math.max(8, Math.min(rect.top, window.innerHeight - 140)), left, width: 260, zIndex: 500, pointerEvents: 'none',
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 11px', boxShadow: 'var(--ag-shadow-pop)',
    }}>
      <SessionFacts session={session} lang={pt ? 'pt' : 'en'} />
    </div>,
    document.body,
  )
}
