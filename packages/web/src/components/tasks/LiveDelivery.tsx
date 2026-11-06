/**
 * LiveDelivery — the REAL-TIME line of deliveries: one column per stage, one card per active piece
 * of work (a subtask with an agent alive, or one sitting at a gate).
 *
 * The main board shows a TASK as a whole; this shows where each DELIVERY is right now and for how
 * long. Everything on a card is either read from the book or from the fleet, and an estimate always
 * says what it was computed from — "sem estimativa" is a legitimate answer, a made-up number is not.
 *
 * Mobile: ONE stage at a time (the chips above it), same cards, 44px targets — the same shape as the
 * board's `MobileLane`, so nobody has to learn a second phone layout.
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useFleet, type FleetRow } from '../../lib/fleet'
import { useIsMobile } from '../../hooks/useIsMobile'
import { usePlanLimits } from '../../lib/planLimits'
import { accountLabelKey } from '../../lib/planLimits'
import { Select } from '../../pages/settings/primitives'
import { harnessColor, microLabel, pill, surface } from './board'
import { SessionChip } from '../sessions/RoleChip'
import {
  LIVE_STAGES, LIVE_STATE_LABEL, STAGE_LABEL, byStage, etaText, filterCards, fmtSpan, joinLive, summarize,
  fmtClock, LIVE_DEFAULTS, isQueued, queuePosition, cardPills, type StageFilter, type LeaderRecord, type LiveCard, type LiveReply, type LiveStage,
} from './liveDeliveryModel'
import { useLiveDeliveries } from './useLiveDeliveries'
import { disintegrate, flyCard, intersects, reintegrate, transitionKind, type Box } from './liveDeliveryFx'

const STATE_COLOR = {
  working: 'var(--accent-green, #3ecf8e)', waiting: 'var(--text-tertiary)',
  'needs-you': 'var(--accent-red, #ff5f5f)', down: 'var(--accent-red, #ff5f5f)', none: 'var(--text-tertiary)',
} as const

const copy = (pt: boolean) => pt ? {
  title: 'Live Delivery', all: 'Todas as tarefas', onlyActive: 'só com agentes ativos',
  deliveries: (n: number) => `${n} ${n === 1 ? 'entrega ativa' : 'entregas ativas'}`,
  agents: (n: number) => `${n} ${n === 1 ? 'agente trabalhando' : 'agentes trabalhando'}`,
  next: (t: string) => `próxima entrega prevista ${t}`, noNext: 'sem entrega com estimativa',
  live: 'atualizado ao vivo', inStage: 'nesta etapa', total: 'total', empty: 'Nada nesta etapa',
  down: 'Não consegui ler as entregas agora.', refused: 'O quadro não está disponível neste perfil.',
  loading: 'Carregando entregas…', none: 'Nenhuma entrega ativa agora.',
  delivered: 'entregue', last: 'última ação',
  allSteps: 'Todas as etapas', queued: 'NA FILA', waitingSlot: 'aguardando vaga', account: 'conta',
} : {
  title: 'Live Delivery', all: 'All tasks', onlyActive: 'only with active agents',
  deliveries: (n: number) => `${n} active ${n === 1 ? 'delivery' : 'deliveries'}`,
  agents: (n: number) => `${n} ${n === 1 ? 'agent working' : 'agents working'}`,
  next: (t: string) => `next delivery expected ${t}`, noNext: 'no delivery has an estimate',
  live: 'updated live', inStage: 'in this stage', total: 'total', empty: 'Nothing in this stage',
  down: 'Could not read the deliveries right now.', refused: 'The board is not available on this profile.',
  loading: 'Loading deliveries…', none: 'No active delivery right now.',
  delivered: 'delivered', last: 'last action',
  allSteps: 'All steps', queued: 'QUEUED', waitingSlot: 'waiting for a slot', account: 'account',
}

/** The hooks wrapper: the shared fleet stream, the plan-limits account labels and the live read model. */
export function LiveDelivery({ lang, compact }: { lang: 'pt' | 'en'; compact?: boolean }) {
  const { fleet } = useFleet(lang)
  const plan = usePlanLimits()
  const { reply, error, nowMs } = useLiveDeliveries(fleet.sessions)
  return <LiveDeliveryView lang={lang} reply={reply} error={error} nowMs={nowMs} fleet={fleet.sessions} accountLabels={plan.accountLabels} compact={compact} />
}

