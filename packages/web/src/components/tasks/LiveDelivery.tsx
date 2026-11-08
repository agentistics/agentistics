/**
 * LiveDelivery — the REAL-TIME line of deliveries: one column per stage, one card per active piece
 * of work (a subtask with an agent alive, or one sitting at a gate).
 *
 * The main board shows a TASK as a whole; this shows where each DELIVERY is right now and for how
 * long. Everything on a card is either read from the book or from the fleet, and an estimate always
 * says what it was computed from — "sem estimativa" is a legitimate answer, a made-up number is not.
 *
 * Desktop never scrolls vertically (owner, 06/11): the board fills the height it is given, each column
 * shows the cards that fit plus a "+N" that flows the rest into extra sub-columns — growth is
 * horizontal, under the one orange scroll bar. Mobile: ONE stage at a time (the chips above it), same
 * cards, 44px targets — the same shape as the board's `MobileLane`.
 *
 * The cards are `LiveCardView` (option A); the leaders are `LiveLeaders`; every rule they follow is
 * in `liveCardModel` / `liveDeliveryModel`, so this file lays out and wires, it does not decide.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { plainLeaderName, shortTitle } from '@agentistics/core'
import { CenteredLoader } from '../CenteredLoader'
import { useFleet, type FleetRow } from '../../lib/fleet'
import { useIsMobile } from '../../hooks/useIsMobile'
import { usePlanLimits } from '../../lib/planLimits'
import { pathOfView } from '../../lib/tasksViewRoute'
import { fitHeight, holdPageFit, reserveBelow } from '../../lib/pageFit'
import { button, microLabel, surface } from './board'
import {
  LIVE_STAGES, orderColumns, STAGE_LABEL, byStage, filterCards, fmtClock, fmtSpan, joinLive, summarize,
  type StageFilter, type LiveCard, type LiveReply, type LiveStage,
} from './liveDeliveryModel'
import {
  columnCollapsed, GONE_LINGER_MS, locateWorker, revealScrollLeft, stageBar, mergeGone, planDepartures, readCollapsedPrefs, readViewPrefs, sinceWord,
  snapshotOf, taskOfSession, taskOptions, writeCollapsedPrefs, writeViewPrefs, type CollapsedPrefs, type BoardSnapshot, type Gone, type LocateAnswer,
} from './liveCardModel'
import type { LiveSortId } from '@agentistics/core'
import { LiveCardView } from './LiveCardView'
import { LiveApprove } from './LiveApprove'
import { LiveAntigas } from './LiveAntigas'
import { LiveQueuePriority } from './LiveQueuePriority'
import { LiveColumn } from './LiveColumn'
import { LiveLeaders } from './LiveLeaders'
import type { LeaderWorker } from './liveDeliveryModel'
import { LiveTaskFilter } from './LiveTaskFilter'
import { dayLabel, groupHistory } from './liveHistoryModel'
import { sessionLinks } from './liveSessionLinks'
import { LiveToolbar } from './LiveToolbar'
import { requestPipWindow } from './livePip'
import { registerPip, usePip } from './livePipStore'
import { useLiveDeliveries } from './useLiveDeliveries'
import { flashHeader, flyCard, intersects, recolorBar, ring, transitionKind, type Box } from './liveDeliveryFx'

const HISTORY_COLOR = '#6b7280'
const reducedMotion = (): boolean => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

/** Every word the Live draws, in both languages — nothing on this screen is written inline in a component. */
export const copy = (pt: boolean) => pt ? {
  title: 'Esteira de entregas ao vivo',
  deliveries: (n: number) => `${n} ${n === 1 ? 'entrega ativa' : 'entregas ativas'}`,
  agents: (n: number) => `${n} ${n === 1 ? 'agente trabalhando' : 'agentes trabalhando'}`,
  next: (t: string) => `próxima entrega prevista ${t}`, noNext: 'sem entrega com estimativa',
  live: 'atualizado ao vivo', empty: 'Nada nesta etapa',
  down: 'Não consegui ler as entregas agora.', refused: 'O quadro não está disponível neste perfil.',
  loading: 'Carregando entregas…', none: 'Nenhuma entrega ativa agora.',
  delivered: 'publicado', allSteps: 'Todas as etapas', external: 'Janela externa', externalTip: 'Abrir a esteira numa janela externa', externalBlocked: 'O navegador bloqueou a janela externa.',
  collapse: 'Recolher coluna', expand: 'Abrir coluna',
  history: 'Histórico', publishedNote: 'Os cartões ficam 24 h aqui; depois vão para o Histórico.',
  searchColumn: 'Buscar nesta coluna…', noMatch: 'Nenhum cartão corresponde.', clearSearch: 'Limpar',
  archivedBtn: (n: number) => `Antigas sem registro · ${n}`, archivedNote: 'Em revisão há mais de 24 h, sem sessão viva e sem prova de publicação — saíram da coluna “Revisão do líder”.', archivedMore: (n: number) => `e mais ${n}`,
  left: 'saiu', recentLeft: (n: number) => `saíram há pouco (${n})`, noneLeft: 'Ninguém saiu do quadro nos últimos minutos.',
} : {
  title: 'Live Delivery',
  deliveries: (n: number) => `${n} active ${n === 1 ? 'delivery' : 'deliveries'}`,
  agents: (n: number) => `${n} ${n === 1 ? 'agent working' : 'agents working'}`,
  next: (t: string) => `next delivery expected ${t}`, noNext: 'no delivery has an estimate',
  live: 'updated live', empty: 'Nothing in this stage',
  down: 'Could not read the deliveries right now.', refused: 'The board is not available on this profile.',
  loading: 'Loading deliveries…', none: 'No active delivery right now.',
  delivered: 'published', allSteps: 'All steps', external: 'External window', externalTip: 'Open the line in an external window', externalBlocked: 'The browser blocked the external window.',
  collapse: 'Collapse column', expand: 'Open column',
  history: 'History', publishedNote: 'Cards stay here for 24 h, then move to History.',
  searchColumn: 'Search this column…', noMatch: 'No card matches.', clearSearch: 'Clear',
  archivedBtn: (n: number) => `Old, no record · ${n}`, archivedNote: 'In review for over 24 h, no live session and no proof of release — they left the “Leader review” column.', archivedMore: (n: number) => `and ${n} more`,
  left: 'left', recentLeft: (n: number) => `left recently (${n})`, noneLeft: 'Nothing left the board in the last minutes.',
}

