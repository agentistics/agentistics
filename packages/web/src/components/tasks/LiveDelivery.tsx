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

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  fmtClock, type LeaderRecord, type LiveCard, type LiveReply, type LiveStage,
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
} : {
  title: 'Live Delivery', all: 'All tasks', onlyActive: 'only with active agents',
  deliveries: (n: number) => `${n} active ${n === 1 ? 'delivery' : 'deliveries'}`,
  agents: (n: number) => `${n} ${n === 1 ? 'agent working' : 'agents working'}`,
  next: (t: string) => `next delivery expected ${t}`, noNext: 'no delivery has an estimate',
  live: 'updated live', inStage: 'in this stage', total: 'total', empty: 'Nothing in this stage',
  down: 'Could not read the deliveries right now.', refused: 'The board is not available on this profile.',
  loading: 'Loading deliveries…', none: 'No active delivery right now.',
  delivered: 'delivered', last: 'last action',
}

/** The hooks wrapper: the shared fleet stream, the plan-limits account labels and the live read model. */
export function LiveDelivery({ lang }: { lang: 'pt' | 'en' }) {
  const { fleet } = useFleet(lang)
  const plan = usePlanLimits()
  const { reply, error, nowMs } = useLiveDeliveries(fleet.sessions)
  return <LiveDeliveryView lang={lang} reply={reply} error={error} nowMs={nowMs} fleet={fleet.sessions} accountLabels={plan.accountLabels} />
}