/** PURE of data sources: everything it draws comes in as props, so it is tested without mocking a store. */
export function LiveDeliveryView({ lang, reply, error, nowMs, fleet, accountLabels, compact }: {
  /** The shortcut popover/sheet: no leaders band, the board takes the room it is given. */
  compact?: boolean
  lang: 'pt' | 'en'
  reply: LiveReply | null
  error: 'down' | 'refused' | null
  nowMs: number
  fleet: readonly FleetRow[]
  accountLabels: Record<string, string>
}) {
  const pt = lang === 'pt'
  const L = copy(pt)
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const [taskId, setTaskId] = useState<string | null>(null)
  const [onlyActive, setOnlyActive] = useState(LIVE_DEFAULTS.onlyActive)
  const [stageFilter, setStageFilter] = useState<StageFilter>(LIVE_DEFAULTS.stage)

  const cards = useMemo(() => joinLive(reply?.deliveries ?? [], fleet), [reply, fleet])
  const shown = useMemo(() => filterCards(cards, { taskId, onlyActive }), [cards, taskId, onlyActive])
  const columns = useMemo(() => byStage(shown), [shown])
  const visibleStages = stageFilter === 'all' ? LIVE_STAGES : LIVE_STAGES.filter(s => s === stageFilter)
  const sum = useMemo(() => summarize(shown, nowMs), [shown, nowMs])
  const tasks = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of cards) m.set(c.d.taskId, c.d.taskTitle)
    return [...m.entries()].map(([value, label]) => ({ value, label }))
  }, [cards])

  // Stage changes are animated FLIP-style: each card's last stage and box are remembered, and a card
  // that shows up in another column glides from where it was (a merge approved is disintegrated and
  // reintegrated instead). Cards the first render shows — and cards that merely scrolled — do not move.
  const seen = useRef(new Map<string, { stage: LiveStage; box: Box }>())
  const boardRef = useRef<HTMLDivElement>(null)
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
        const back = () => { el.style.opacity = '' }
        if (kind === 'merge-approved') void disintegrate(el, from).then(() => reintegrate(el)).then(back, back)
        else void flyCard(el, from, { fromColor: STAGE_LABEL[prev.stage].color, toColor: STAGE_LABEL[stage].color }).then(back, back)
      })
    }
    for (const f of flights) f()
    seen.current = now
  })

  if (error === 'refused') return <Note text={L.refused} />
  if (reply === null) return <Note text={error === 'down' ? L.down : L.loading} />

  const open = (c: LiveCard) => {
    const id = c.agents[0]?.id ?? c.d.sessionIds[0]
    navigate(id ? `/sessions/${encodeURIComponent(id)}` : `/tasks/${encodeURIComponent(c.d.taskId)}`)
  }
  const accountOf = (a: LiveCard['agents'][number]) =>
    a.accountId ? (accountLabels[accountLabelKey(a.harness, a.accountId)] ?? a.accountId) : null

  const summaryLine = [
    L.deliveries(sum.deliveries), L.agents(sum.agentsWorking),
    sum.nextEtaMs !== null ? L.next(fmtClock(sum.nextEtaMs)) : L.noNext, L.live,
  ].join(' · ')

  const filters = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 190 }}>
        <Select
          value={taskId ?? ''} onChange={v => setTaskId(v || null)}
          options={[{ value: '', label: L.all }, ...tasks]}
        />
      </div>
      <button
        type="button" className="ag-tap" aria-pressed={stageFilter === 'all'} data-live-allsteps onClick={() => setStageFilter(stageFilter === 'all' ? (LIVE_STAGES.find(s => columns[s].length > 0) ?? 'running') : 'all')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 30, padding: '0 12px',
          borderRadius: 999, fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
          border: `1px solid ${stageFilter === 'all' ? 'var(--anthropic-orange)' : 'var(--border)'}`,
          background: stageFilter === 'all' ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
          color: stageFilter === 'all' ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)',
        }}
      >{L.allSteps}</button>
      <button
        type="button" className="ag-tap" aria-pressed={onlyActive} onClick={() => setOnlyActive(v => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 30, padding: '0 12px',
          borderRadius: 999, fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
          border: `1px solid ${onlyActive ? 'var(--anthropic-orange)' : 'var(--border)'}`,
          background: onlyActive ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
          color: onlyActive ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)',
        }}
      ><span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--anthropic-orange)' }} />{L.onlyActive}</button>
    </div>
  )

  const renderCard = (c: LiveCard) => {
    const eta = etaText(c.d.eta, lang)
    const agent = c.agents[0]
    const queued = isQueued(c)
    const pos = queuePosition(cards, c)
    const pills = cardPills(c, accountOf, L.account)
    const stateWord = LIVE_STATE_LABEL[c.liveState][pt ? 'pt' : 'en']
    const grey = 'var(--text-tertiary)'
    return (
      <button
        key={c.d.key} type="button" data-live-card={c.d.key} data-stage={c.d.stage} data-alert={c.alert ? '1' : undefined} data-queued={queued ? '1' : undefined}
        onClick={() => open(c)}
        style={{
          ...surface, display: 'grid', gap: 6, textAlign: 'left', width: '100%', padding: isMobile ? '10px 12px' : '8px 8px',
          cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', minWidth: 0,
          border: queued ? '1px dashed var(--border)' : `1px solid ${c.alert ? 'var(--accent-red, #ff5f5f)' : 'var(--border)'}`,
          ...(queued ? { opacity: 0.62 } : {}),
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 12.5, overflowWrap: 'anywhere' }}>{c.d.title}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{c.d.subtaskId ? c.d.taskTitle : ''}</span>
        {queued ? (
          <span style={{ display: 'grid', gap: 2, fontSize: 11.5 }}>
            <b data-live-queued style={{ letterSpacing: '.04em', color: grey }}>{L.queued}{pos ? ` · ${pos}${pt ? 'º' : pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th'}` : ''}</b>
            <span style={{ color: grey }}>{L.waitingSlot}</span>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: STATE_COLOR[c.liveState], flexShrink: 0 }} />
            {stateWord}{agent && c.agents.length > 1 ? ` · ${c.agents.length}` : ''}
          </span>
        )}
        {pills.runtime && <span data-live-pill="runtime" style={{ ...pill(harnessColor(agent?.harness ?? c.d.harnesses[0] ?? '')), width: 'fit-content', maxWidth: '100%', overflowWrap: 'anywhere' }}>{pills.runtime}</span>}
        {pills.account && <span data-live-pill="account" style={{ ...pill(), width: 'fit-content', maxWidth: '100%', overflowWrap: 'anywhere' }}>{pills.account}</span>}
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          <span>{L.inStage} <b style={{ color: queued ? grey : 'var(--text-primary)', fontWeight: 600 }}>{c.d.stage === 'published' ? '—' : fmtSpan(c.d.stageSinceMs === null ? null : nowMs - c.d.stageSinceMs)}</b></span>
          {!queued && <span>{L.total} <b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{c.d.stage === 'published' ? '—' : fmtSpan(c.d.startedAtMs === null ? null : nowMs - c.d.startedAtMs)}</b></span>}
        </span>
        {!queued && (
          <span
            title={eta.title}
            style={{ fontSize: 11, padding: '3px 7px', borderRadius: 5, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange-light)' }}
          >{c.d.stage === 'published' && c.d.deliveredAtMs ? `${L.delivered} ${fmtClock(c.d.deliveredAtMs)}` : eta.line}</span>
        )}
        {c.d.blockedReason && <span style={{ fontSize: 11, color: 'var(--accent-red, #ff5f5f)' }}>{c.d.blockedReason}</span>}
        {c.d.lastAction && !queued && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }} title={L.last}>↳ {c.d.lastAction.text}</span>}
      </button>
    )
  }

  const header = (
    <div style={{ display: 'grid', gap: 10 }}>
      {!compact && <LeadersBand leaders={reply.leaders ?? []} lang={lang} onOpen={id => navigate(`/sessions/${encodeURIComponent(id)}`)} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 14, fontWeight: 650 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-red, #ff5f5f)' }} />{L.title}
        </span>
        <span data-live-summary style={{ fontSize: 12, color: 'var(--text-tertiary)', flex: 1, minWidth: 220 }}>{summaryLine}</span>
        {!isMobile && filters}
      </div>
      {isMobile && filters}
    </div>
  )

  if (reply.deliveries.length === 0) return <div style={{ display: 'grid', gap: 12 }}>{header}<Note text={L.none} /></div>

  if (isMobile) {
    const chip = (active: boolean): React.CSSProperties => ({
      flex: '0 0 auto', minHeight: 32, padding: '0 14px', borderRadius: 999, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
      border: `1px solid ${active ? 'transparent' : 'var(--border)'}`,
      background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-card)',
      color: active ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)',
      fontWeight: active ? 600 : 400,
    })
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        {header}
        <div className="ag-noscroll" role="tablist" style={{ display: 'flex', gap: 6, overflowX: 'auto', margin: '0 -12px', padding: '0 12px', scrollbarWidth: 'none' }}>
          <button role="tab" className="ag-tap" aria-selected={stageFilter === 'all'} onClick={() => setStageFilter('all')} style={chip(stageFilter === 'all')}>{L.allSteps} · {shown.length}</button>
          {LIVE_STAGES.map(s => (
            <button key={s} role="tab" className="ag-tap" aria-selected={s === stageFilter} onClick={() => setStageFilter(s)} style={chip(s === stageFilter)}>
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
              {columns[s].map(renderCard)}
            </section>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateRows: 'auto minmax(0, 1fr)', height: compact ? '100%' : 'calc(100dvh - 190px)', minHeight: compact ? 0 : 420 }}>
      {header}
      <div ref={boardRef} className="ag-scroll" data-live-board style={{ display: 'flex', gap: 8, overflowX: 'auto', overflowY: 'auto', alignItems: 'flex-start', padding: '6px 2px 10px', minHeight: 0 }}>
        {visibleStages.map(s => {
          const empty = columns[s].length === 0
          return (
            <section key={s} data-live-column={s} style={{ flex: empty ? '0 0 40px' : '0 0 280px', width: empty ? 40 : 280, minWidth: 0, display: 'grid', gap: 8, alignContent: 'start', opacity: empty ? 0.5 : 1 }}>
              <header style={{ borderTop: `3px solid ${STAGE_LABEL[s].color}`, padding: '8px 4px 2px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', ...(empty ? { flexDirection: 'column', gap: 6 } : {}) }}>
                <span style={{ fontWeight: 700, fontSize: 13, ...(empty ? { writingMode: 'vertical-rl', whiteSpace: 'nowrap' } : {}) }}>{STAGE_LABEL[s][pt ? 'pt' : 'en']}</span>
                <span style={{ ...microLabel, fontSize: 11 }}>{columns[s].length}</span>
              </header>
              {columns[s].map(renderCard)}
            </section>
          )
        })}
      </div>
    </div>
  )
}

