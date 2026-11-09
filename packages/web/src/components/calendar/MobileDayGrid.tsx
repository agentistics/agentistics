import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { brtDay, brtDayStartMs, pieceSpan, type CalMark, type CalPiece, type CalVersion } from '@agentistics/core'
import { addDays, clock, DAY_MS, packIntervals, placeColumn, swipeDay, weekDays } from '../../lib/calendarModel'
import { stageColor, EXPECTED_COLOR, PUBLISHED_COLOR } from './calendarUi'
import { TEXT, pick } from './calendarText'
import type { CalSelection } from './CalendarDetail'

export interface MobileGridProps {
  anchor: string; nowMs: number; versions: readonly CalVersion[]; pieces: readonly CalPiece[]; marks: readonly CalMark[]; pt: boolean
  span: 1 | 3 | 7; onDay: (day: string) => void; /** Opens a day in the Day view; defaults to selecting it. */ onOpenDay?: (day: string) => void; onOpen: (selection: CalSelection, e: React.MouseEvent) => void
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
    // A version with no date is not happening on any day, today included, so it is never listed here (the API's
    // date window omits it too). It stays reachable in the Schedule view, which labels it "sem estimativa".
  ])
  // A day with nothing on it says so (the hour grid alone reads as a screen that failed to load).
  const emptyDay = span === 1 && untimed.length === 0 && phoneEvents(anchor, p).length === 0
  useEffect(() => {
    const minutes = (nowMs - brtDayStartMs(today)) / 60_000
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (days.includes(today) ? minutes : 8 * 60) - 120)
    // Anchor changes reposition the grid; clock ticks must not interrupt scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, span])
  return <div data-cal-mobile-grid style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    {untimed.length > 0 && <div data-cal-allday-band style={{ flexShrink: 0, display: 'flex', borderBottom: '1px solid var(--border)', maxHeight: '35%', overflowY: 'auto' }}>
      {/* The label column is the hour column's width: "all day · N" sits where the hours are, rows start at the grid. */}
      <button type="button" className="cal-phone-button" aria-expanded={!collapsed} aria-label={`${pick(TEXT.allDay, pt)} · ${untimed.length}`} onClick={() => setCollapsed(!collapsed)} style={{ width: 44, flexShrink: 0, flexDirection: 'column', gap: 0, padding: 0, fontSize: 10, color: 'var(--text-tertiary)' }}>
        <span>{untimed.length}</span>{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      {!collapsed && <div style={{ flex: 1, minWidth: 0 }}>
        {(expanded ? untimed : untimed.slice(0, 3)).map(e => <button type="button" className="cal-phone-button cal-phone-allday" data-cal-allday-row={e.day} key={e.id} onClick={ev => p.onOpen(e.selection, ev)}>{span > 1 && `${e.day.slice(8)} · `}{e.title}</button>)}
        {untimed.length > 3 && <button className="cal-phone-button cal-phone-allday-more" data-cal-allday-more={untimed.length - 3} type="button" onClick={() => setExpanded(!expanded)}>{expanded ? pick(TEXT.collapse, pt) : `+${untimed.length - 3} ${pick(TEXT.more, pt)}`}</button>}
      </div>}
    </div>}
    <div ref={scroller} data-cal-hour-scroller style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', touchAction: 'pan-y' }}
      onTouchStart={e => { const t = e.touches[0]; if (t) start.current = { x: t.clientX, y: t.clientY } }}
      onTouchEnd={e => { const t = e.changedTouches[0]; if (t && start.current) p.onDay(swipeDay(anchor, t.clientX - start.current.x, t.clientY - start.current.y, 1)); start.current = null }}>
      {/* 24h of grid plus room so 23:00 scrolls fully above the bottom navigation and the chat button. */}
      {emptyDay && <div data-cal-empty-day role="status" style={{ position: 'sticky', top: 0, zIndex: 3, height: 0, overflow: 'visible', pointerEvents: 'none' }}><div style={{ margin: '12px auto 0', width: 'fit-content', maxWidth: '85%', padding: '8px 12px', borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 12.5, textAlign: 'center' }}>{pick(TEXT.emptyDay, pt)}</div></div>}
      <div data-cal-grid-body style={{ height: 'calc(1440px + 148px + env(safe-area-inset-bottom, 0px))', display: 'flex', position: 'relative' }}>
        {/* Thin views give the gutter up to the columns (hour number only): at 360px the page content is ~328px wide, and seven columns of 44px leave ~20px. */}
        <div style={{ width: span === 1 ? 44 : 14, flexShrink: 0, position: 'relative' }}>{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ position: 'absolute', top: h * 60, left: 0, fontSize: span === 1 ? 10 : 9, color: 'var(--text-tertiary)' }}>{String(h).padStart(2, '0')}{span === 1 ? ':00' : ''}</span>)}</div>
        {days.map(day => {
          const d0 = brtDayStartMs(day)
          const raw = phoneEvents(day, p)
          const openDay = () => (p.onOpenDay ?? p.onDay)(day)
          const cardStyle = (e: PhoneEvent): React.CSSProperties => ({ position: 'absolute', padding: '4px 3px', textAlign: 'left', font: 'inherit', fontSize: span === 1 ? 11 : 10, lineHeight: 1.2, color: 'var(--text-primary)', border: `1px ${e.expected ? 'dashed' : 'solid'} ${e.color}`, borderLeftWidth: 3, borderRadius: 4, background: `color-mix(in srgb, ${e.color} 24%, var(--bg-card))`, cursor: 'pointer', boxSizing: 'border-box' })
          const label = (e: PhoneEvent) => <span style={{ display: 'block', height: '100%', overflow: 'hidden', overflowWrap: 'anywhere' }}><b>{e.title}</b><br /><small>{clock(e.fromMs)}</small></span>
          let cards: React.ReactNode
          if (span === 1) {
            // A full-width Day column can afford lanes; pack the visible minimum height too, so short cards cannot cover each other.
            cards = packIntervals(raw.map(e => ({ ...e, toMs: Math.min(d0 + DAY_MS, Math.max(e.toMs, e.fromMs + 44 * 60_000)) }))).map(e => <button type="button" className="cal-phone-event" data-cal-phone-event={e.id} key={e.id} title={`${e.title} · ${clock(e.fromMs)}`} aria-label={`${e.title} · ${clock(e.fromMs)}`} onClick={ev => p.onOpen(e.selection, ev)} style={{ ...cardStyle(e), top: (e.fromMs - d0) / 60_000, left: `${e.lane / e.lanes * 100}%`, width: `${100 / e.lanes}%`, height: Math.max(44, (e.toMs - e.fromMs) / 60_000) }}>{label(e)}</button>)
          } else {
            // Thin columns (Week, 3 days): one full-width card per stretch of time, the rest counted in a "+N" chip. Both open the day.
            const byId = new Map(raw.map(e => [e.id, e]))
            cards = placeColumn(raw, d0).map(item => {
              if (item.kind === 'chip') return <button type="button" className="cal-phone-button" data-cal-phone-more={item.count} data-cal-phone-more-day={day} key={`more:${item.top}`} aria-label={`+${item.count} · ${day}`} onClick={openDay} style={{ position: 'absolute', top: item.top, left: 0, width: '100%', height: item.height, minWidth: 0, padding: 0, fontWeight: 700, border: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>+{item.count}</button>
              const e = byId.get(item.id)!
              return <button type="button" className="cal-phone-event" data-cal-phone-event={e.id} key={e.id} title={`${e.title} · ${clock(e.fromMs)}`} aria-label={`${e.title} · ${clock(e.fromMs)}`} onClick={ev => (item.hidden > 0 ? openDay() : p.onOpen(e.selection, ev))} style={{ ...cardStyle(e), top: item.top, left: 0, width: '100%', height: item.height }}>{label(e)}</button>
            })
          }
          return <div key={day} data-cal-grid-day={day} style={{ flex: 1, minWidth: 0, height: 1440, position: 'relative', boxShadow: 'inset 1px 0 var(--border)', background: 'repeating-linear-gradient(to bottom, var(--border-subtle) 0 1px, transparent 1px 60px)' }}>
            {cards}
            {day === today && <div data-cal-now style={{ position: 'absolute', top: (nowMs - d0) / 60_000, left: 0, right: 0, borderTop: '2px solid var(--accent-red)', pointerEvents: 'none', zIndex: 2 }} />}
          </div>
        })}
        {days.includes(today) && <span style={{ position: 'absolute', left: 0, top: (nowMs - brtDayStartMs(today)) / 60_000 - 9, fontSize: 10, borderRadius: 4, background: 'var(--accent-red)', color: '#fff', padding: 2, pointerEvents: 'none', zIndex: 3 }}>{clock(nowMs)}</span>}
      </div>
    </div>
  </div>
}
