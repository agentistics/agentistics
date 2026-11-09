/**
 * DeliveryCalendar — the "Calendário de entregas" screen (BETA): next releases as cards, then Month / Week / Day /
 * Schedule (and, on a phone, an Agenda list). It reads ONE calendar (`useDeliveryCalendar`) and filters it with core's
 * `filterCalendar` — the same function `agentistics_delivery_calendar` and `agentop flow calendario` call — so what an
 * agent is told and what this shows can never differ. Default filter: the tasks being worked on now. It offers no
 * action on a delivery (the card, its session and its verbs live on the Live line; a detail panel leads there).
 */
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { brtDay, brtDayStartMs, filterCalendar, HARNESS_LABELS, type CalMark } from '@agentistics/core'
import { BetaTag } from '../BetaTag'
import { CenteredLoader } from '../CenteredLoader'
import { SegmentedTabs } from '../nav/SegmentedTabs'
import { useIsMobile } from '../../hooks/useIsMobile'
import { addDays, rangeLabel, stepAnchor, viewWindow, weekDays, type CalView } from '../../lib/calendarModel'
import { dialogButtonStyle } from '../../pages/settings/primitives'
import { STAGE_LABEL } from '../tasks/liveDeliveryModel'
import { AgendaView } from './AgendaView'
import { CalendarDetail, type Anchor, type CalSelection } from './CalendarDetail'
import { CalendarFilters, readCalendarFilters, toCalFilters, type UiFilters } from './CalendarFilters'
import { TEXT, VIEW_LABEL, pick } from './calendarText'
import { DayView } from './DayView'
import { MonthView } from './MonthView'
import { ScheduleView } from './ScheduleView'
import { useDeliveryCalendar } from './useDeliveryCalendar'
import { useFitHeight } from './useFitHeight'
import { VersionCards } from './VersionCards'
import { hasRealVersions } from '../../lib/versionVisibility'
import { MobileCalendar, type PhoneView } from './MobileCalendar'

const DESKTOP_VIEWS: CalView[] = ['month', 'week', 'day', 'schedule']
const MOBILE_VIEWS: CalView[] = ['day', 'agenda', 'week', 'month', 'schedule']

/** The query the .ics export of the CURRENT filtered view asks the route for. */
export function icsQuery(f: UiFilters, win: { fromMs: number; toMs: number }): string {
  const q = new URLSearchParams({ format: 'ics', from: new Date(win.fromMs).toISOString(), to: new Date(win.toMs).toISOString() })
  if (f.tasks === 'all') q.set('all', '1')
  if (f.tasks.startsWith('task:')) { q.set('all', '1'); q.set('task', f.tasks.slice(5)) }
  if (f.versions.length) q.set('version', f.versions.join(','))
  if (f.stages.length) q.set('stage', f.stages.join(','))
  if (f.harnesses.length) q.set('harness', f.harnesses.join(','))
  if (f.priorities.length) q.set('priority', f.priorities.join(','))
  if (f.confirmedOnly) q.set('confirmed', '1')
  return q.toString()
}