const RAW_STATE_WORDS: Record<string, { en: string; pt: string }> = {
  'waiting-approval': { en: 'needs your approval', pt: 'precisa da sua aprovação' },
  waiting: { en: 'waiting for you', pt: 'esperando você' },
  working: { en: 'working', pt: 'trabalhando' },
  running: { en: 'working', pt: 'trabalhando' },
  lost: { en: 'lost', pt: 'perdida' },
  exited: { en: 'finished', pt: 'encerrada' },
  closed: { en: 'finished', pt: 'encerrada' },
  external: { en: 'outside agentop', pt: 'fora do agentop' },
}
/** A fleet state in plain words — never the raw value (`waiting-approval`). */
function stateWordOf(state: string, pt: boolean): string {
  const w = RAW_STATE_WORDS[state]
  return w ? (pt ? w.pt : w.en) : state.replace(/-/g, ' ')
}

function Note({ text }: { text: string }) {
  return <div style={{ ...surface, padding: '14px 12px', fontSize: 12.5, color: 'var(--text-tertiary)', textAlign: 'center' }}>{text}</div>
}

/**
 * The LEADERS band — apart from the delivery columns on purpose: a leader follows and decides, it does
 * not execute a delivery, so it is never a card. Shows what each is doing now, the workers it runs and
 * what waits on a decision (each opens the session that is waiting).
 */