/** The hooks wrapper: the shared fleet stream, the plan-limits account labels and the live read model. */
export function LiveDelivery({ lang, compact, focusSessionId, inPip, initialTaskIds }: { lang: 'pt' | 'en'; compact?: boolean; focusSessionId?: string | null; inPip?: boolean; initialTaskIds?: readonly string[] }) {
  const { fleet } = useFleet(lang)
  const plan = usePlanLimits()
  const { reply, error, nowMs } = useLiveDeliveries(fleet.sessions)
  return <LiveDeliveryView lang={lang} reply={reply} error={error} nowMs={nowMs} fleet={fleet.sessions} accountLabels={plan.accountLabels} compact={compact} focusSessionId={focusSessionId} inPip={inPip} initialTaskIds={initialTaskIds} />
}

export interface LiveDeliveryViewProps {
  /** The shortcut popover/sheet: no leaders band, the board takes the room it is given. */
  compact?: boolean
  lang: 'pt' | 'en'
  reply: LiveReply | null
  error: 'down' | 'refused' | null
  nowMs: number
  fleet: readonly FleetRow[]
  accountLabels: Record<string, string>
  /** Opened from this session: the board starts filtered by ITS task (removable like any chip). */
  focusSessionId?: string | null
  /** The tasks to start with (a window opened from another Live carries its filter along). */
  initialTaskIds?: readonly string[]
  /** Rendered inside the external window: no button to open another, fills that window. */
  inPip?: boolean
}