/** PURE of data sources: everything it draws comes in as props, so it is tested without mocking a store. */
export function LiveDeliveryView({ lang, reply, error, nowMs, fleet, accountLabels }: {
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
  const [onlyActive, setOnlyActive] = useState(false)
  const [stage, setStage] = useState<LiveStage>('running')

  const cards = useMemo(() => joinLive(reply?.deliveries ?? [], fleet), [reply, fleet])
  const shown = useMemo(() => filterCards(cards, { taskId, onlyActive }), [cards, taskId, onlyActive])
  const columns = useMemo(() => byStage(shown), [shown])
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
    root.querySelectorAll<HTMLElement>('[data-live-card]').forEach(el => {
      const key = el.getAttribute('data-live-card')!
      const stage = el.getAttribute('data-stage') as LiveStage
      const r = el.getBoundingClientRect()
      const prev = seen.current.get(key)
      now.set(key, { stage, box: { left: r.left, top: r.top, width: r.width, height: r.height } })
      if (firstPaint || !prev) return
      const kind = transitionKind(prev.stage, stage)
      if (kind === 'none' || r.width === 0) return
      // Out of sight at either end (scrolled sideways): no ghost over unrelated screen.
      if (!intersects(now.get(key)!.box, view) || !intersects(prev.box, view)) return
      el.style.opacity = '0'
      const back = () => { el.style.opacity = '' }
      if (kind === 'merge-approved') void disintegrate(el, prev.box).then(() => reintegrate(el)).then(back, back)
      else void flyCard(el, prev.box, { fromColor: STAGE_LABEL[prev.stage].color, toColor: STAGE_LABEL[stage].color }).then(back, back)
    })
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
    const harnesses = c.agents.length ? [...new Set(c.agents.map(a => a.harness))] : c.d.harnesses
    const models = c.agents.length ? [...new Set(c.agents.map(a => a.model).filter(Boolean))] : c.d.models
    const accounts = [...new Set(c.agents.map(accountOf).filter((x): x is string => !!x))]
    const stateWord = LIVE_STATE_LABEL[c.liveState][pt ? 'pt' : 'en']
    return (
      <button
        key={c.d.key} type="button" data-live-card={c.d.key} data-stage={c.d.stage} data-alert={c.alert ? '1' : undefined}
        onClick={() => open(c)}
        style={{
          ...surface, display: 'grid', gap: 6, textAlign: 'left', width: '100%', padding: '10px 12px',
          cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', minWidth: 0,
          border: `1px solid ${c.alert ? 'var(--accent-red, #ff5f5f)' : 'var(--border)'}`,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 12.5, overflowWrap: 'anywhere' }}>{c.d.title}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{c.d.subtaskId ? c.d.taskTitle : ''}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: STATE_COLOR[c.liveState], flexShrink: 0 }} />
          {stateWord}{agent && c.agents.length > 1 ? ` · ${c.agents.length}` : ''}
        </span>
        {harnesses.length > 0 && (
          <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5, color: 'var(--text-secondary)' }}>
            {harnesses.map(h => <span key={h} style={pill(harnessColor(h))}>{h}</span>)}
            {models.length > 0 && <span>{models.join(', ')}</span>}
          </span>
        )}
        {accounts.length > 0 && <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{accounts.map(a => <SessionChip key={a}>{a}</SessionChip>)}</span>}
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          <span>{L.inStage} <b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{c.d.stage === 'published' ? '—' : fmtSpan(c.d.stageSinceMs === null ? null : nowMs - c.d.stageSinceMs)}</b></span>
          <span>{L.total} <b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{c.d.stage === 'published' ? '—' : fmtSpan(c.d.startedAtMs === null ? null : nowMs - c.d.startedAtMs)}</b></span>
        </span>
        <span
          title={eta.title}
          style={{ fontSize: 11, padding: '3px 7px', borderRadius: 5, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange-light)' }}
        >{c.d.stage === 'published' && c.d.deliveredAtMs ? `${L.delivered} ${fmtClock(c.d.deliveredAtMs)}` : eta.line}</span>
        {c.d.blockedReason && <span style={{ fontSize: 11, color: 'var(--accent-red, #ff5f5f)' }}>{c.d.blockedReason}</span>}
        {c.d.lastAction && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }} title={L.last}>↳ {c.d.lastAction.text}</span>}
      </button>
    )
  }

  const header = (
    <div style={{ display: 'grid', gap: 10 }}>
      <LeadersBand leaders={reply.leaders ?? []} lang={lang} onOpen={id => navigate(`/sessions/${encodeURIComponent(id)}`)} />
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
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        {header}
        <div className="ag-noscroll" role="tablist" style={{ display: 'flex', gap: 6, overflowX: 'auto', margin: '0 -12px', padding: '0 12px', scrollbarWidth: 'none' }}>
          {LIVE_STAGES.map(s => (
            <button
              key={s} role="tab" className="ag-tap" aria-selected={s === stage} onClick={() => setStage(s)}
              style={{
                flex: '0 0 auto', minHeight: 32, padding: '0 14px', borderRadius: 999, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                border: `1px solid ${s === stage ? 'transparent' : 'var(--border)'}`,
                background: s === stage ? 'var(--anthropic-orange-dim)' : 'var(--bg-card)',
                color: s === stage ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)',
                fontWeight: s === stage ? 600 : 400,
              }}
            >{STAGE_LABEL[s][pt ? 'pt' : 'en']} · {columns[s].length}</button>
          ))}
        </div>
        {columns[stage].length === 0 ? <Note text={L.empty} /> : <div ref={boardRef} style={{ display: 'grid', gap: 10, paddingTop: 6 }}>{columns[stage].map(renderCard)}</div>}
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {header}
      <div ref={boardRef} style={{ display: 'flex', gap: 10, overflowX: 'auto', alignItems: 'flex-start', padding: '6px 2px 6px' }}>
        {LIVE_STAGES.map(s => (
          <section key={s} data-live-column={s} style={{ flex: '1 0 210px', minWidth: 210, display: 'grid', gap: 8, alignContent: 'start' }}>
            <header style={{ borderTop: `3px solid ${STAGE_LABEL[s].color}`, padding: '8px 4px 2px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{STAGE_LABEL[s][pt ? 'pt' : 'en']}</span>
              <span style={{ ...microLabel, fontSize: 11 }}>{columns[s].length}</span>
            </header>
            {columns[s].length === 0
              ? <div style={{ ...surface, padding: '10px 12px', fontSize: 11, color: 'var(--text-tertiary)', borderStyle: 'dashed', textAlign: 'center' }}>—</div>
              : columns[s].map(renderCard)}
          </section>
        ))}
      </div>
    </div>
  )
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
                <span style={{ color: 'var(--text-tertiary)' }}>· {l.state}</span>
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{l.currentAction ? <>↳ {l.currentAction}</> : <span style={{ color: 'var(--text-tertiary)' }}>—</span>}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{l.workers.length} {l.workers.length === 1 ? 'worker' : 'workers'}</span>
              {l.workers.length > 0 && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {l.workers.slice(0, 4).map(w => <li key={w.id} style={{ display: 'flex', gap: 6, minWidth: 0 }}><span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>{w.state}</span><span style={{ overflowWrap: 'anywhere' }}>{w.title}</span></li>)}
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
