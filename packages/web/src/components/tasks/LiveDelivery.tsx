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
import { Check, ChevronDown, ExternalLink } from 'lucide-react'
import { LIVE_PERIODS, liveCapOmitted, plainLeaderName, type LivePeriod, type LiveTab } from '@agentistics/core'
import { CenteredLoader } from '../CenteredLoader'
import { useFleet, type FleetRow } from '../../lib/fleet'
import { useIsMobile } from '../../hooks/useIsMobile'
import { usePlanLimits } from '../../lib/planLimits'
import { pathOfView } from '../../lib/tasksViewRoute'
import { fitHeight, holdPageFit, reserveBelow } from '../../lib/pageFit'
import { button, microLabel, surface } from './board'
import {
  LIVE_STAGES, orderColumns, STAGE_LABEL, byStage, filterCards, fmtClock, fmtSpan, joinLive, summarize, tabCounts,
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
import { LiveColumn } from './LiveColumn'
import { LiveLeaders } from './LiveLeaders'
import type { LeaderWorker } from './liveDeliveryModel'
import { LiveTaskChips, LiveTaskFilter } from './LiveTaskFilter'
import { sessionLinks } from './liveSessionLinks'
import { LiveToolbar } from './LiveToolbar'
import { menuRowStyle, PanelMenu } from './PickerMenu'
import { requestPipWindow } from './livePip'
import { registerPip, usePip } from './livePipStore'
import { useLiveDeliveries } from './useLiveDeliveries'
import { flashHeader, flyCard, intersects, recolorBar, ring, transitionKind, type Box } from './liveDeliveryFx'

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
  period: 'Período do Publicado', periods: { '24h': 'últimas 24 h', '7d': '7 dias', '30d': '30 dias', all: 'tudo' } as Record<LivePeriod, string>,
  noPublished: 'Nada publicado neste período.',
  capped: (n: number, cap: number) => `Lista cortada em ${cap} por tipo: ${n} ${n === 1 ? 'peça mais antiga ficou' : 'peças mais antigas ficaram'} de fora. Os números acima não são o total.`,
  searchColumn: 'Buscar nesta coluna…', noMatch: 'Nenhum cartão corresponde.', clearSearch: 'Limpar',
  antigas: (n: number) => `Antigas · ${n}`, antigasTip: 'Peças antigas sem prova de publicação: decida cada uma em um clique.',
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
  period: 'Published period', periods: { '24h': 'last 24 h', '7d': '7 days', '30d': '30 days', all: 'all' } as Record<LivePeriod, string>,
  noPublished: 'Nothing published in this period.',
  capped: (n: number, cap: number) => `List cut at ${cap} per kind: ${n} older ${n === 1 ? 'piece is' : 'pieces are'} left out. The numbers above are not the total.`,
  searchColumn: 'Search this column…', noMatch: 'No card matches.', clearSearch: 'Clear',
  antigas: (n: number) => `Old · ${n}`, antigasTip: 'Old pieces with no proof of release: decide each one in one click.',
  left: 'left', recentLeft: (n: number) => `left recently (${n})`, noneLeft: 'Nothing left the board in the last minutes.',
}

/** The hooks wrapper: the shared fleet stream, the plan-limits account labels and the live read model. */
export function LiveDelivery({ lang, compact, focusSessionId, inPip, initialTaskIds }: { lang: 'pt' | 'en'; compact?: boolean; focusSessionId?: string | null; inPip?: boolean; initialTaskIds?: readonly string[] }) {
  const { fleet } = useFleet(lang)
  const plan = usePlanLimits()
  // The Publicado period is asked of the server (it decides what is sent), so it lives here, beside the fetch.
  const [period, setPeriod] = useState<LivePeriod>(() => readViewPrefs().period)
  const { reply, replyPeriod, error, nowMs } = useLiveDeliveries(fleet.sessions, period)
  return <LiveDeliveryView lang={lang} reply={reply} replyPeriod={replyPeriod} error={error} nowMs={nowMs} fleet={fleet.sessions} accountLabels={plan.accountLabels} onPeriod={setPeriod} compact={compact} focusSessionId={focusSessionId} inPip={inPip} initialTaskIds={initialTaskIds} />
}

export interface LiveDeliveryViewProps {
  /** The shortcut popover/sheet: no leaders band, the board takes the room it is given. */
  compact?: boolean
  lang: 'pt' | 'en'
  reply: LiveReply | null
  /** The period the reply was asked for (the hook knows it); falls back to what the server echoed in `view.period`. */
  replyPeriod?: LivePeriod
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
  /** The person chose another Publicado period: whoever fetches must ask the server again. */
  onPeriod?: (p: LivePeriod) => void
}

