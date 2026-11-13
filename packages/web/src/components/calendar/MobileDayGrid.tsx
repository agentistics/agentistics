import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { brtDay, brtDayStartMs, pieceDayPresence, type CalMark, type CalPiece, type CalVersion } from '@agentistics/core'
import { addDays, clock, DAY_MS, packIntervals, placeColumn, swipeDay, weekDays } from '../../lib/calendarModel'
import { stageColor, EXPECTED_COLOR, PUBLISHED_COLOR } from './calendarUi'
import { TEXT, pick } from './calendarText'
import type { CalSelection } from './CalendarDetail'

export interface MobileGridProps {
  anchor: string; nowMs: number; versions: readonly CalVersion[]; pieces: readonly CalPiece[]; marks: readonly CalMark[]; pt: boolean
  span: 1 | 3 | 7; onDay: (day: string) => void; /** Opens a day in the Day view; defaults to selecting it. */ onOpenDay?: (day: string) => void; onOpen: (selection: CalSelection, e: React.MouseEvent) => void
}
export interface PhoneEvent { id: string; title: string; color: string; fromMs: number; toMs: number; expected: boolean; selection: CalSelection; /** Covers the whole day: it has no hour, so it goes to the all-day band, never a full-height block. */ allDay?: boolean }

/** One card per piece, plus each version and account reset, on its actual BRT day. */
export function phoneEvents(day: string, p: Pick<MobileGridProps, 'nowMs' | 'pieces' | 'versions' | 'marks'>): PhoneEvent[] {
  const events: PhoneEvent[] = []
  const d0 = brtDayStartMs(day), end = d0 + DAY_MS
  for (const piece of p.pieces) {
    const blocks = pieceDayPresence(piece, day, p.nowMs) // the same rule as the API's window and the desktop Day
    if (blocks.length === 0) continue
    const fromMs = Math.min(...blocks.map(b => b.fromMs)), toMs = Math.max(...blocks.map(b => b.toMs))
    events.push({ id: piece.key, title: piece.title, color: stageColor(piece.stage), fromMs, toMs: Math.max(toMs, Math.min(end, fromMs + 30 * 60_000)), expected: blocks.every(b => b.expected), allDay: fromMs <= d0 && toMs >= end, selection: { kind: 'piece', key: piece.key } })
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
  // Day only: when the overlapping pieces do not fit side by side, the column stacks them (card + "+N"); the chip spreads them out.
  const [spread, setSpread] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  // A column narrower than 44px cannot hold a tap target per piece: the whole column opens its Day instead (0 = not measured).
  const body = useRef<HTMLDivElement>(null)
  const [colW, setColW] = useState(0)
  useLayoutEffect(() => {
    const el = scroller.current // the viewport, not the body: the body grows with the lanes
    if (!el) return
    const measure = () => setColW((el.clientWidth - (span === 1 ? 44 : 14)) / span)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [span])
  const narrow = span > 1 && colW > 0 && colW < 44
  // Day: lanes thinner than 44px are not targets either, so the column grows to 44px per lane and the grid scrolls sideways.
  const timedOf = (day: string) => phoneEvents(day, p).filter(e => !e.allDay)
  const lanes = span === 1 ? Math.max(1, ...packIntervals(timedOf(anchor).map(e => ({ ...e, toMs: Math.max(e.toMs, e.fromMs + 44 * 60_000) }))).map(e => e.lanes)) : 1
  const overflowDay = span === 1 && colW > 0 && lanes * 44 > colW
  const wideDay = overflowDay && spread
  const stackDay = overflowDay && !spread
  const untimed = [...days.flatMap(day => phoneEvents(day, p).filter(e => e.allDay).map(e => ({ id: `${day}:${e.id}`, day, title: e.title, selection: e.selection }))), ...days.flatMap(day => [
    ...p.marks.flatMap(m => m.kind === 'task-due' && m.day === day ? [{ id: `${day}:${m.taskId}`, day, title: `${pick(TEXT.due, pt)} · ${m.label}`, selection: { kind: 'mark', mark: m } as CalSelection }] : []),
    // A version with no date is not happening on any day, today included, so it is never listed here (the API's
    // date window omits it too). It stays reachable in the Schedule view, which labels it "sem estimativa".
  ])]
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
        {(expanded ? untimed : untimed.slice(0, 2)).map(e => <button type="button" className="cal-phone-button cal-phone-allday" data-cal-allday-row={e.day} key={e.id} onClick={ev => p.onOpen(e.selection, ev)}>{span > 1 && `${e.day.slice(8)} · `}{e.title}</button>)}
        {untimed.length > 2 && <button className="cal-phone-button cal-phone-allday-more" data-cal-allday-more={untimed.length - 2} type="button" onClick={() => setExpanded(!expanded)}>{expanded ? pick(TEXT.collapse, pt) : `+${untimed.length - 2} ${pick(TEXT.more, pt)}`}</button>}
      </div>}
    </div>}
    <div ref={scroller} data-cal-hour-scroller style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: wideDay ? 'auto' : 'hidden', overscrollBehavior: 'contain', touchAction: wideDay ? 'pan-x pan-y' : 'pan-y' }}
      onTouchStart={e => { const t = e.touches[0]; if (t) start.current = { x: t.clientX, y: t.clientY } }}
      onTouchEnd={e => { const t = e.changedTouches[0]; if (t && start.current && !wideDay) p.onDay(swipeDay(anchor, t.clientX - start.current.x, t.clientY - start.current.y, 1)); start.current = null }}>
      {/* 24h of grid plus room so 23:00 scrolls fully above the bottom navigation and the chat button. */}
      {wideDay && <button type="button" data-cal-spread-collapse className="cal-phone-button" onClick={() => setSpread(false)} style={{ position: 'sticky', top: 0, left: 0, zIndex: 4, height: 28, minHeight: 28, padding: '0 8px', fontSize: 11 }}>{pick(TEXT.collapse, pt)}</button>}
      {emptyDay && <div data-cal-empty-day role="status" style={{ position: 'sticky', top: 0, zIndex: 3, height: 0, overflow: 'visible', pointerEvents: 'none' }}><div style={{ margin: '12px auto 0', width: 'fit-content', maxWidth: '85%', padding: '8px 12px', borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 12.5, textAlign: 'center' }}>{pick(TEXT.emptyDay, pt)}</div></div>}
      <div ref={body} data-cal-grid-body data-cal-narrow={narrow ? '' : undefined} data-cal-lanes={wideDay ? lanes : undefined} style={{ ...(wideDay ? { width: 44 + lanes * 44 } : {}), height: 'calc(1440px + 148px + env(safe-area-inset-bottom, 0px))', display: 'flex', position: 'relative' }}>
        {/* Thin views give the gutter up to the columns (hour number only): at 360px the page content is ~328px wide, and seven columns of 44px leave ~20px. */}
        <div style={{ width: span === 1 ? 44 : 14, flexShrink: 0, position: 'relative' }}>{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ position: 'absolute', top: h * 60, left: 0, fontSize: span === 1 ? 10 : 9, color: 'var(--text-tertiary)' }}>{String(h).padStart(2, '0')}{span === 1 ? ':00' : ''}</span>)}</div>
        {days.map(day => {
          const d0 = brtDayStartMs(day)
          const raw = timedOf(day)
          const openDay = () => (span === 1 ? setSpread(true) : (p.onOpenDay ?? p.onDay)(day))
          const cardStyle = (e: PhoneEvent): React.CSSProperties => ({ position: 'absolute', padding: '4px 3px', textAlign: 'left', font: 'inherit', fontSize: span === 1 ? 11 : 10, lineHeight: 1.2, color: 'var(--text-primary)', border: `1px ${e.expected ? 'dashed' : 'solid'} ${e.color}`, borderLeftWidth: 3, borderRadius: 4, background: `color-mix(in srgb, ${e.color} 24%, var(--bg-card))`, cursor: 'pointer', boxSizing: 'border-box' })
          const label = (e: PhoneEvent) => <span style={{ display: 'block', height: '100%', overflow: 'hidden', overflowWrap: 'anywhere' }}><b>{e.title}</b><br /><small>{clock(e.fromMs)}</small></span>
          let cards: React.ReactNode
          if (span === 1 && !stackDay) {
            // A full-width Day column can afford lanes; pack the visible minimum height too, so short cards cannot cover each other.
            cards = packIntervals(raw.map(e => ({ ...e, toMs: Math.min(d0 + DAY_MS, Math.max(e.toMs, e.fromMs + 44 * 60_000)) }))).map(e => <button type="button" className="cal-phone-event" data-cal-phone-event={e.id} key={e.id} title={`${e.title} · ${clock(e.fromMs)}`} aria-label={`${e.title} · ${clock(e.fromMs)}`} onClick={ev => p.onOpen(e.selection, ev)} style={{ ...cardStyle(e), top: (e.fromMs - d0) / 60_000, left: `${e.lane / e.lanes * 100}%`, width: `${100 / e.lanes}%`, height: Math.max(44, (e.toMs - e.fromMs) / 60_000) }}>{label(e)}</button>)
          } else {
            // Thin columns (Week, 3 days): one full-width card per stretch of time, the rest counted in a "+N" chip. Both open the day.
            const byId = new Map(raw.map(e => [e.id, e]))
            cards = placeColumn(raw, d0).map(item => {
              if (narrow) { // drawn, not tappable: the column button below opens the Day
                if (item.kind === 'chip') return <div aria-hidden data-cal-phone-more={item.count} data-cal-phone-more-day={day} key={`more:${item.top}`} style={{ position: 'absolute', top: item.top, left: 0, width: '100%', height: item.height, display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 700, border: '1px solid var(--border)', background: 'var(--bg-elevated)', boxSizing: 'border-box', pointerEvents: 'none' }}>+{item.count}</div>
                const e = byId.get(item.id)!
                return <div aria-hidden data-cal-phone-event={e.id} key={e.id} style={{ ...cardStyle(e), top: item.top, left: 0, width: '100%', height: item.height, pointerEvents: 'none' }}>{label(e)}</div>
              }
              if (item.kind === 'chip') return <button type="button" className="cal-phone-button" data-cal-phone-more={item.count} data-cal-phone-more-day={day} key={`more:${item.top}`} aria-label={`+${item.count} · ${day}`} onClick={openDay} style={{ position: 'absolute', top: item.top, left: 0, width: '100%', height: item.height, minWidth: 0, padding: 0, fontWeight: 700, border: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>+{item.count}</button>
              const e = byId.get(item.id)!
              return <button type="button" className="cal-phone-event" data-cal-phone-event={e.id} key={e.id} title={`${e.title} · ${clock(e.fromMs)}`} aria-label={`${e.title} · ${clock(e.fromMs)}`} onClick={ev => (item.hidden > 0 ? openDay() : p.onOpen(e.selection, ev))} style={{ ...cardStyle(e), top: item.top, left: 0, width: '100%', height: item.height }}>{label(e)}</button>
            })
          }
          return <div key={day} data-cal-grid-day={day} style={{ flex: 1, minWidth: 0, height: 1440, position: 'relative', boxShadow: 'inset 1px 0 var(--border)', background: 'repeating-linear-gradient(to bottom, var(--border-subtle) 0 1px, transparent 1px 60px)' }}>
            {cards}
            {narrow && <button type="button" data-cal-day-target={day} aria-label={`${day} · ${raw.length}`} onClick={openDay} style={{ position: 'absolute', inset: 0, zIndex: 1, padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }} />}
            {day === today && <div data-cal-now style={{ position: 'absolute', top: (nowMs - d0) / 60_000, left: 0, right: 0, borderTop: '2px solid var(--accent-red)', pointerEvents: 'none', zIndex: 2 }} />}
          </div>
        })}
        {days.includes(today) && <span style={{ position: 'absolute', left: 0, top: (nowMs - brtDayStartMs(today)) / 60_000 - 9, fontSize: 10, borderRadius: 4, background: 'var(--accent-red)', color: '#fff', padding: 2, pointerEvents: 'none', zIndex: 3 }}>{clock(nowMs)}</span>}
      </div>
    </div>
  </div>
}