export function DeliveryCalendar({ lang }: { lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const { reply, error, nowMs, reload } = useDeliveryCalendar()
  const [query, setQuery] = useSearchParams()
  const phoneView = (['day', 'three', 'week', 'month', 'schedule', 'agenda'].includes(query.get('calView') ?? '') ? query.get('calView') : 'day') as PhoneView
  const [desktopView, setView] = useState<CalView>('month')
  const view: CalView = isMobile ? phoneView === 'three' ? 'day' : phoneView : desktopView
  const dateParam = query.get('calDay') ?? ''
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) && Number.isFinite(Date.parse(`${dateParam}T03:00:00Z`)) && brtDay(Date.parse(`${dateParam}T03:00:00Z`)) === dateParam ? dateParam : brtDay(Date.now())
  const setAnchor = (next: string | ((day: string) => string)) => setQuery(q => { q.set('calDay', typeof next === 'function' ? next(anchor) : next); return q }, { replace: true })
  const filters = useMemo(() => readCalendarFilters(query.get('calFilters')), [query])
  const setFilters = (f: UiFilters) => setQuery(q => { q.set('calFilters', JSON.stringify(f)); return q }, { replace: true })
  const [sel, setSel] = useState<CalSelection | null>(null)
  const [point, setPoint] = useState<Anchor | null>(null)
  const { ref, height } = useFitHeight<HTMLDivElement>(isMobile ? 0 : 520, isMobile)
  const today = brtDay(nowMs)

  const shown = useMemo(() => (reply ? filterCalendar(reply, toCalFilters(filters)) : null), [reply, filters])
  const open = useCallback((s: CalSelection, e?: React.MouseEvent) => { setSel(s); setPoint(e ? { x: e.clientX, y: e.clientY } : null) }, [])
  const close = useCallback(() => setSel(null), [])
  const activeView: CalView = isMobile && !MOBILE_VIEWS.includes(view) ? 'agenda' : !isMobile && view === 'agenda' ? 'month' : view
  const go = (v: CalView) => { setView(v); setSel(null) }
  const step = (dir: -1 | 1) => { setAnchor(a => stepAnchor(activeView === 'agenda' ? 'day' : activeView, a, dir)); setSel(null) }
  const harnessOf = (id: string) => (HARNESS_LABELS as Record<string, string>)[id] ?? id
  // ONE rule (lib/versionVisibility): no real release version for this person = no version filter, count or strip.
  const realVersions = hasRealVersions(reply?.versions)
  const versionList = useMemo(() => (reply ? reply.versions.map(v => v.version) : []), [reply])

  const exportIcs = () => {
    const a = document.createElement('a')
    const win = viewWindow(activeView === 'agenda' ? 'day' : activeView, anchor)
    if (isMobile && phoneView === 'three') win.toMs = brtDayStartMs(addDays(anchor, 3)) - 1
    a.href = `/api/deliveries/calendar?${icsQuery(filters, win)}`
    a.download = 'entregas.ics'
    a.click()
  }

  const handlers = {
    onOpenPiece: (key: string, e: React.MouseEvent) => open({ kind: 'piece', key }, e),
    onOpenVersion: (version: string, e: React.MouseEvent) => open({ kind: 'version', version }, e),
    onOpenMark: (mark: CalMark, e: React.MouseEvent) => open({ kind: 'mark', mark }, e),
  }
  const selectedId = sel?.kind === 'piece' ? sel.key : sel?.kind === 'version' ? sel.version : null

  const caption = shown ? `${pick(TEXT.pieces(shown.pieces.length), pt)} ${realVersions ? ` · ${pick(TEXT.versions(shown.versions.length), pt)}` : ''} · BRT` : ''
  const empty = shown !== null && shown.pieces.length === 0 && shown.versions.length === 0 && shown.marks.length === 0

  const tabs = (isMobile ? MOBILE_VIEWS : DESKTOP_VIEWS).map(id => ({ id, label: pick(VIEW_LABEL[id], pt) }))
  const tapIcon = isMobile ? 'ag-tap-icon' : undefined
  const navBtn: React.CSSProperties = {
    // A phone's 44px target is PROJECTED by `.ag-tap-icon` (an invisible box), never painted.
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 32, height: 32, padding: '0 6px', position: 'relative',
    background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', cursor: 'pointer', font: 'inherit', fontSize: 12,
  }

  const body = (() => {
    if (!reply || !shown) return null
    if (empty && !isMobile) return (
      <div data-cal-empty style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, color: 'var(--text-secondary)', textAlign: 'center', padding: 24 }}>
        <b style={{ color: 'var(--text-primary)' }}>{pick(reply.pieces.length === 0 && reply.versions.length === 0 ? TEXT.emptyAll : TEXT.emptyTitle, pt)}</b>
        <span style={{ fontSize: 12 }}>{pick(TEXT.emptyHint, pt)}</span>
      </div>
    )
    const common = { nowMs, versions: shown.versions, pieces: shown.pieces, marks: shown.marks, pt, selected: selectedId }
    switch (activeView) {
      case 'month': return <MonthView {...common} anchor={anchor} onPickDay={d => { setAnchor(d); setView(isMobile ? 'agenda' : 'day'); setSel(null) }} onOpenVersion={handlers.onOpenVersion} onOpenMark={handlers.onOpenMark} onOpenPiece={handlers.onOpenPiece} />
      case 'schedule': return <ScheduleView {...common} anchor={anchor} {...handlers} mobile={isMobile} />
      case 'day': return <DayView {...common} day={anchor} {...handlers} />
      case 'week': return isMobile
        ? <AgendaView {...common} mode="agenda" anchor={weekDays(anchor)[0]!} span={7} {...handlers} />
        : <AgendaView {...common} mode="week" anchor={anchor} {...handlers} />
      default: return <AgendaView {...common} mode="agenda" anchor={anchor} {...handlers} />
    }
  })()

  if (isMobile) return <div ref={ref} data-cal-root style={{ height: height ?? undefined, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <MobileCalendar anchor={anchor} onDay={d => { setAnchor(d); setSel(null) }} view={phoneView} onView={v => { setQuery(q => { q.set('calView', v); return q }, { replace: true }); setSel(null) }}
      // Opening a day is ONE URL change (day + view together, two setQuery calls race and lose the day) and it is
      // PUSHED, not replaced, so the phone's Back returns to the Week/3-days it came from.
      onOpenDay={d => { setQuery(q => { q.set('calDay', d); q.set('calView', 'day'); return q }); setSel(null) }}
      nowMs={nowMs} pt={pt} versions={shown?.versions ?? []} pieces={shown?.pieces ?? []} marks={shown?.marks ?? []} onOpen={open} ready={!!shown}
      filterCount={Number(filters.tasks !== 'active') + filters.versions.length + filters.stages.length + filters.harnesses.length + filters.priorities.length + Number(filters.confirmedOnly)}
      exportIcs={exportIcs} filters={reply && <CalendarFilters value={filters} onChange={setFilters} pieces={reply.pieces} harnessOf={harnessOf} versionList={versionList} showVersions={realVersions} pt={pt} mobile={false} shown={caption} />}
      body={shown ? body : error ? <div role="alert" style={{ padding: 20 }}><p>{pick(TEXT.loadError, pt)}</p><button className="cal-phone-button" type="button" onClick={() => void reload()}>{pick(TEXT.retry, pt)}</button></div> : <CenteredLoader placement="area" />} />
    {sel && reply && shown && <CalendarDetail selection={sel} anchor={point} pieces={reply.pieces} versions={reply.versions} marks={reply.marks} nowMs={nowMs} pt={pt} isMobile onClose={close} onSelect={setSel} />}
  </div>

  return (
    <div ref={ref} data-cal-root style={{ height: height ?? undefined, minHeight: 0, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {/* Desktop is exactly TWO rows, the same in every engine: this one (title, views, navigation, export — never
          wrapping, the date range gives way with an ellipsis) and the filters row below it. */}
      <div data-cal-nav style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap', paddingBottom: 8, flexShrink: 0, minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: isMobile ? 17 : 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, whiteSpace: isMobile ? 'normal' : 'nowrap', marginRight: 4, flex: isMobile ? '1 1 0' : '0 0 auto', minWidth: 0 }}>
          <CalendarDays size={17} aria-hidden style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
          <span title={pick(TEXT.title, pt)}>{pick(TEXT.titleShort, pt)}</span><BetaTag what={pick(TEXT.beta, pt)} lang={lang} />
        </h1>
        {!isMobile && <div data-cal-view-tabs style={{ flexShrink: 0, width: 350, ['--mode-min-height' as string]: '24px' }}><SegmentedTabs tabs={tabs} value={activeView} onChange={go} ariaLabel={pick(TEXT.title, pt)} containerName="cal-views" /></div>}
        <button type="button" data-cal-today onClick={() => { setAnchor(brtDay(Date.now())); setSel(null) }} className={isMobile ? 'ag-tap' : undefined} style={navBtn}>{pick(TEXT.today, pt)}</button>
        {!isMobile && <>
          <button type="button" aria-label={pick(TEXT.prev, pt)} onClick={() => step(-1)} className={tapIcon} style={navBtn}><ChevronLeft size={15} /></button>
          <button type="button" aria-label={pick(TEXT.next, pt)} onClick={() => step(1)} className={tapIcon} style={navBtn}><ChevronRight size={15} /></button>
          <span data-cal-range style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{rangeLabel(activeView, anchor, pt)}</span>
        </>}
        {!isMobile && <span style={{ flex: 1 }} />}
        <button type="button" data-cal-export onClick={exportIcs} aria-label={pick(TEXT.exportIcs, pt)} title={pick(TEXT.exportIcs, pt)} className={tapIcon} style={navBtn}>
          <Download size={14} aria-hidden />
        </button>
      </div>
      {isMobile && (
        <div style={{ paddingBottom: 8, flexShrink: 0 }}>
          <SegmentedTabs tabs={tabs} value={activeView} onChange={go} ariaLabel={pick(TEXT.title, pt)} equal containerName="cal-views" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button type="button" aria-label={pick(TEXT.prev, pt)} onClick={() => step(-1)} className={tapIcon} style={navBtn}><ChevronLeft size={15} /></button>
            <span data-cal-range style={{ flex: 1, textAlign: 'center', fontSize: 13.5, fontWeight: 600 }}>{rangeLabel(activeView === 'agenda' ? 'day' : activeView, anchor, pt)}</span>
            <button type="button" aria-label={pick(TEXT.next, pt)} onClick={() => step(1)} className={tapIcon} style={navBtn}><ChevronRight size={15} /></button>
          </div>
        </div>
      )}

      {reply && shown ? (
        <>
          <CalendarFilters value={filters} onChange={f => { setFilters(f); setSel(null) }} pieces={reply.pieces} harnessOf={harnessOf} versionList={versionList} showVersions={realVersions} pt={pt} mobile={isMobile} shown={caption} />
          {realVersions && !isMobile && (activeView === 'month' || activeView === 'week') && <VersionCards versions={shown.versions} nowMs={nowMs} pt={pt} selected={sel?.kind === 'version' ? sel.version : null} onOpen={(v, e) => open({ kind: 'version', version: v.version }, e)} />}
          {body}
          {!isMobile && (
            <div data-cal-legend style={{ display: 'flex', flexWrap: 'wrap', columnGap: 14, rowGap: 2, alignItems: 'center', minHeight: 30, padding: '4px 0', flexShrink: 0, color: 'var(--text-secondary)', fontSize: 11 }}>
              {(['queue', 'blocked', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'published'] as const).map(s => (
                <span key={s}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 5, background: STAGE_LABEL[s].color }} />{pt ? STAGE_LABEL[s].pt : STAGE_LABEL[s].en}</span>
              ))}
              <span style={{ marginLeft: 'auto', color: 'var(--accent-green)', whiteSpace: 'nowrap' }}>◆ {pick(TEXT.legendPublished, pt)}</span>
              <span style={{ color: 'var(--text-tertiary)' }}>{pick(TEXT.legendExpected, pt)}</span>
            </div>
          )}
        </>
      ) : error ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-secondary)' }}>
          <span>{pick(TEXT.loadError, pt)}</span>
          <button type="button" onClick={() => void reload()} style={dialogButtonStyle('secondary', isMobile)}>{pick(TEXT.retry, pt)}</button>
        </div>
      ) : <CenteredLoader placement="area" />}

      {sel && reply && shown && (
        <CalendarDetail selection={sel} anchor={point} pieces={reply.pieces} versions={reply.versions} marks={reply.marks}
          nowMs={nowMs} pt={pt} isMobile={isMobile} onClose={close} onSelect={s => setSel(s)} />
      )}
    </div>
  )
}
