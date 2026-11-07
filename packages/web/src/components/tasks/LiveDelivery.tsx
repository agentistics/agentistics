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
import { plainLeaderName } from '@agentistics/core'
import { CenteredLoader } from '../CenteredLoader'
import { useFleet, type FleetRow } from '../../lib/fleet'
import { useIsMobile } from '../../hooks/useIsMobile'
import { usePlanLimits } from '../../lib/planLimits'
import { pathOfView } from '../../lib/tasksViewRoute'
import { microLabel, surface } from './board'
import {
  LIVE_STAGES, orderQueueFirstUp, STAGE_LABEL, byStage, filterCards, fmtClock, fmtSpan, joinLive, summarize, LIVE_DEFAULTS,
  type StageFilter, type LiveCard, type LiveReply, type LiveStage,
} from './liveDeliveryModel'
import {
  columnCollapsed, fitCount, GONE_LINGER_MS, locateWorker, stageBar, mergeGone, pack, planDepartures, readCollapsedPrefs, sinceWord,
  snapshotOf, taskOfSession, taskOptions, writeCollapsedPrefs, type CollapsedPrefs, type BoardSnapshot, type Gone, type LocateAnswer,
} from './liveCardModel'
import { LiveCardView } from './LiveCardView'
import { LiveApprove } from './LiveApprove'
import { LiveLeaders } from './LiveLeaders'
import type { LeaderWorker } from './liveDeliveryModel'
import { LiveTaskFilter } from './LiveTaskFilter'
import { PipPortal, requestPipWindow, type OpenedWindow } from './livePip'
import { useLiveDeliveries } from './useLiveDeliveries'
import { flashHeader, flyCard, intersects, recolorBar, ring, transitionKind, type Box } from './liveDeliveryFx'

const reducedMotion = (): boolean => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

const COL_W = 280, COL_GAP = 8, COLLAPSED_W = 40, MORE_H = 30, CARD_GAP = 8

const copy = (pt: boolean) => pt ? {
  title: 'Live Delivery', onlyActive: 'só com agentes ativos',
  deliveries: (n: number) => `${n} ${n === 1 ? 'entrega ativa' : 'entregas ativas'}`,
  agents: (n: number) => `${n} ${n === 1 ? 'agente trabalhando' : 'agentes trabalhando'}`,
  next: (t: string) => `próxima entrega prevista ${t}`, noNext: 'sem entrega com estimativa',
  live: 'atualizado ao vivo', empty: 'Nada nesta etapa',
  down: 'Não consegui ler as entregas agora.', refused: 'O quadro não está disponível neste perfil.',
  loading: 'Carregando entregas…', none: 'Nenhuma entrega ativa agora.',
  delivered: 'publicado', allSteps: 'Todas as etapas', external: 'abrir janela externa', externalBlocked: 'O navegador bloqueou a janela externa.',
  more: (n: number) => `+${n}`, less: 'menos', collapse: 'Recolher coluna', expand: 'Abrir coluna',
  left: 'saiu', recentLeft: (n: number) => `saíram há pouco (${n})`, noneLeft: 'Ninguém saiu do quadro nos últimos minutos.',
} : {
  title: 'Live Delivery', onlyActive: 'only with active agents',
  deliveries: (n: number) => `${n} active ${n === 1 ? 'delivery' : 'deliveries'}`,
  agents: (n: number) => `${n} ${n === 1 ? 'agent working' : 'agents working'}`,
  next: (t: string) => `next delivery expected ${t}`, noNext: 'no delivery has an estimate',
  live: 'updated live', empty: 'Nothing in this stage',
  down: 'Could not read the deliveries right now.', refused: 'The board is not available on this profile.',
  loading: 'Loading deliveries…', none: 'No active delivery right now.',
  delivered: 'published', allSteps: 'All steps', external: 'open in a window', externalBlocked: 'The browser blocked the external window.',
  more: (n: number) => `+${n}`, less: 'less', collapse: 'Collapse column', expand: 'Open column',
  left: 'left', recentLeft: (n: number) => `left recently (${n})`, noneLeft: 'Nothing left the board in the last minutes.',
}

