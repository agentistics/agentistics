import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Filter } from 'lucide-react'
import { brtDay, type CalMark, type CalPiece, type CalVersion } from '@agentistics/core'
import { addMonths, dowShort, monthCells, overduePiecesOfDay, rangeLabel, swipeDay, weekDays } from '../../lib/calendarModel'
import { TEXT, VIEW_LABEL, pick } from './calendarText'
import { MobileDayGrid, phoneEvents } from './MobileDayGrid'
import type { CalSelection } from './CalendarDetail'
import { ConfirmModal } from '../../pages/settings/primitives'
import './mobileCalendar.css'

export type PhoneView = 'day' | 'three' | 'week' | 'month' | 'schedule' | 'agenda'
export function CalendarSheet({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  return <ConfirmModal open title={title} message="" confirmLabel="" cancelLabel={closeLabel} closeLabel={closeLabel} onConfirm={onClose} onCancel={onClose} mobileSheet className="cal-phone-sheet" layer={2000} tone="default" icon={<Filter size={17} />} footer={<></>}>{children}</ConfirmModal>
}

export function MobileCalendar(p: {
  anchor: string; onDay: (day: string) => void; view: PhoneView; onView: (view: PhoneView) => void; nowMs: number; pt: boolean
  /** Opens a day IN the Day view. The parent must change the URL ONCE, carrying both the day and the view: two
   * sequential search-param updates race (the second is built from the pre-first params and wins, losing the day). */
  onOpenDay?: (day: string) => void
  versions: readonly CalVersion[]; pieces: readonly CalPiece[]; marks: readonly CalMark[]
  onOpen: (s: CalSelection, e: React.MouseEvent) => void; filterCount: number; filters: ReactNode; body: ReactNode; ready: boolean; exportIcs: () => void
}) {
  const [sheet, setSheet] = useState<'menu' | 'filters' | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const today = brtDay(p.nowMs)
  const days = weekDays(p.anchor)
  const openDay = p.onOpenDay ?? ((d: string) => { p.onDay(d); p.onView('day') })
  const month = <div data-cal-phone-month className="cal-phone-month">
    {Array.from({ length: 7 }, (_, i) => <span key={i}>{dowShort(i, p.pt).slice(0, 1)}</span>)}
    {monthCells(p.anchor).map(c => {
      const count = phoneEvents(c.day, p).length + p.marks.filter(m => m.kind === 'task-due' && m.day === c.day).length
      const late = overduePiecesOfDay(c.day, p.pieces, p.nowMs).length
      return <button type="button" key={c.day} className="cal-phone-button" data-cal-day={c.day} aria-label={`${c.day} · ${count}${late ? ` · ${late} ${pick(TEXT.overdue, p.pt)}` : ''}`} aria-current={c.day === today ? 'date' : undefined} style={{ opacity: c.inMonth ? 1 : 0.45, position: 'relative' }} onClick={() => { openDay(c.day); setSheet(null) }}>
        {late > 0 && <b data-cal-overdue={c.day} title={`${late} ${pick(TEXT.overdue, p.pt)}`} style={{ position: 'absolute', top: 1, right: 1, minWidth: 14, height: 14, padding: '0 3px', boxSizing: 'border-box', borderRadius: 7, background: 'var(--accent-red)', color: '#fff', fontSize: 9, lineHeight: '14px', fontWeight: 700 }}>{late}</b>}
        <span>{Number(c.day.slice(8))}</span><span aria-hidden style={{ display: 'flex', gap: 2 }}>{Array.from({ length: Math.min(count, 3) }, (_, i) => <i key={i} data-cal-dot style={{ width: 4, height: 4, borderRadius: '50%', background: c.day === today ? 'var(--bg-primary)' : 'var(--anthropic-orange)' }} />)}</span>
      </button>
    })}
  </div>
  return <div data-cal-phone style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
    <header style={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: 4 }}>
      <button type="button" className="cal-phone-button" aria-expanded={sheet === 'menu'} onClick={() => setSheet('menu')} style={{ flex: 1, justifyContent: 'flex-start', fontWeight: 600, fontSize: 17 }}>{rangeLabel('month', p.anchor, p.pt)}<ChevronDown size={16} /></button>
      <button type="button" className="cal-phone-button" data-cal-filter-trigger aria-label={pick(TEXT.filters, p.pt)} onClick={() => setSheet('filters')}><Filter size={19} />{p.filterCount > 0 && <sup>{p.filterCount}</sup>}</button>
      <button type="button" className="cal-phone-button" data-cal-today aria-label={pick(TEXT.today, p.pt)} onClick={() => p.onDay(today)} style={{ border: '1px solid var(--border)' }}>{Number(today.slice(8))}</button>
    </header>
    <div data-cal-week-strip style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', flexShrink: 0, borderBottom: '1px solid var(--border)', touchAction: 'pan-y' }}
      onTouchStart={e => { const t = e.touches[0]; if (t) start.current = { x: t.clientX, y: t.clientY } }}
      onTouchEnd={e => { const t = e.changedTouches[0]; if (t && start.current) p.onDay(swipeDay(p.anchor, t.clientX - start.current.x, t.clientY - start.current.y, 7)); start.current = null }}>
      {days.map((day, i) => <button type="button" key={day} className="cal-phone-button cal-phone-weekday" aria-label={rangeLabel('day', day, p.pt)} aria-pressed={day === p.anchor} aria-current={day === today ? 'date' : undefined} onClick={() => p.onDay(day)}><small>{dowShort(i, p.pt).slice(0, 1)}</small><span>{Number(day.slice(8))}</span></button>)}
    </div>
    {!p.ready ? p.body : p.view === 'month' ? month : p.view === 'schedule' || p.view === 'agenda' ? p.body : <MobileDayGrid {...p} onOpenDay={openDay} span={p.view === 'week' ? 7 : p.view === 'three' ? 3 : 1} />}
    {sheet && <CalendarSheet title={pick(sheet === 'filters' ? TEXT.filters : TEXT.title, p.pt)} closeLabel={pick(TEXT.close, p.pt)} onClose={() => setSheet(null)}>
      {sheet === 'filters' ? p.filters : <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><button className="cal-phone-button" type="button" aria-label={pick(TEXT.prev, p.pt)} onClick={() => p.onDay(addMonths(p.anchor, -1))}><ChevronLeft size={18} /></button><b>{rangeLabel('month', p.anchor, p.pt)}</b><button className="cal-phone-button" type="button" aria-label={pick(TEXT.next, p.pt)} onClick={() => p.onDay(addMonths(p.anchor, 1))}><ChevronRight size={18} /></button></div>
        {month}
        {(['day', 'three', 'week', 'month', 'schedule', 'agenda'] as const).map(v => <button key={v} type="button" className="cal-phone-button" aria-pressed={p.view === v} style={{ width: '100%' }} onClick={() => { p.onView(v); setSheet(null) }}>{pick(v === 'three' ? TEXT.threeDays : VIEW_LABEL[v], p.pt)}</button>)}
        <button type="button" className="cal-phone-button" onClick={p.exportIcs}>{pick(TEXT.exportIcs, p.pt)}</button>
      </>}
    </CalendarSheet>}
  </div>
}
