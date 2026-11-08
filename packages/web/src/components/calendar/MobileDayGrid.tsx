import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { brtDay, brtDayStartMs, pieceSpan, type CalMark, type CalPiece, type CalVersion } from '@agentistics/core'
import { addDays, clock, DAY_MS, packIntervals, swipeDay, weekDays } from '../../lib/calendarModel'
import { stageColor, EXPECTED_COLOR, PUBLISHED_COLOR } from './calendarUi'
import { TEXT, pick } from './calendarText'
import type { CalSelection } from './CalendarDetail'

export interface MobileGridProps {
  anchor: string; nowMs: number; versions: readonly CalVersion[]; pieces: readonly CalPiece[]; marks: readonly CalMark[]; pt: boolean
  span: 1 | 3 | 7; onDay: (day: string) => void; onOpen: (selection: CalSelection, e: React.MouseEvent) => void
}
export interface PhoneEvent { id: string; title: string; color: string; fromMs: number; toMs: number; expected: boolean; selection: CalSelection }

/** One card per piece, plus each version and account reset, on its actual BRT day. */
export function phoneEvents(day: string, p: Pick<MobileGridProps, 'nowMs' | 'pieces' | 'versions' | 'marks'>): PhoneEvent[] {
  const events: PhoneEvent[] = []
  const d0 = brtDayStartMs(day), end = d0 + DAY_MS
  for (const piece of p.pieces) {
    const span = pieceSpan(piece)
    if (!span || span.endMs < d0 || span.startMs >= end) continue
    events.push({ id: piece.key, title: piece.title, color: stageColor(piece.stage), fromMs: Math.max(d0, span.startMs), toMs: Math.min(end, span.endMs), expected: span.startMs > p.nowMs, selection: { kind: 'piece', key: piece.key } })
  }
  for (const v of p.versions) if (v.atMs !== null && brtDay(v.atMs) === day) events.push({ id: `version:${v.version}`, title: v.version, color: v.state === 'published' ? PUBLISHED_COLOR : EXPECTED_COLOR, fromMs: v.atMs, toMs: v.atMs + 30 * 60_000, expected: v.state !== 'published', selection: { kind: 'version', version: v.version } })
  for (const m of p.marks) if (m.kind === 'account-reset' && brtDay(m.atMs) === day) events.push({ id: `reset:${m.account}:${m.window}`, title: m.label, color: 'var(--accent-cyan)', fromMs: m.atMs, toMs: m.atMs + 30 * 60_000, expected: true, selection: { kind: 'mark', mark: m } })
  return events.map(e => ({ ...e, toMs: Math.min(end, e.toMs) }))
}