/** The hooks wrapper: the shared fleet stream, the plan-limits account labels and the live read model. */
export function LiveDelivery({ lang, compact, focusSessionId, inPip }: { lang: 'pt' | 'en'; compact?: boolean; focusSessionId?: string | null; inPip?: boolean }) {
  const { fleet } = useFleet(lang)
  const plan = usePlanLimits()
  const { reply, error, nowMs } = useLiveDeliveries(fleet.sessions)
  return <LiveDeliveryView lang={lang} reply={reply} error={error} nowMs={nowMs} fleet={fleet.sessions} accountLabels={plan.accountLabels} compact={compact} focusSessionId={focusSessionId} inPip={inPip} />
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
  const [taskIds, setTaskIds] = useState<readonly string[]>(initialTaskIds ?? LIVE_DEFAULTS.taskIds)
  const [onlyActive, setOnlyActive] = useState(LIVE_DEFAULTS.onlyActive)
  const [stageFilter, setStageFilter] = useState<StageFilter>(LIVE_DEFAULTS.stage)
  const [prefs, setPrefs] = useState<CollapsedPrefs>(() => readCollapsedPrefs())
  const [expandedCols, setExpandedCols] = useState<Partial<Record<LiveStage, boolean>>>({})
  const [openPub, setOpenPub] = useState<ReadonlySet<string>>(new Set())
  const [pip, setPip] = useState<OpenedWindow | null>(null)
  const [pipNote, setPipNote] = useState(false)
  const [gone, setGone] = useState<Gone[]>([])
  const [showGone, setShowGone] = useState(false)
  const [clock, setClock] = useState(() => Date.now())

  const cards = useMemo(() => joinLive(reply?.deliveries ?? [], fleet), [reply, fleet])
  const shown = useMemo(() => filterCards(cards, { taskIds, onlyActive }), [cards, taskIds, onlyActive])
  const columns = useMemo(() => orderQueueFirstUp(byStage(shown), shown), [shown])
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
  const filterSig = `${taskIds.join(',')}|${onlyActive}`
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
      const win = el?.ownerDocument.defaultView ?? window
      if (el) setFitH(Math.max(420, Math.floor(win.innerHeight / (Number(getComputedStyle(win.document.documentElement).getPropertyValue('--ui-zoom')) || 1) - el.getBoundingClientRect().top - 16)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
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
    setLocateReq(r => ({ key: a.key, stage: a.stage, n: (r?.n ?? 0) + 1 }))
  }, [])
  useEffect(() => {
    if (!locateReq) return
    const root = boardRef.current
    let frames = 0, expandedOnce = false, raf = 0
    const tryFind = () => {
      const el = root?.querySelector<HTMLElement>(`[data-live-card="${CSS.escape(locateReq.key)}"]`)
      if (el) {
        el.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center', inline: 'center' })
        ring(el, 'var(--accent-purple)', 2000)
        return
      }
      // Cut off by "+N": open that column's extra sub-columns once, then keep looking.
      if (frames === 6 && !expandedOnce) { expandedOnce = true; setExpandedCols(m => ({ ...m, [locateReq.stage]: true })) }
      if (frames++ < 40) raf = requestAnimationFrame(tryFind)
    }
    raf = requestAnimationFrame(tryFind)
    return () => cancelAnimationFrame(raf)
  }, [locateReq])

  const openExternal = useCallback(async () => {
    const r = await requestPipWindow({ width: 540, height: 680, fallbackUrl: `${window.location.origin}${pathOfView('live')}` })
    if (r.kind === 'pip') setPip(r)
    else if (r.kind === 'blocked') setPipNote(true)
  }, [])
  useEffect(() => () => { setPip(p => { if (p?.kind === 'pip') try { p.win.close() } catch { /* already closed */ } return null }) }, [])

  if (error === 'refused') return <Note text={L.refused} />
  if (reply === null && error !== 'down') return <CenteredLoader size={40} label={L.loading} testId="agentask-live-loading" />
  if (reply === null) return <Note text={L.down} />

  const open = (c: LiveCard) => {
    const id = c.agents[0]?.id ?? c.d.sessionIds[0]
    navigate(id ? `/sessions/${encodeURIComponent(id)}` : `/tasks/${encodeURIComponent(c.d.taskId)}`)
  }
  const leaderOf = (c: LiveCard): string | null => {
    const ids = new Set([...c.agents.map(a => a.id), ...c.d.sessionIds])
    const l = leaders.find(x => x.workers.some(w => ids.has(w.id)))
    return l ? plainLeaderName(l.title) : null
  }
  const roleOf = (c: LiveCard): 'leader' | 'worker' => (c.agents.some(a => leaderIds.has(a.id)) ? 'leader' : 'worker')
  const renderCard = (c: LiveCard, embedded = false) => (
    <div key={c.d.key} style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <LiveCardView
        c={c} cards={cards} nowMs={nowMs} pt={pt} fleet={fleet} accountLabels={accountLabels} runtime={reply.runtime}
        leaderName={leaderOf(c)} role={roleOf(c)} mobile={isMobile} onOpen={open} embedded={embedded} cameFrom={moved[c.d.key]?.from ?? null}
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
  const cardsOf = (s: LiveStage) => columns[s]

  const summaryLine = [
    L.deliveries(sum.deliveries), L.agents(sum.agentsWorking),
    sum.nextEtaMs !== null ? L.next(fmtClock(sum.nextEtaMs)) : L.noNext, L.live,
  ].join(' · ')

  const pillBtn = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 30, padding: '0 12px',
    borderRadius: 999, fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--anthropic-orange)' : 'var(--border)'}`,
    background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
    color: active ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)',
  })
  const filters = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
      <LiveTaskFilter options={options} chosen={taskIds} onChange={setTaskIds} pt={pt} />
      {!isMobile && <button
        type="button" className="ag-tap" aria-pressed={stageFilter === 'all'} data-live-allsteps onClick={() => setStageFilter(stageFilter === 'all' ? (LIVE_STAGES.find(s => columns[s].length > 0) ?? 'running') : 'all')}
        style={pillBtn(stageFilter === 'all')}
      >{L.allSteps}</button>}
      <button type="button" className="ag-tap" aria-pressed={onlyActive} onClick={() => setOnlyActive(v => !v)} style={pillBtn(onlyActive)}>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--anthropic-orange)' }} />{L.onlyActive}
      </button>
      {gone.length > 0 && (
        <button type="button" className="ag-tap" data-live-gone-toggle data-fresh={gone.some(g => clock - g.atMs < GONE_LINGER_MS) ? '1' : '0'} aria-pressed={showGone} onClick={() => setShowGone(v => !v)}
          style={{ ...pillBtn(showGone || gone.some(g => clock - g.atMs < GONE_LINGER_MS)), transition: reducedMotion() ? 'none' : 'background .4s, border-color .4s' }}>{L.recentLeft(gone.length)}</button>
      )}
      {!isMobile && !inPip && (
        <button type="button" className="ag-tap" data-live-external onClick={() => void openExternal()} disabled={pip?.kind === 'pip'} title={L.external} style={{ ...pillBtn(false), opacity: pip?.kind === 'pip' ? 0.5 : 1 }}>
          <ExternalLink size={13} aria-hidden />{L.external}
        </button>
      )}
    </div>
  )

  const header = (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 14, fontWeight: 650 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-red, #ff5f5f)' }} />{L.title}
        </span>
        {!compact && !inPip && (
          <LiveLeaders
            leaders={leaders} runtime={reply.runtime} accountLabels={accountLabels} nowMs={nowMs} lang={lang}
            locate={(w: LeaderWorker) => locateWorker(w, shown, cards)} onLocate={a => requestLocate(a)}
            onOpen={id => navigate(`/sessions/${encodeURIComponent(id)}`)}
          />
        )}
        <span data-live-summary style={{
          fontSize: 12, color: 'var(--text-tertiary)', flex: 1, minWidth: isMobile ? 0 : 220,
          ...(isMobile ? { flexBasis: '100%', order: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' } : {}),
        }}>{summaryLine}</span>
        {!isMobile && filters}
      </div>
      {isMobile && filters}
      {pipNote && <span role="status" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{L.externalBlocked}</span>}
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

  const pipPortal = pip?.kind === 'pip' ? (
    <PipPortal win={pip.win} onClose={() => setPip(null)}>
      <LiveDeliveryView lang={lang} reply={reply} error={error} nowMs={nowMs} fleet={fleet} accountLabels={accountLabels} compact inPip initialTaskIds={taskIds} />
    </PipPortal>
  ) : null

  if (reply.deliveries.length === 0 && leaders.length === 0 && gone.length === 0) return <div style={{ display: 'grid', gap: 12 }}>{header}<Note text={L.none} />{pipPortal}</div>

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
        </div>
        {pipPortal}
      </div>
    )
  }

  return (
    <div ref={wrapRef} style={{ display: 'grid', gap: 12, gridTemplateRows: 'auto minmax(0, 1fr)', height: compact ? '100%' : (fitH ?? 560), minHeight: compact ? 0 : 420 }}>
      {header}
      {/* HORIZONTAL scroll only: columns fit the height they are given, the rest flows sideways. */}
      <div ref={boardRef} className="ag-scroll" data-live-board style={{ display: 'flex', gap: COL_GAP, overflowX: 'auto', overflowY: 'hidden', alignItems: 'stretch', padding: '6px 2px 10px', minHeight: 0 }}>
        {visibleStages.map(s => (
          <Column
            key={s} stage={s} pt={pt} cards={cardsOf(s)} prefs={prefs} L={L}
            expanded={!!expandedCols[s]} onExpanded={v => setExpandedCols(m => ({ ...m, [s]: v }))}
            onToggle={() => {
              const was = columnCollapsed(s, cardsOf(s).length, prefs)
              const next = { ...prefs, [s]: !was }
              setPrefs(next); writeCollapsedPrefs(next)
            }}
            render={s === 'published' ? renderPub : renderCard}
            sig={s === 'published' ? [...openPub].join(',') : ''}
          />
        ))}
      </div>
      {pipPortal}
    </div>
  )
}