/** PURE of data sources: everything it draws comes in as props, so it is tested without mocking a store. */
export function LiveDeliveryView({ lang, reply, error, nowMs, fleet, accountLabels, compact, focusSessionId, initialTaskIds, inPip }: LiveDeliveryViewProps) {
  const pt = lang === 'pt'
  const L = copy(pt)
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const [taskIds, setTaskIds] = useState<readonly string[]>(initialTaskIds ?? [])
  // The filter bar's switches and the sort are saved like the column preferences (this browser).
  const [view, setView] = useState(() => readViewPrefs())
  const { onlyActive, showQueue, sort } = view
  const setViewPref = useCallback((patch: Partial<typeof view>) => setView(v => { const n = { ...v, ...patch }; writeViewPrefs(n); return n }), [])
  const [stageFilter, setStageFilter] = useState<StageFilter>('all')
  const [prefs, setPrefs] = useState<CollapsedPrefs>(() => readCollapsedPrefs())
  // Each column's own search text (the field appears when more than three cards are out of view).
  const [queries, setQueries] = useState<Partial<Record<LiveStage, string>>>({})
  const [openPub, setOpenPub] = useState<ReadonlySet<string>>(new Set())
  const [pipNote, setPipNote] = useState(false)
  const [gone, setGone] = useState<Gone[]>([])
  const [showGone, setShowGone] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [clock, setClock] = useState(() => Date.now())

  const cards = useMemo(() => joinLive(reply?.deliveries ?? [], fleet), [reply, fleet])
  const shown = useMemo(() => filterCards(cards, { taskIds, onlyActive, showQueue }), [cards, taskIds, onlyActive, showQueue])
  const columns = useMemo(() => orderColumns(byStage(shown), sort), [shown, sort])
  // The Histórico column: pieces published more than 24 h ago. ALWAYS closed when the screen opens (not saved), opens on click.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const historyCards = useMemo(
    () => joinLive(reply?.history ?? [], fleet).filter(c => taskIds.length === 0 || taskIds.includes(c.d.taskId)),
    [reply, fleet, taskIds],
  )
  const visibleStages = stageFilter === 'all' ? LIVE_STAGES : LIVE_STAGES.filter(s => s === stageFilter)
  const sum = useMemo(() => summarize(shown, nowMs), [shown, nowMs])
  const options = useMemo(() => taskOptions(cards, nowMs), [cards, nowMs])
  const leaders = reply?.leaders ?? []
  const leaderIds = useMemo(() => new Set(leaders.map(l => l.id)), [leaders])

  // Opened from a session -> filtered by ITS task (a worker's piece, a leader's filing). Once per session.
  const appliedFocus = useRef<string | null>(null)
  useEffect(() => {
    if (!focusSessionId || !reply || appliedFocus.current === focusSessionId) return
    appliedFocus.current = focusSessionId
    const t = taskOfSession(focusSessionId, { sessionTasks: reply.sessionTasks, cards, leaders })
    if (t) setTaskIds([t])
  }, [focusSessionId, reply, cards, leaders])

  // Nothing leaves the board without a word: diff the board against its last self.
  const snap = useRef<BoardSnapshot | null>(null)
  const filterSig = `${taskIds.join(',')}|${onlyActive}|${showQueue}`
  useEffect(() => {
    if (!reply) return
    const next = snapshotOf(shown, leaders, filterSig)
    const departed = planDepartures(snap.current, next, {
      allKeys: new Set(cards.map(c => c.d.key)), hidden: reply.hidden ?? [], leaderIdsNow: leaderIds, nowMs: Date.now(), pt,
    })
    snap.current = next
    if (departed.length) setGone(g => mergeGone(g, departed, Date.now()))
  }, [reply, shown, leaders, cards, filterSig, leaderIds, pt])
  useEffect(() => {
    if (gone.length === 0) return
    const t = setInterval(() => { const n = Date.now(); setClock(n); setGone(g => mergeGone(g, [], n)) }, 1000)
    return () => clearInterval(t)
  }, [gone.length])

  const seen = useRef(new Map<string, { stage: LiveStage; box: Box }>())
  const boardRef = useRef<HTMLDivElement>(null)
  const chipRowRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [fitH, setFitH] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (compact || isMobile) return
    const measure = () => {
      const el = wrapRef.current
      if (!el) return
      const win = el.ownerDocument.defaultView ?? window
      // Inside the app the board fills what is LEFT of the page's own scroller (HIGH 1: measuring against the
      // window ignored the footer and the panel frame, so the page scrolled 380 px). In an external window
      // there is no scroller and the window is the box.
      const scroller = el.closest<HTMLElement>('[data-page-scroller]')
      const top = el.getBoundingClientRect().top
      if (scroller) {
        // Everything BELOW the board inside the scroller: each ancestor's bottom padding and border (the panel frame's 18 px AND the page's 24 px — measuring only the outer one left the page 17 px over).
        const ancestors: CSSStyleDeclaration[] = []
        for (let a = el.parentElement; a && a !== scroller; a = a.parentElement) ancestors.push(getComputedStyle(a))
        const reserve = reserveBelow(ancestors)
        setFitH(fitHeight({ scrollerBottom: scroller.getBoundingClientRect().bottom, boardTop: top, reserve, min: 360 }))
      } else {
        setFitH(fitHeight({ scrollerBottom: win.innerHeight / (Number(getComputedStyle(win.document.documentElement).getPropertyValue('--ui-zoom')) || 1), boardTop: top, reserve: 16, min: 420 }))
      }
    }
    measure()
    const scroller = wrapRef.current?.closest<HTMLElement>('[data-page-scroller]')
    const ro = typeof ResizeObserver !== 'undefined' && scroller ? new ResizeObserver(measure) : null
    if (scroller) { ro?.observe(scroller); if (scroller.firstElementChild) ro?.observe(scroller.firstElementChild) }
    const release = scroller ? holdPageFit() : () => {}
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); release() }
  }, [compact, isMobile, reply === null])
  useEffect(() => {
    const el = chipRowRef.current?.querySelector<HTMLElement>(`[data-chip="${stageFilter}"]`)
    el?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [stageFilter])
  useLayoutEffect(() => {
    const root = boardRef.current
    if (!root) return
    const now = new Map<string, { stage: LiveStage; box: Box }>()
    const firstPaint = seen.current.size === 0
    const rv = root.getBoundingClientRect()
    const view: Box = { left: rv.left, top: rv.top, width: rv.width, height: rv.height }
    const cardEls = Array.from(root.querySelectorAll<HTMLElement>('[data-live-card]'))
    const rect = (el: HTMLElement): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } }
    // Pass 1 — every scroll-into-view of the pass happens BEFORE any destination is measured, so no
    // card is aimed at a spot a later scroll moves. The remembered origins were measured at the old
    // scrollLeft, so they are shifted by the total scroll below.
    const startLeft = root.scrollLeft
    if (!firstPaint && root.scrollWidth > root.clientWidth) {
      for (const el of cardEls) {
        const prev = seen.current.get(el.getAttribute('data-live-card')!)
        const stage = el.getAttribute('data-stage') as LiveStage
        if (!prev || transitionKind(prev.stage, stage) === 'none') continue
        if (intersects(rect(el), view)) continue
        // The destination column is off-screen (a narrow window): bring it into view.
        const col = root.querySelector<HTMLElement>(`[data-live-column="${stage}"]`)
        if (!col) continue
        const c = col.getBoundingClientRect()
        root.scrollLeft = root.scrollLeft + (c.left - view.left) - Math.max(0, (view.width - c.width) / 2)
      }
    }
    const moved = root.scrollLeft - startLeft
    // Pass 2 — measure everything at the final scroll, then launch the flights.
    const flights: Array<() => void> = []
    for (const el of cardEls) {
      const key = el.getAttribute('data-live-card')!
      const stage = el.getAttribute('data-stage') as LiveStage
      const r = rect(el)
      const prev = seen.current.get(key)
      now.set(key, { stage, box: r })
      if (firstPaint || !prev) continue
      const kind = transitionKind(prev.stage, stage)
      if (kind === 'none' || r.width === 0) continue
      // Out of sight at either end: no ghost over unrelated screen.
      if (!intersects(r, view)) continue
      // A card scrolled out of its OWN column is out of sight too (columns scroll on their own).
      const body = el.closest<HTMLElement>('[data-live-colbody]')
      if (body) { const b = body.getBoundingClientRect(); if (!intersects(r, { left: b.left, top: b.top, width: b.width, height: b.height })) continue }
      const from = { ...prev.box, left: prev.box.left - moved }
      flights.push(() => {
        el.style.opacity = '0'
        const prevBar = stageBar(prev.stage, null).map(x => x.color)
        const back = () => { el.style.opacity = ''; ring(el, STAGE_LABEL[stage].color); recolorBar(el, prevBar) }
        void flyCard(el, from, { fromColor: STAGE_LABEL[prev.stage].color, toColor: STAGE_LABEL[stage].color }).then(back, back)
      })
    }
    for (const f of flights) f()
    seen.current = now
  })


  // A card that moved into a COLLAPSED column has no element to land: its header flashes in the arriving colour instead.
  const stageOf = useRef(new Map<string, LiveStage>())
  useEffect(() => {
    const root = boardRef.current
    const nextMap = new Map<string, LiveStage>()
    for (const c of shown) {
      nextMap.set(c.d.key, c.d.stage)
      const was = stageOf.current.get(c.d.key)
      if (!root || was === undefined || was === c.d.stage) continue
      if (root.querySelector(`[data-live-card="${CSS.escape(c.d.key)}"]`)) continue
      flashHeader(root.querySelector<HTMLElement>(`[data-live-column="${c.d.stage}"] [data-live-colhead]`), STAGE_LABEL[c.d.stage].color)
    }
    stageOf.current = nextMap
  }, [shown])
  // "← veio de <coluna> · agora": the card that moved says where it came from, for a few seconds.
  const [moved, setMoved] = useState<Record<string, { from: LiveStage; atMs: number }>>({})
  const prevStage = useRef(new Map<string, LiveStage>())
  useEffect(() => {
    const next = new Map<string, LiveStage>()
    const fresh: Record<string, { from: LiveStage; atMs: number }> = {}
    for (const c of shown) {
      next.set(c.d.key, c.d.stage)
      const was = prevStage.current.get(c.d.key)
      if (was !== undefined && was !== c.d.stage) fresh[c.d.key] = { from: was, atMs: Date.now() }
    }
    prevStage.current = next
    if (Object.keys(fresh).length === 0) return
    setMoved(m => ({ ...m, ...fresh }))
    const t = setTimeout(() => setMoved(m => {
      const n = { ...m }
      for (const k of Object.keys(fresh)) if (n[k]?.atMs === fresh[k]!.atMs) delete n[k]
      return n
    }), 5200)
    return () => clearTimeout(t)
  }, [shown])

  // A worker row in the Líderes dropdown: open its column, bring its card into view, outline it for ~2 s.
  const [locateReq, setLocateReq] = useState<{ key: string; stage: LiveStage; n: number } | null>(null)
  const requestLocate = useCallback((a: Extract<LocateAnswer, { kind: 'card' }>) => {
    setStageFilter(f => (f === 'all' || f === a.stage ? f : 'all'))
    setPrefs(p => { if (p[a.stage] === false) return p; const n = { ...p, [a.stage]: false }; writeCollapsedPrefs(n); return n })
    // A search typed in that column would hide the very card being looked for.
    setQueries(q => (q[a.stage] ? { ...q, [a.stage]: '' } : q))
    setLocateReq(r => ({ key: a.key, stage: a.stage, n: (r?.n ?? 0) + 1 }))
  }, [])
  useEffect(() => {
    if (!locateReq) return
    const root = boardRef.current
    let frames = 0, raf = 0
    const tryFind = () => {
      const el = root?.querySelector<HTMLElement>(`[data-live-card="${CSS.escape(locateReq.key)}"]`)
      if (el) {
        // Two scrollers, neither of them the page: the column's own (vertical) and the board's (horizontal) — the page must not move (QA MED 6, HIGH 1).
        const body = el.closest<HTMLElement>('[data-live-colbody]')
        if (body) {
          const b = body.getBoundingClientRect(), c = el.getBoundingClientRect()
          if (c.top < b.top || c.bottom > b.bottom) body.scrollTo?.({ top: Math.max(0, body.scrollTop + (c.top - b.top) - Math.max(0, (b.height - c.height) / 2)), behavior: reducedMotion() ? 'auto' : 'smooth' })
        }
        if (root) {
          const v = root.getBoundingClientRect(), c = el.getBoundingClientRect()
          root.scrollTo?.({ left: revealScrollLeft({ scrollLeft: root.scrollLeft, viewLeft: v.left, viewWidth: v.width, cardLeft: c.left, cardWidth: c.width, scrollWidth: root.scrollWidth }), behavior: reducedMotion() ? 'auto' : 'smooth' })
        }
        ring(el, 'var(--accent-purple)', 2000)
        return
      }
      if (frames++ < 40) raf = requestAnimationFrame(tryFind)
    }
    raf = requestAnimationFrame(tryFind)
    return () => cancelAnimationFrame(raf)
  }, [locateReq])

  // The window belongs to `livePipStore` (and is drawn by `LivePipHost`), never to this component: this one
  // unmounts when the popover closes or the route changes, and used to take the window with it.
  const pip = usePip()
  const openExternal = useCallback(async () => {
    const r = await requestPipWindow({ width: 540, height: 680, fallbackUrl: `${window.location.origin}${pathOfView('live')}` })
    if (r.kind === 'pip') registerPip(r.win, taskIds)
    else if (r.kind === 'blocked') setPipNote(true)
  }, [taskIds])

  if (error === 'refused') return <Note text={L.refused} />
  if (reply === null && error !== 'down') return <CenteredLoader size={40} label={L.loading} testId="agentask-live-loading" />
  if (reply === null) return <Note text={L.down} />

  const open = (c: LiveCard) => {
    const id = c.agents[0]?.id ?? c.d.sessionIds[0]
    if (inPip) { try { window.focus() } catch { /* not allowed */ } }
    navigate(id ? `/sessions/${encodeURIComponent(id)}` : `/tasks/${encodeURIComponent(c.d.taskId)}`)
  }
  const leaderOf = (c: LiveCard): string | null => {
    const ids = new Set([...c.agents.map(a => a.id), ...c.d.sessionIds])
    const l = leaders.find(x => x.workers.some(w => ids.has(w.id)))
    return l ? plainLeaderName(l.title) : null
  }
  const roleOf = (c: LiveCard): 'leader' | 'worker' => (c.agents.some(a => leaderIds.has(a.id)) ? 'leader' : 'worker')
  const openSession = (id: string) => {
    // From the external window the main window is where the session opens: bring it forward.
    if (inPip) { try { window.focus() } catch { /* not allowed */ } }
    navigate(`/sessions/${encodeURIComponent(id)}`)
  }
  const renderCard = (c: LiveCard, embedded = false) => (
    <div key={c.d.key} style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <LiveCardView
        links={sessionLinks(c, fleet, leaders)} onOpenSession={openSession}
        c={c} cards={cards} nowMs={nowMs} pt={pt} fleet={fleet} accountLabels={accountLabels} runtime={reply.runtime}
        leaderName={leaderOf(c)} role={roleOf(c)} mobile={isMobile} onOpen={open} embedded={embedded} sort={sort} cameFrom={moved[c.d.key]?.from ?? null}
      />
      {c.d.stage === 'queue' && !embedded && <LiveQueuePriority taskId={c.d.taskId} priority={c.d.priority} pt={pt} />}
      {c.d.awaitingApproval && c.d.subtaskId && <LiveApprove subtaskId={c.d.subtaskId} phase={c.d.awaitingApproval.phase} pt={pt} mobile={isMobile} />}
    </div>
  )
  const togglePub = (key: string) => setOpenPub(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  const renderPub = (c: LiveCard) => {
    const isOpen = openPub.has(c.d.key)
    const when = c.d.deliveredAtMs ? `${L.delivered} ${fmtClock(c.d.deliveredAtMs)} · ${fmtSpan(nowMs - c.d.deliveredAtMs)}` : L.delivered
    return (
      <div key={c.d.key} data-live-pubrow={c.d.key} data-open={isOpen ? '1' : '0'} style={{ display: 'grid' }}>
        <button
          type="button" aria-expanded={isOpen} onClick={() => togglePub(c.d.key)} className="ag-tap" title={c.d.title}
          style={{ ...surface, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', minWidth: 0, fontSize: 11.5, ...(isOpen ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : {}) }}
        >
          <span aria-hidden style={{ transform: isOpen ? 'none' : 'rotate(-90deg)', transition: reducedMotion() ? 'none' : 'transform .2s', flexShrink: 0 }}>▾</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{c.d.title}</span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 10.5, flexShrink: 0 }}>{when}</span>
        </button>
        <div style={{ display: 'grid', gridTemplateRows: isOpen ? '1fr' : '0fr', transition: reducedMotion() ? 'none' : 'grid-template-rows .2s' }}>
          <div style={{ overflow: 'hidden', minHeight: 0 }}>{isOpen && renderCard(c, true)}</div>
        </div>
      </div>
    )
  }
  const historyOrdered = groupHistory(historyCards, nowMs, pt).flatMap(g => g.cards)
  const historyHeading = (c: LiveCard, prev: LiveCard | undefined): string | null => {
    const label = dayLabel(c.d.deliveredAtMs ?? 0, nowMs, pt)
    return !prev || dayLabel(prev.d.deliveredAtMs ?? 0, nowMs, pt) !== label ? label : null
  }
  // Phone: one more section under the stages, closed until tapped, same accordion rows as Publicado.
  const renderHistoryMobile = () => historyOrdered.length === 0 ? null : (
    <section data-live-column="history" data-collapsed={historyOpen ? '0' : '1'} style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
      <header
        role="button" tabIndex={0} aria-expanded={historyOpen} data-live-colhead onClick={() => setHistoryOpen(v => !v)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHistoryOpen(v => !v) } }}
        style={{ borderTop: `3px solid ${HISTORY_COLOR}`, padding: '10px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 44, cursor: 'pointer' }}
      >
        <span style={{ fontWeight: 700, fontSize: 13 }}>{L.history}</span>
        <span style={{ ...microLabel, fontSize: 11 }}>{historyOrdered.length} {historyOpen ? '▴' : '▾'}</span>
      </header>
      {historyOpen && historyOrdered.map((c, i) => {
        const h = historyHeading(c, historyOrdered[i - 1])
        return (
          <React.Fragment key={c.d.key}>
            {h && <span data-live-group-head style={{ ...microLabel, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</span>}
            {renderPub(c)}
          </React.Fragment>
        )
      })}
    </section>
  )
  // The short line under the title: how many pieces and agents. The ETA and "updated live" are the tooltip.
  const summaryLine = [L.deliveries(sum.deliveries), L.agents(sum.agentsWorking)].join(' · ')
  const summaryTitle = [sum.nextEtaMs !== null ? L.next(fmtClock(sum.nextEtaMs)) : L.noNext, L.live].join(' · ')

  // The right-hand group of the bar: view and actions (older reviews, recently left, the external window, the leaders).
  const pillBtn = (active: boolean): React.CSSProperties => ({
    ...button(isMobile), gap: 6, flexShrink: 0, borderRadius: 999, padding: '0 12px',
    borderColor: active ? 'var(--anthropic-orange)' : 'var(--border)',
    background: active ? 'var(--anthropic-orange-dim)' : 'transparent',
    color: active ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)',
  })
  const actions = (
    <>
      {gone.length > 0 && (
        <button type="button" className="ag-tap" data-live-gone-toggle data-fresh={gone.some(g => clock - g.atMs < GONE_LINGER_MS) ? '1' : '0'} aria-pressed={showGone} onClick={() => setShowGone(v => !v)}
          style={{ ...pillBtn(showGone || gone.some(g => clock - g.atMs < GONE_LINGER_MS)), transition: reducedMotion() ? 'none' : 'background .4s, border-color .4s' }}>{L.recentLeft(gone.length)}</button>
      )}
      {(reply?.archivedTotal ?? 0) > 0 && (
        <button type="button" className="ag-tap" data-live-archived-toggle aria-pressed={showArchived} onClick={() => setShowArchived(v => !v)} title={L.archivedNote} style={pillBtn(showArchived)}>{L.archivedBtn(reply!.archivedTotal!)}</button>
      )}
      {!isMobile && !inPip && (
        <button type="button" className="ag-tap" data-live-external onClick={() => void openExternal()} disabled={pip !== null} title={L.externalTip} style={{ ...pillBtn(false), opacity: pip !== null ? 0.5 : 1 }}>
          <ExternalLink size={13} aria-hidden />{L.external}
        </button>
      )}
      {!compact && !inPip && (
        <LiveLeaders
          leaders={leaders} runtime={reply.runtime} accountLabels={accountLabels} nowMs={nowMs} lang={lang} mobile={isMobile}
          locate={(w: LeaderWorker) => locateWorker(w, shown, cards)} onLocate={a => requestLocate(a)}
          onOpen={id => navigate(`/sessions/${encodeURIComponent(id)}`)}
        />
      )}
    </>
  )

  const header = (
    <div style={{ display: 'grid', gap: 10 }}>
      <LiveToolbar
        pt={pt} mobile={isMobile} title={L.title} summary={summaryLine} summaryTitle={summaryTitle}
        taskFilter={<LiveTaskFilter options={options} chosen={taskIds} onChange={setTaskIds} pt={pt} mobile={isMobile} />}
        stageAll={isMobile ? undefined : { active: stageFilter === 'all', onClick: () => setStageFilter(stageFilter === 'all' ? (LIVE_STAGES.find(s => columns[s].length > 0) ?? 'running') : 'all') }}
        onlyActive={onlyActive} showQueue={showQueue} sort={sort}
        onOnlyActive={v => setViewPref({ onlyActive: v })} onShowQueue={v => setViewPref({ showQueue: v })} onSort={(s: LiveSortId) => setViewPref({ sort: s })}
        actions={actions}
      />
      {pipNote && <span role="status" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{L.externalBlocked}</span>}
      {showArchived && (reply?.archived?.length ?? 0) > 0 && (
        <div data-live-archived-list style={{ ...surface, padding: 0 }}>
          <LiveAntigas items={reply!.archived!} total={reply!.archivedTotal ?? reply!.archived!.length} pt={pt} mobile={isMobile} onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)} />
        </div>
      )}
      {showGone && (
        <ul data-live-gone-list style={{ ...surface, listStyle: 'none', margin: 0, padding: '8px 10px', display: 'grid', gap: 3, fontSize: 11.5 }}>
          {gone.length === 0 && <li style={{ color: 'var(--text-tertiary)' }}>{L.noneLeft}</li>}
          {gone.map(g => (
            <li key={g.key} data-live-gone={g.key} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <b style={{ fontWeight: 600 }}>{g.title}</b><span style={{ color: 'var(--text-tertiary)' }}>— {L.left}: {g.reason} · {sinceWord(g.atMs, clock, pt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  if (reply.deliveries.length === 0 && leaders.length === 0 && gone.length === 0 && historyCards.length === 0) return <div style={{ display: 'grid', gap: 12 }}>{header}<Note text={L.none} /></div>

  if (isMobile) {
    const chip = (active: boolean): React.CSSProperties => ({
      flex: '0 0 auto', scrollSnapAlign: 'start', minHeight: 36, padding: '0 14px', whiteSpace: 'nowrap', borderRadius: 999, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
      border: `1px solid ${active ? 'transparent' : 'var(--border)'}`,
      background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-card)',
      color: active ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)',
      fontWeight: active ? 600 : 400,
    })
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        {header}
        <div
          ref={chipRowRef} className="ag-scroll" role="tablist" data-live-stagerow
          style={{
            display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto', overflowY: 'hidden', flexShrink: 0,
            margin: '0 -12px', padding: '4px 12px 10px', minHeight: 48, boxSizing: 'border-box',
            scrollSnapType: 'x proximity', scrollPaddingLeft: 12, scrollBehavior: reducedMotion() ? 'auto' : 'smooth', WebkitOverflowScrolling: 'touch',
          }}
        >
          <button role="tab" data-chip="all" className="ag-tap" aria-selected={stageFilter === 'all'} onClick={() => setStageFilter('all')} style={chip(stageFilter === 'all')}>{L.allSteps} · {shown.length}</button>
          {LIVE_STAGES.map(s => (
            <button key={s} role="tab" data-chip={s} className="ag-tap" aria-selected={s === stageFilter} onClick={() => setStageFilter(s)} style={chip(s === stageFilter)}>
              {STAGE_LABEL[s][pt ? 'pt' : 'en']} · {columns[s].length}
            </button>
          ))}
        </div>
        <div ref={boardRef} style={{ display: 'grid', gap: 10, paddingTop: 6 }}>
          {visibleStages.map(s => (
            <section key={s} data-live-column={s} style={{ display: 'grid', gap: 8, alignContent: 'start', opacity: columns[s].length === 0 ? 0.5 : 1 }}>
              {(stageFilter === 'all' || columns[s].length === 0) && (
                <header data-live-stage-head style={{
                  position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-surface)', borderTop: `3px solid ${STAGE_LABEL[s].color}`,
                  padding: '6px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{STAGE_LABEL[s][pt ? 'pt' : 'en']}</span>
                  <span style={{ ...microLabel, fontSize: 11 }}>{columns[s].length === 0 ? L.empty : columns[s].length}</span>
                </header>
              )}
              {s === 'published' ? columns[s].map(renderPub) : columns[s].map(c => renderCard(c))}
            </section>
          ))}
          {renderHistoryMobile()}
        </div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} style={{ display: 'grid', gap: 12, gridTemplateRows: 'auto minmax(0, 1fr)', height: compact ? '100%' : (fitH ?? 560), minHeight: compact ? 0 : 420 }}>
      {header}
      {/* The PAGE scrolls horizontally only; each column is one vertical stack that scrolls on its own. */}
      <div ref={boardRef} className="ag-scroll" data-live-board style={{ display: 'flex', gap: 8, overflowX: 'auto', overflowY: 'hidden', alignItems: 'stretch', padding: '6px 2px 10px', minHeight: 0 }}>
        {visibleStages.map(s => (
          <LiveColumn
            key={s} stage={s} pt={pt} cards={columns[s]} collapsed={columnCollapsed(s, columns[s].length, prefs)}
            words={{ empty: L.empty, collapse: L.collapse, expand: L.expand, searchPlaceholder: L.searchColumn, noMatch: L.noMatch, clear: L.clearSearch }}
            query={queries[s] ?? ''} onQuery={q => setQueries(m => ({ ...m, [s]: q }))}
            onToggle={() => {
              const was = columnCollapsed(s, columns[s].length, prefs)
              const next = { ...prefs, [s]: !was }
              setPrefs(next); writeCollapsedPrefs(next)
            }}
            render={s === 'published' ? renderPub : renderCard}
            note={s === 'published' ? L.publishedNote : undefined}
          />
        ))}
        {stageFilter === 'all' && historyOrdered.length > 0 && (
          <LiveColumn
            key="history" stage="published" pt={pt} cards={historyOrdered} collapsed={!historyOpen}
            override={{ id: 'history', label: L.history, color: HISTORY_COLOR }}
            words={{ empty: L.empty, collapse: L.collapse, expand: L.expand, searchPlaceholder: L.searchColumn, noMatch: L.noMatch, clear: L.clearSearch }}
            query={historyQuery} onQuery={setHistoryQuery}
            onToggle={() => setHistoryOpen(v => !v)}
            render={renderPub} groupHeading={historyHeading}
          />
        )}
      </div>
    </div>
  )
}

function Note({ text }: { text: string }) {
  return <div style={{ ...surface, padding: '14px 12px', fontSize: 12.5, color: 'var(--text-tertiary)', textAlign: 'center' }}>{text}</div>
}
