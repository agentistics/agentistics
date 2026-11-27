/**
 * LineStatusIcon — the coloured state icon at the right of a sidebar row, with its tooltip.
 *
 * Option A of the approved prototype (`leader/estado-icones`, owner 2026-11-26): the icon replaces
 * the old dot and carries the STATE; the row beside it carries only the short time. The full sentence
 * ("rodando há 1 min", "na fila de trabalho pesado") is the tooltip, reachable three ways — hover,
 * keyboard focus (the icon is a tab stop) and a tap (a phone has no hover) — and is also the icon's
 * accessible name, so a screen reader hears it without opening anything.
 *
 * The tooltip is portalled to `document.body` and positioned `fixed`: the aside scrolls and clips,
 * and a bubble drawn inside it would be cut at the column edge.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Users } from 'lucide-react'
import { LINE_STATUS_COLOR, type LineStatusKind } from '../../lib/lineStatus'

/** The prototype's glyphs (viewBox 18×18), one per kind. */
function glyph(kind: LineStatusKind): ReactNode {
  switch (kind) {
    case 'writing':
      return <circle cx="9" cy="9" r="5" fill="currentColor" className="ag-ls-pulse" />
    case 'cmd':
      return <circle cx="9" cy="9" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28 12" className="ag-ls-spin" />
    case 'task':
      return <><rect x="2.5" y="3.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M5.5 7.5l2 1.8-2 1.8M9.5 11h3" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" /></>
    case 'queue':
      return <path d="M5 2.5h8M5 15.5h8M6 2.5c0 4 6 4.5 6 6.5s-6 2.5-6 6.5M12 2.5c0 4-6 4.5-6 6.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    case 'approval':
    case 'you':
      return <><path d="M3 4.5a2 2 0 012-2h8a2 2 0 012 2v6a2 2 0 01-2 2H8l-3.5 3v-3H5a2 2 0 01-2-2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><circle cx="9" cy="7.5" r="1.2" fill="currentColor" /></>
    case 'workers':
      return <Users x={1} y={1} width={16} height={16} aria-hidden />
    case 'fell':
      return <><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M7 6v6M11 6v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>
    case 'ended':
      return <><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M5.5 9.2l2.4 2.3 4.6-4.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>
    case 'idle':
      return <circle cx="9" cy="9" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
  }
}

export interface LineStatusIconProps {
  kind: LineStatusKind
  /** The full sentence: the tooltip AND the accessible name. */
  text: string
  /** Mobile row height (44) — the icon's touch box is that square (44×44 at least); undefined on desktop. */
  tap?: number
}

/** The one open tooltip's closer: opening another closes it (hover on one icon + focus on another
 *  would otherwise leave two bubbles on screen). */
let closeOpen: (() => void) | null = null

export function LineStatusIcon({ kind, text, tap }: LineStatusIconProps) {
  const [tip, setTip] = useState<{ right: number; y: number } | null>(null)
  const ref = useRef<HTMLSpanElement | null>(null)
  const id = useId()
  const hide = () => setTip(null)
  const closer = useRef(hide)
  closer.current = hide
  const mine = useRef(() => closer.current())
  /** How the open tooltip was opened: only one opened by a TAP is closed by the next tap. A phone's tap
   *  also fires focus (and a compat mouse-enter) before its click; letting the click toggle THAT open
   *  tooltip closed again made a tap show nothing. */
  const via = useRef<'hover' | 'focus' | 'tap' | null>(null)
  const show = (how: 'hover' | 'focus' | 'tap') => {
    const el = ref.current
    if (!el) return
    if (closeOpen && closeOpen !== mine.current) closeOpen()
    closeOpen = mine.current
    via.current = how
    const r = el.getBoundingClientRect()
    // Anchored by its RIGHT edge (the icon's): anchored by `left` and shifted back, the bubble's
    // available width was the strip right of the icon, and on a phone it wrapped a word per line.
    setTip({ right: Math.max(0, window.innerWidth - r.right), y: r.top - 6 })
  }
  useEffect(() => () => { if (closeOpen === mine.current) closeOpen = null }, [])
  // A tap opened it: the next tap anywhere else closes it (there is no mouse-leave on a phone).
  useEffect(() => {
    if (!tip) return
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setTip(null) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [tip])
  return (
    <span
      ref={ref}
      role="img"
      tabIndex={0}
      aria-label={text}
      {...(tip ? { 'aria-describedby': id } : {})}
      data-line-status={kind}
      onPointerEnter={e => { if (e.pointerType === 'mouse') show('hover') }}
      onPointerLeave={e => { if (e.pointerType === 'mouse' && via.current === 'hover') hide() }}
      onFocus={() => show('focus')}
      onBlur={hide}
      onClick={e => { e.stopPropagation(); if (tip && via.current === 'tap') hide(); else show('tap') }}
      onKeyDown={e => { if (e.key === 'Escape') hide() }}
      className="ag-line-status"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        // On a phone the hit area is at least 44×44 (CONTRIBUTING); the glyph stays 15px.
        width: tap ? Math.max(tap, 44) : 18, height: tap ? Math.max(tap, 44) : 18, borderRadius: 5, cursor: 'default',
        color: LINE_STATUS_COLOR[kind], outlineOffset: 1,
      }}
    >
      <svg viewBox="0 0 18 18" width={15} height={15} aria-hidden focusable="false">{glyph(kind)}</svg>
      {tip && typeof document !== 'undefined' && createPortal(
        <span role="tooltip" id={id} data-line-status-tip style={{
          position: 'fixed', right: tip.right, top: tip.y, transform: 'translateY(-100%)', zIndex: 4000,
          pointerEvents: 'none', width: 'max-content', maxWidth: 'min(280px, calc(100vw / var(--ui-zoom, 1) - 16px))', boxSizing: 'border-box',
          padding: '5px 8px', borderRadius: 6, background: 'var(--bg-elevated)', color: 'var(--text-primary)',
          border: '1px solid var(--border)', fontSize: 12, lineHeight: 1.35, whiteSpace: 'normal',
          boxShadow: '0 3px 12px rgba(0,0,0,.25)',
        }}>{text}</span>,
        document.body,
      )}
    </span>
  )
}