/**
 * One stage column. Collapsed it is the thin vertical strip empty columns always were; open it shows
 * the cards that FIT the height and a "+N" that flows the rest into extra sub-columns to the right —
 * measured, not guessed, and never a vertical scroll bar.
 */
function Column({ stage, pt, cards, prefs, L, expanded, onExpanded, onToggle, render, sig }: {
  stage: LiveStage; pt: boolean; cards: LiveCard[]; prefs: CollapsedPrefs; L: ReturnType<typeof copy>
  expanded: boolean; onExpanded: (v: boolean) => void; onToggle: () => void
  render: (c: LiveCard) => React.ReactNode; sig: string
}) {
  const collapsed = columnCollapsed(stage, cards.length, prefs)
  const label = STAGE_LABEL[stage][pt ? 'pt' : 'en']
  const bodyRef = useRef<HTMLDivElement>(null)
  const [m, setM] = useState<{ heights: number[]; avail: number } | null>(null)
  // Cards of a column that was just collapsed stay mounted for the width animation to play over them.
  const [lingerOpen, setLingerOpen] = useState(false)
  const wasCollapsed = useRef(collapsed)
  useEffect(() => {
    if (!wasCollapsed.current && collapsed && !reducedMotion()) {
      setLingerOpen(true)
      const t = setTimeout(() => setLingerOpen(false), 230)
      wasCollapsed.current = collapsed
      return () => clearTimeout(t)
    }
    wasCollapsed.current = collapsed
    return undefined
  }, [collapsed])

  const signature = useMemo(
    () => cards.map(c => `${c.d.key}:${c.liveState}:${c.d.lastAction?.text.length ?? 0}:${c.d.block ? 1 : 0}`).join('|') + `#${expanded}#${sig}`,
    [cards, expanded, sig],
  )
  useLayoutEffect(() => { setM(null) }, [signature])
  useLayoutEffect(() => {
    if (m !== null || collapsed) return
    const el = bodyRef.current
    if (!el) return
    const slots = Array.from(el.querySelectorAll<HTMLElement>('[data-live-slot]'))
    const heights = slots.map(x => x.getBoundingClientRect().height + CARD_GAP)
    setM({ heights, avail: el.clientHeight })
  }, [m, collapsed, signature])
  useEffect(() => {
    // The height the column is given changes with the window and with the header above it.
    const el = bodyRef.current
    if (!el || collapsed || typeof ResizeObserver === 'undefined') return
    let last = el.clientHeight
    const ro = new ResizeObserver(() => { if (Math.abs(el.clientHeight - last) > 2) { last = el.clientHeight; setM(null) } })
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsed])

  const shownCount = m ? fitCount(m.heights, m.avail, MORE_H + CARD_GAP) : cards.length
  const cut = m !== null && shownCount < cards.length
  const packs = m && expanded && cut ? pack(m.heights, m.avail) : null
  const cols = packs ? packs.length : 1
  const width = collapsed ? COLLAPSED_W : cols * COL_W + (cols - 1) * COL_GAP
  const mountBody = !collapsed || lingerOpen
  const slot = (c: LiveCard) => <div key={c.d.key} data-live-slot style={{ minWidth: 0 }}>{render(c)}</div>
  const slotStyle: React.CSSProperties = { display: 'grid', gap: CARD_GAP, alignContent: 'start', minWidth: 0, width: COL_W, flex: '0 0 auto' }

  return (
    <section
      data-live-column={stage} data-collapsed={collapsed ? '1' : '0'}
      style={{
        flex: `0 0 ${width}px`, width, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden',
        opacity: cards.length === 0 && collapsed ? 0.5 : 1,
        transition: reducedMotion() ? 'none' : 'flex-basis .2s ease, width .2s ease, opacity .2s ease',
      }}
    >
      <header
        role="button" tabIndex={0} aria-expanded={!collapsed} aria-label={`${label} — ${collapsed ? L.expand : L.collapse}`}
        title={collapsed ? L.expand : L.collapse} data-live-colhead onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        style={{
          borderTop: `3px solid ${STAGE_LABEL[stage].color}`, padding: '8px 4px 2px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6,
          cursor: 'pointer', flexShrink: 0, ...(collapsed ? { flexDirection: 'column', gap: 6 } : {}),
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, ...(collapsed ? { writingMode: 'vertical-rl', whiteSpace: 'nowrap' } : {}) }}>{label}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {!collapsed && expanded && cut && (
            <button type="button" data-live-less className="ag-tap" onClick={e => { e.stopPropagation(); onExpanded(false) }}
              style={{ background: 'none', border: 0, color: 'var(--anthropic-orange-light)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 }}>{L.less}</button>
          )}
          <span style={{ ...microLabel, fontSize: 11 }}>{cards.length}</span>
        </span>
      </header>
      {mountBody && (
        <div
          ref={bodyRef} data-live-colbody
          style={{
            flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', gap: COL_GAP, alignItems: 'flex-start',
            opacity: collapsed ? 0 : 1, transition: reducedMotion() ? 'none' : 'opacity .15s ease', pointerEvents: collapsed ? 'none' : undefined,
          }}
        >
          {packs ? packs.map((idxs, k) => (
            <div key={k} data-live-subcol style={slotStyle}>
              {idxs.map(i => slot(cards[i]!))}
            </div>
          )) : (
            <div style={slotStyle}>
              {(m ? cards.slice(0, shownCount) : cards).map(slot)}
              {cut && (
                <button type="button" data-live-more className="ag-tap" onClick={() => onExpanded(true)}
                  style={{ minHeight: MORE_H, borderRadius: 8, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--anthropic-orange-light)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600 }}
                >{L.more(cards.length - shownCount)}</button>
              )}
              {cards.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 6px' }}>{L.empty}</span>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function Note({ text }: { text: string }) {
  return <div style={{ ...surface, padding: '14px 12px', fontSize: 12.5, color: 'var(--text-tertiary)', textAlign: 'center' }}>{text}</div>
}