export function MobileDayGrid(p: MobileGridProps) {
  const { anchor, nowMs, span, pt } = p
  const today = brtDay(nowMs)
  const days = span === 7 ? weekDays(anchor) : Array.from({ length: span }, (_, i) => addDays(anchor, i))
  const [expanded, setExpanded] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const untimed = days.flatMap(day => [
    ...p.marks.flatMap(m => m.kind === 'task-due' && m.day === day ? [{ id: `${day}:${m.taskId}`, day, title: `${pick(TEXT.due, pt)} · ${m.label}`, selection: { kind: 'mark', mark: m } as CalSelection }] : []),
    ...p.versions.flatMap(v => v.atMs === null && day === today ? [{ id: v.version, day, title: `${v.version} · ${pick(TEXT.noEstimate, pt)}`, selection: { kind: 'version', version: v.version } as CalSelection }] : []),
  ])
  useEffect(() => {
    const minutes = (nowMs - brtDayStartMs(today)) / 60_000
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (days.includes(today) ? minutes : 8 * 60) - 120)
    // Anchor changes reposition the grid; clock ticks must not interrupt scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, span])
  return <div data-cal-mobile-grid style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <div data-cal-allday-band style={{ flexShrink: 0, borderBottom: '1px solid var(--border)', maxHeight: '35%', overflowY: 'auto' }}>
      <button type="button" className="cal-phone-button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)} style={{ width: '100%', justifyContent: 'space-between' }}>
        <span>{pick(TEXT.allDay, pt)} · {untimed.length}</span>{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      {!collapsed && <div style={{ paddingLeft: 44 }}>
        {(expanded ? untimed : untimed.slice(0, 3)).map(e => <button type="button" className="cal-phone-button cal-phone-allday" key={e.id} onClick={ev => p.onOpen(e.selection, ev)}>{span > 1 && `${e.day.slice(8)} · `}{e.title}</button>)}
        {untimed.length > 3 && <button className="cal-phone-button" type="button" onClick={() => setExpanded(!expanded)}>{expanded ? pick(TEXT.collapse, pt) : `+${untimed.length - 3} ${pick(TEXT.more, pt)}`}</button>}
      </div>}
    </div>
    <div ref={scroller} data-cal-hour-scroller style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', touchAction: 'pan-y' }}
      onTouchStart={e => { const t = e.touches[0]; if (t) start.current = { x: t.clientX, y: t.clientY } }}
      onTouchEnd={e => { const t = e.changedTouches[0]; if (t && start.current) p.onDay(swipeDay(anchor, t.clientX - start.current.x, t.clientY - start.current.y, 1)); start.current = null }}>
      <div style={{ height: 24 * 60 + 44, display: 'flex', position: 'relative' }}>
        <div style={{ width: 44, flexShrink: 0, position: 'relative' }}>{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ position: 'absolute', top: h * 60, left: 0, fontSize: 10, color: 'var(--text-tertiary)' }}>{String(h).padStart(2, '0')}:00</span>)}</div>
        {days.map(day => {
          const d0 = brtDayStartMs(day)
          // Pack the visible minimum height too, so short adjacent cards cannot cover each other.
          const events = packIntervals(phoneEvents(day, p).map(e => ({ ...e, toMs: Math.min(d0 + DAY_MS, Math.max(e.toMs, e.fromMs + 44 * 60_000)) })))
          return <div key={day} data-cal-grid-day={day} style={{ flex: 1, minWidth: 0, height: 1440, position: 'relative', borderLeft: '1px solid var(--border)', background: 'repeating-linear-gradient(to bottom, var(--border-subtle) 0 1px, transparent 1px 60px)' }}>
            {events.map(e => <button type="button" className="cal-phone-event" data-cal-phone-event={e.id} key={e.id} title={`${e.title} · ${clock(e.fromMs)}`} aria-label={`${e.title} · ${clock(e.fromMs)}`} onClick={ev => p.onOpen(e.selection, ev)} style={{ position: 'absolute', top: (e.fromMs - d0) / 60_000, left: `${e.lane / e.lanes * 100}%`, width: `${100 / e.lanes}%`, height: Math.max(44, (e.toMs - e.fromMs) / 60_000), padding: '4px 3px', textAlign: 'left', font: 'inherit', fontSize: 11, color: 'var(--text-primary)', border: `1px ${e.expected ? 'dashed' : 'solid'} ${e.color}`, borderLeftWidth: 3, borderRadius: 4, background: `color-mix(in srgb, ${e.color} 24%, var(--bg-card))`, cursor: 'pointer' }}><span style={{ display: 'block', height: '100%', overflow: 'hidden' }}><b>{e.title}</b><br /><small>{clock(e.fromMs)}</small></span></button>)}
            {day === today && <div data-cal-now style={{ position: 'absolute', top: (nowMs - d0) / 60_000, left: 0, right: 0, borderTop: '2px solid var(--accent-red)', pointerEvents: 'none', zIndex: 2 }} />}
          </div>
        })}
        {days.includes(today) && <span style={{ position: 'absolute', left: 0, top: (nowMs - brtDayStartMs(today)) / 60_000 - 9, fontSize: 10, borderRadius: 4, background: 'var(--accent-red)', color: '#fff', padding: 2, pointerEvents: 'none', zIndex: 3 }}>{clock(nowMs)}</span>}
      </div>
    </div>
  </div>
}