function LeadersBand({ leaders, lang, onOpen }: { leaders: readonly LeaderRecord[]; lang: 'pt' | 'en'; onOpen: (id: string) => void }) {
  const pt = lang === 'pt'
  const mobile = useIsMobile()
  const [open, setOpen] = useState(true)
  if (leaders.length === 0) return null
  const awaiting = leaders.reduce((n, l) => n + l.awaiting.length, 0)
  return (
    <section data-live-leaders style={{ ...surface, display: 'grid', gap: 0 }}>
      <button
        type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} className="ag-tap"
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--text-primary)', textAlign: 'left' }}
      >
        <SessionChip color="var(--accent-purple)">{pt ? 'LÍDERES' : 'LEADERS'}</SessionChip>
        {mobile ? <span style={{ flex: 1 }} /> : <span style={{ color: 'var(--text-tertiary)', flex: 1, minWidth: 0 }}>{pt ? 'acompanham e decidem, não executam entregas' : 'follow and decide, they do not execute deliveries'}</span>}
        {awaiting > 0 && <span style={{ ...pill('var(--anthropic-orange)'), fontWeight: 600 }}>{awaiting} {pt ? 'aguardando decisão' : 'awaiting a decision'}</span>}
        <span aria-hidden style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .2s' }}>▾</span>
      </button>
      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10, padding: '0 10px 10px' }}>
          {leaders.map(l => (
            <div
              key={l.id} data-live-leader={l.id}
              style={{ ...surface, padding: '10px 12px', display: 'grid', gap: 6, border: `1px solid ${l.awaiting.length ? 'var(--anthropic-orange)' : 'var(--border)'}`, minWidth: 0 }}
            >
              <button type="button" onClick={() => onOpen(l.id)} style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', fontWeight: 700, fontSize: 12.5, overflowWrap: 'anywhere' }}>{l.title}</button>
              <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5, color: 'var(--text-secondary)' }}>
                <span style={pill(harnessColor(l.harness))}>{l.harness}</span>{l.model && <span>{l.model}</span>}
                <span style={{ color: 'var(--text-tertiary)' }}>· {stateWordOf(l.state, pt)}</span>
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{l.currentAction ? <>↳ {l.currentAction}</> : <span style={{ color: 'var(--text-tertiary)' }}>—</span>}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{l.workers.length} {l.workers.length === 1 ? 'worker' : 'workers'}</span>
              {l.workers.length > 0 && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {l.workers.slice(0, 4).map(w => <li key={w.id} style={{ display: 'flex', gap: 6, minWidth: 0 }}><span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>{stateWordOf(w.state, pt)}</span><span style={{ overflowWrap: 'anywhere' }}>{w.title}</span></li>)}
                </ul>
              )}
              {l.awaiting.map(a => (
                <button key={a.id} type="button" onClick={() => onOpen(a.id)} className="ag-tap"
                  style={{ textAlign: 'left', fontFamily: 'inherit', fontSize: 12, color: 'var(--anthropic-orange-light)', background: 'var(--anthropic-orange-dim)', border: 0, borderRadius: 5, padding: '4px 8px', cursor: 'pointer', overflowWrap: 'anywhere' }}
                >{pt ? 'decidir' : 'decide'}: {a.title}</button>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