/** PURE of data sources: everything it draws comes in as props, so it is tested without mocking a store. */
export function LiveDeliveryView({ lang, reply, replyPeriod, error, nowMs, fleet, accountLabels, compact, focusSessionId, initialTaskIds, inPip, onPeriod }: LiveDeliveryViewProps) {
  const pt = lang === 'pt'
  const L = copy(pt)
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const [taskIds, setTaskIds] = useState<readonly string[]>(initialTaskIds ?? [])
  // The filter bar's switches and the sort are saved like the column preferences (this browser).
  const [view, setView] = useState(() => readViewPrefs())
  const { tab, period, sort } = view
  const setViewPref = useCallback((patch: Partial<typeof view>) => {
    setView(v => { const n = { ...v, ...patch }; writeViewPrefs(n); return n })
    if (patch.period) onPeriod?.(patch.period)
  }, [onPeriod])
  const [stageFilter, setStageFilter] = useState<StageFilter>('all')
  const [prefs, setPrefs] = useState<CollapsedPrefs>(() => readCollapsedPrefs())
  // Each column's own search text (the field appears when more than three cards are out of view).
  const [queries, setQueries] = useState<Partial<Record<LiveStage, string>>>({})
  const [openPub, setOpenPub] = useState<ReadonlySet<string>>(new Set())
  const [pipNote, setPipNote] = useState(false)
  const [gone, setGone] = useState<Gone[]>([])
  const [showGone, setShowGone] = useState(false)
  const [showAntigas, setShowAntigas] = useState(false)
  const [clock, setClock] = useState(() => Date.now())

  // ONE set of cards feeds both the tab counts and the columns. The server already answered for the chosen period
  // (`?tab=all&period=…`: everything, Publicado inside its period), so the tab only picks among what it sent.
  const cards = useMemo(() => joinLive(reply?.deliveries ?? [], fleet), [reply, fleet])
  const shown = useMemo(() => filterCards(cards, { taskIds, tab, period, nowMs }), [cards, taskIds, tab, period, nowMs])
  const counts = useMemo(() => tabCounts(cards, { taskIds, period, nowMs }), [cards, taskIds, period, nowMs])
  const columns = useMemo(() => orderColumns(byStage(shown), sort), [shown, sort])
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
  const filterSig = `${taskIds.join(',')}|${tab}|${period}`
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
  // A chosen stage that emptied (a tab change, a poll) is not a screen to be left on: back to every step.
  useEffect(() => { if (stageFilter !== 'all' && columns[stageFilter].length === 0) setStageFilter('all') }, [stageFilter, columns])
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
    // A worker's card that the current tab does not draw: "Tudo" does, so the locate can find it.
    if (!shown.some(c => c.d.key === a.key)) setViewPref({ tab: 'all' })
    setPrefs(p => { if (p[a.stage] === false) return p; const n = { ...p, [a.stage]: false }; writeCollapsedPrefs(n); return n })
    // A search typed in that column would hide the very card being looked for.
    setQueries(q => (q[a.stage] ? { ...q, [a.stage]: '' } : q))
    setLocateReq(r => ({ key: a.key, stage: a.stage, n: (r?.n ?? 0) + 1 }))
  }, [shown, setViewPref])
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
  if (reply === null && error !== 'down') {
    // The pop-out (popover, sheet, PiP window) is not the viewport: a `screen` loader centred on the page and
    // drew beside the popup's middle. Inside it the loader fills the popup's own box instead.
    if (compact) return <div data-live-loading-box style={{ position: 'relative', height: '100%', minHeight: 240 }}><CenteredLoader size={40} label={L.loading} testId="agentask-live-loading" placement="fill" /></div>
    return <CenteredLoader size={40} label={L.loading} testId="agentask-live-loading" />
  }
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
          <ChevronDown size={13} aria-hidden style={{ transform: isOpen ? 'none' : 'rotate(-90deg)', transition: reducedMotion() ? 'none' : 'transform .2s', flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{c.d.title}</span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 10.5, flexShrink: 0 }}>{when}</span>
        </button>
        <div style={{ display: 'grid', gridTemplateRows: isOpen ? '1fr' : '0fr', transition: reducedMotion() ? 'none' : 'grid-template-rows .2s' }}>
          <div style={{ overflow: 'hidden', minHeight: 0 }}>{isOpen && renderCard(c, true)}</div>
        </div>
      </div>
    )
  }
  // Publicado's own period (24 h by default): the picker sits in the column header where the count would go.
  const periodPicker = (
    <span data-live-period-wrap onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <PanelMenu
        title={L.period} width={190} ariaLabel={`${L.period}: ${L.periods[period]}`} align="right"
        triggerStyle={{ ...button(isMobile), gap: 4, minHeight: isMobile ? 36 : 22, padding: '0 8px', fontSize: 11, borderRadius: 999, flexShrink: 0 }} triggerClassName="ag-tap"
        render={close => (
          <div data-live-period-menu style={{ display: 'grid', gap: 2 }}>
            {LIVE_PERIODS.map(p => (
              <button key={p} type="button" data-live-period={p} aria-pressed={period === p} style={menuRowStyle(isMobile, period === p)} onClick={() => { setViewPref({ period: p }); close() }}>
                <span style={{ flex: 1 }}>{L.periods[p]}</span>{period === p && <Check size={13} aria-hidden />}
              </button>
            ))}
          </div>
        )}
      ><span data-live-period-current>{L.periods[period]}</span> <ChevronDown size={12} aria-hidden /></PanelMenu>
    </span>
  )
  // The answer on screen is for another period than the chosen one: the numbers below are the old ones until it lands.
  const answeredPeriod = replyPeriod ?? reply.view?.period
  const periodLoading = Boolean(answeredPeriod) && answeredPeriod !== period
  const showPublished = tab === 'all' || tab === 'published'
  // "Antigas sem registro": filtros v2 keeps them in "Tudo", at the bottom of "Revisão do líder". That tab's bar opens the group: a button in
  // that column's header sits off screen at 1280 px, behind the columns to its left.
  const oldCards = cards.filter(c => c.d.old && (taskIds.length === 0 || taskIds.includes(c.d.taskId)))
  const antigasTrigger = tab === 'all' && oldCards.length > 0 ? (
    <button type="button" className="ag-tap" data-live-antigas-open onClick={() => setShowAntigas(true)} title={L.antigasTip} style={{ ...button(isMobile), flexShrink: 0 }}>{L.antigas(oldCards.length)}</button>
  ) : null
  // The server cuts each kind at its cap (the oldest go): say so, so a count is never read as the total.
  // Under a task or stage filter only the cut pieces that match it count (the server's own rule, `liveCapOmitted`).
  const capFacts = reply.view?.capFacts
  const cappedOmitted = capFacts
    ? liveCapOmitted({ facts: capFacts, tab, period, nowMs, stage: stageFilter, match: taskIds.length ? id => taskIds.includes(id) : undefined })
    : (taskIds.length || stageFilter !== 'all' ? 0 : (reply.view?.capped?.omitted ?? 0))
  const capNote = cappedOmitted > 0 && showPublished ? L.capped(cappedOmitted, reply.view?.capped?.cap ?? 400) : null
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
      {antigasTrigger}
      {gone.length > 0 && (
        <button type="button" className="ag-tap" data-live-gone-toggle data-fresh={gone.some(g => clock - g.atMs < GONE_LINGER_MS) ? '1' : '0'} aria-pressed={showGone} onClick={() => setShowGone(v => !v)}
          style={{ ...pillBtn(showGone || gone.some(g => clock - g.atMs < GONE_LINGER_MS)), transition: reducedMotion() ? 'none' : 'background .4s, border-color .4s' }}>{L.recentLeft(gone.length)}</button>
      )}
      {!isMobile && !inPip && (
        <button type="button" className="ag-tap" data-live-external onClick={() => void openExternal()} disabled={pip !== null} title={L.externalTip} aria-label={L.external} style={{ ...button(false), padding: '0 10px', flexShrink: 0, opacity: pip !== null ? 0.5 : 1 }}>
          <ExternalLink size={14} aria-hidden />
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
        taskChips={<LiveTaskChips options={options} chosen={taskIds} onChange={setTaskIds} pt={pt} mobile={isMobile} />}
        tab={tab} counts={counts} onTab={(t: LiveTab) => { setViewPref({ tab: t }); setStageFilter('all') }}
        sort={sort} onSort={(s: LiveSortId) => setViewPref({ sort: s })}
        actions={actions}
      />
      {pipNote && <span role="status" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{L.externalBlocked}</span>}
      {error === 'down' && <span role="alert" data-live-stale-error style={{ fontSize: 12, color: 'var(--accent-red)' }}>{L.down}</span>}
      {periodLoading && !error && <CenteredLoader size={40} label={L.loading} testId="agentask-live-period-loading" />}
      {capNote && <span role="status" data-live-capped style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{capNote}</span>}
      <LiveAntigas
        open={showAntigas} pt={pt} mobile={isMobile} onClose={() => setShowAntigas(false)}
        items={oldCards.map(c => ({ key: c.d.key, taskId: c.d.taskId, subtaskId: c.d.subtaskId, title: c.d.title, ...(c.d.suggestion ? { suggestion: c.d.suggestion } : {}) }))}
        onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)}
      />
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

  if (cards.length === 0 && leaders.length === 0 && gone.length === 0) return <div style={{ display: 'grid', gap: 12 }}>{header}<Note text={L.none} /></div>

  // The group's sheet covers the whole phone, and every piece it decides is a board write that refreshes the Live: redrawing a few
  // hundred cards nobody can see, once per write, pegged the page until the tab crashed (measured at 390 px, 180 pieces).
  if (isMobile && showAntigas) return <div style={{ display: 'grid', gap: 10 }}>{header}</div>

  if (isMobile) {
    // Stages with cards, in order; Publicado also stays while its tab shows (its period picker lives in its header).
    const mobileStages = LIVE_STAGES.filter(s => columns[s].length > 0 || (s === 'published' && showPublished))
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
        {/* A single stage needs no chips to move between: the tab already says how many, once. */}
        {mobileStages.length > 1 && <div
          ref={chipRowRef} className="ag-scroll" role="tablist" data-live-stagerow
          style={{
            display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto', overflowY: 'hidden', flexShrink: 0,
            margin: '0 -12px', padding: '4px 12px 10px', minHeight: 48, boxSizing: 'border-box',
            scrollSnapType: 'x proximity', scrollPaddingLeft: 12, scrollBehavior: reducedMotion() ? 'auto' : 'smooth', WebkitOverflowScrolling: 'touch',
          }}
        >
          <button role="tab" data-chip="all" className="ag-tap" aria-selected={stageFilter === 'all'} onClick={() => setStageFilter('all')} style={chip(stageFilter === 'all')}>{L.allSteps}</button>
          {/* Only the stages that hold something: no chip, and no section, says a zero for nothing. */}
          {mobileStages.map(s => (
            <button key={s} role="tab" data-chip={s} className="ag-tap" aria-selected={s === stageFilter} onClick={() => setStageFilter(s)} style={chip(s === stageFilter)}>
              {STAGE_LABEL[s][pt ? 'pt' : 'en']} · {columns[s].length}
            </button>
          ))}
        </div>}
        <div ref={boardRef} style={{ display: 'grid', gap: 10, paddingTop: 6 }}>
          {mobileStages.filter(s => stageFilter === 'all' || s === stageFilter).map(s => (
            <section key={s} data-live-column={s} style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
              {(stageFilter === 'all' || s === 'published') && (
                <header data-live-stage-head style={{
                  position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-surface)', borderTop: `3px solid ${STAGE_LABEL[s].color}`,
                  padding: '6px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 44,
                }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{STAGE_LABEL[s][pt ? 'pt' : 'en']}</span>
                  {s === 'published' ? periodPicker : null}
                </header>
              )}
              {s === 'published' && columns[s].length === 0 && <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 6px' }}>{L.noPublished}</span>}
              {s === 'published' ? columns[s].map(renderPub) : columns[s].map(c => renderCard(c))}
            </section>
          ))}
          {mobileStages.length === 0 && <Note text={L.empty} />}
        </div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} style={{ display: 'grid', gap: 12, gridTemplateRows: 'auto minmax(0, 1fr)', height: compact ? '100%' : (fitH ?? 560), minHeight: compact ? 0 : 420 }}>
      {header}
      {/* The PAGE scrolls horizontally only; each column is one vertical stack that scrolls on its own. */}
      <div ref={boardRef} className="ag-scroll" data-live-board style={{ display: 'flex', gap: 8, overflowX: 'auto', overflowY: 'hidden', alignItems: 'stretch', padding: '6px 2px 10px', minHeight: 0 }}>
        {/* An empty tab says so (the phone's own sentence) instead of drawing nine bare column names. Publicado keeps its column: the period picker lives there. */}
        {shown.length === 0 && !showPublished && <div style={{ flex: 1, minWidth: 0 }}><Note text={L.empty} /></div>}
        {(shown.length === 0 ? (showPublished ? (['published'] as LiveStage[]) : []) : visibleStages).map(s => (
          <LiveColumn
            key={s} stage={s} pt={pt} cards={columns[s]} collapsed={columnCollapsed(s, columns[s].length, prefs, s === 'published' && showPublished)}
            words={{ empty: L.empty, collapse: L.collapse, expand: L.expand, searchPlaceholder: L.searchColumn, noMatch: L.noMatch, clear: L.clearSearch }}
            query={queries[s] ?? ''} onQuery={q => setQueries(m => ({ ...m, [s]: q }))}
            onToggle={() => {
              const was = columnCollapsed(s, columns[s].length, prefs, s === 'published' && showPublished)
              const next = { ...prefs, [s]: !was }
              setPrefs(next); writeCollapsedPrefs(next)
            }}
            render={s === 'published' ? renderPub : renderCard}
            {...(s === 'published' ? { headerExtra: periodPicker, emptyText: L.noPublished } : {})}
          />
        ))}
      </div>
    </div>
  )
}

function Note({ text }: { text: string }) {
  return <div style={{ ...surface, padding: '14px 12px', fontSize: 12.5, color: 'var(--text-tertiary)', textAlign: 'center' }}>{text}</div>
}
