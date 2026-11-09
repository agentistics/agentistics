/**
 * LiveLeaders — the Líderes pill of the Live view (owner-approved preview real.html, item t).
 *
 * A compact pill next to the "Live Delivery" title: "Líderes N" and three dot counters (working /
 * waiting / blocked) counted from the REAL worker states. Clicking it opens a dropdown OVER the board
 * (400 px, it pushes no column) that closes on an outside click or Escape. Inside: one card per
 * leader, COLLAPSED by default (dot, name, N workers, its own dot counters, publication estimate);
 * opening one shows harness · model · effort · account and one plain ROW per worker (dot · short
 * title · reason or time) — not pills. Clicking a worker row closes the dropdown and takes you to ITS
 * card on the board; when your filters hide that card, the row says so instead of doing nothing.
 *
 * Leaders are not deliveries: they have no card on the board, which is why they live here.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Crown, CornerDownRight } from 'lucide-react'
import { humanizeAction, plainLeaderName, shortTitle } from '@agentistics/core'
import { accountDisplayName } from '../../lib/planLimits'
import { surface } from './board'
import { modelDisplay } from '../../lib/modelDisplay'
import { fmtClock, fmtSpan, STAGE_LABEL, type LeaderRecord, type LeaderWorker, type RuntimeFacts, type WorkerWord } from './liveDeliveryModel'
import { BLOCK_WORD, leaderCounts, readOpenLeaders, workerWordOf, workerWordText, writeOpenLeaders, type LocateAnswer } from './liveCardModel'

const WORD_ORDER: readonly WorkerWord[] = ['needs-you', 'working', 'blocked', 'awaiting-review', 'delivered', 'idle']
const GREEN = 'var(--accent-green, #3ecf8e)'
const BLOCKED = 'rgb(194,65,12)'
const MUTED = 'var(--text-tertiary)'
const WORD_COLOR: Record<WorkerWord, string> = {
  working: GREEN, blocked: BLOCKED, 'needs-you': 'var(--accent-red, #ff5f5f)',
  'awaiting-review': MUTED, delivered: MUTED, idle: MUTED,
}
const LEADER_STATE: Record<string, { pt: string; en: string }> = {
  'waiting-approval': { pt: 'precisa da sua aprovação', en: 'needs your approval' },
  waiting: { pt: 'esperando', en: 'waiting' },
  working: { pt: 'trabalhando', en: 'working' },
  running: { pt: 'trabalhando', en: 'working' },
  lost: { pt: 'perdida', en: 'lost' },
  unknown: { pt: 'sem sinal', en: 'no signal' },
}
const leaderState = (s: string, pt: boolean) => LEADER_STATE[s]?.[pt ? 'pt' : 'en'] ?? s.replace(/-/g, ' ')
const reduce = (): boolean => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

const EDGE = 12
/** PURE: the dropdown's width — 400 px, or what the screen leaves. */
export const dropdownWidth = (viewport: number): number => Math.max(220, Math.min(400, viewport - 2 * EDGE))
/** PURE: how far left of its button the dropdown must start so its right edge stays on screen (never pushes it off the left). */
export function dropdownShift(o: { viewport: number; left: number; width: number }): number {
  const overflow = o.left + o.width - (o.viewport - EDGE)
  return overflow > 0 ? -Math.min(overflow, Math.max(0, o.left - EDGE)) : 0
}

export const wordOfWorker = (w: LeaderWorker): WorkerWord => w.word ?? workerWordOf(w.state, w.stage)

/** PURE: [{word, n}] in reading order, only the states that exist. */
export function workerCounts(ws: readonly LeaderWorker[]): { word: WorkerWord; n: number }[] {
  return WORD_ORDER.map(word => ({ word, n: ws.filter(w => wordOfWorker(w) === word).length })).filter(x => x.n > 0)
}

/** PURE: the dropdown's first line — "5 workers: 2 trabalhando · 2 esperando · 1 bloqueado". */
export function dropdownSummary(leaders: readonly LeaderRecord[], pt: boolean): string {
  const c = leaderCounts(leaders)
  const parts = [
    c.working ? `${c.working} ${pt ? 'trabalhando' : 'working'}` : null,
    c.waiting ? `${c.waiting} ${pt ? 'esperando' : 'waiting'}` : null,
    c.blocked ? `${c.blocked} ${pt ? (c.blocked === 1 ? 'bloqueado' : 'bloqueados') : 'blocked'}` : null,
  ].filter(Boolean)
  return `${c.workers} ${c.workers === 1 ? 'worker' : 'workers'}${parts.length ? `: ${parts.join(' · ')}` : ''}`
}

/** The harness·model·effort of a leader, with the harness's own default marked when it was not asked for. */
export function leaderRuntime(l: LeaderRecord, runtime: Record<string, RuntimeFacts> | undefined, pt: boolean): string {
  const f = runtime?.[l.harness]
  const dflt = pt ? 'padrão' : 'default'
  return [
    l.harness,
    (l.model ? modelDisplay(l.harness, l.model) : null) ?? (f?.model ? `${modelDisplay(l.harness, f.model) ?? f.model} (${dflt})` : (pt ? 'modelo padrão' : 'default model')),
    l.effort ?? (f?.effortConcept === false ? null : f?.effort ? `${f.effort} (${dflt})` : f?.effortConcept ? (pt ? 'esforço padrão' : 'default effort') : null),
  ].filter(Boolean).join(' · ')
}

/** The right-hand fact of a worker row: how long it has been working here, or what it waits on. */
export function workerInfo(w: LeaderWorker, nowMs: number, pt: boolean): string {
  const word = wordOfWorker(w)
  const stage = w.stage ? STAGE_LABEL[w.stage][pt ? 'pt' : 'en'].toLowerCase() : null
  switch (word) {
    case 'working': return w.stageSinceMs && stage ? `${fmtSpan(nowMs - w.stageSinceMs)} ${pt ? 'em' : 'in'} ${stage}` : ''
    case 'blocked': return w.blockReason ? BLOCK_WORD[w.blockReason][pt ? 'pt' : 'en'] : (pt ? 'bloqueado' : 'blocked')
    case 'awaiting-review': return pt ? 'revisão do líder' : 'leader review'
    case 'delivered': return pt ? 'entregou' : 'delivered'
    case 'needs-you': return pt ? 'precisa de você' : 'needs you'
    default: return w.stage === 'queue' ? (pt ? 'vez na máquina' : 'waiting for a slot') : ''
  }
}

const Dot = ({ color, size = 7 }: { color: string; size?: number }) => <i aria-hidden style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0 }} />
const Counter = ({ color, n, title, size }: { color: string; n: number; title: string; size?: number }) => (
  <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: size ? 3 : 4, color: color === BLOCKED ? BLOCKED : MUTED }}><Dot color={color} size={size} />{n}</span>
)

export function LiveLeaders({ leaders, runtime, accountLabels, nowMs, lang, locate, onLocate, onOpen, mobile }: {
  leaders: readonly LeaderRecord[]
  runtime?: Record<string, RuntimeFacts>
  accountLabels?: Record<string, string>
  nowMs: number
  lang: 'pt' | 'en'
  /** Where a worker row leads (pure, decided by the board that knows what its filters show). */
  locate: (w: LeaderWorker) => LocateAnswer
  /** Take the board to that card (the board opens its column and scrolls to it). */
  onLocate: (a: Extract<LocateAnswer, { kind: 'card' }>) => void
  onOpen: (sessionId: string) => void
  /** Phone: 44 px targets and a dropdown that stays inside the screen. */
  mobile?: boolean
}) {
  const pt = lang === 'pt'
  const [open, setOpen] = useState(false)
  const [shift, setShift] = useState(0)
  const [openMap, setOpenMap] = useState(() => readOpenLeaders())
  const [notes, setNotes] = useState<Record<string, string>>({})
  const wrap = useRef<HTMLSpanElement>(null)
  const toggle = (id: string) => setOpenMap(m => { const n = { ...m, [id]: !m[id] }; writeOpenLeaders(n); return n })
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  const titleOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of leaders) { m.set(l.id, l.title); for (const w of l.workers) m.set(w.id, w.title) }
    return (id: string) => m.get(id)
  }, [leaders])
  // The dropdown opens under its button; wherever the button sits, the box must stay inside the screen (QA LOW 10:
  // at 390 px it started at x=28 and ended at 394).
  useLayoutEffect(() => {
    if (!open || !wrap.current) return
    const place = () => {
      const w = wrap.current
      if (!w) return
      const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1
      setShift(dropdownShift({ viewport: window.innerWidth / zoom, left: w.getBoundingClientRect().left, width: dropdownWidth(window.innerWidth / zoom) }))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])
  if (leaders.length === 0) return null
  const counts = leaderCounts(leaders)
  const awaiting = leaders.reduce((n, l) => n + l.awaiting.length, 0)

  const pick = (w: LeaderWorker) => {
    const a = locate(w)
    if (a.kind === 'card') { setOpen(false); onLocate(a); return }
    setNotes(n => ({ ...n, [w.id]: a.kind === 'filtered' ? (pt ? 'não está no quadro (filtro)' : 'not on the board (filtered out)') : (pt ? 'sem cartão no quadro' : 'no card on the board') }))
  }

  return (
    <span ref={wrap} data-live-leaders data-open={open ? '1' : '0'} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button" id="live-leaders-head" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(v => !v)} className="ag-tap"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: mobile ? 44 : 32, padding: '0 10px', borderRadius: 999, border: '1px solid var(--accent-purple)', background: 'none', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }}
      >
        <span data-live-leaders-label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--accent-purple)', fontWeight: 600 }}><Crown size={12} aria-hidden />{pt ? 'Líderes' : 'Leaders'} {leaders.length}</span>
        <span data-live-leaders-counts style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Counter color={GREEN} n={counts.working} title={pt ? 'workers trabalhando' : 'workers working'} />
          <Counter color={MUTED} n={counts.waiting} title={pt ? 'workers esperando' : 'workers waiting'} />
          <Counter color={BLOCKED} n={counts.blocked} title={pt ? 'workers bloqueados' : 'workers blocked'} />
        </span>
        {awaiting > 0 && <span title={pt ? 'esperando uma decisão sua' : 'waiting for a decision from you'} style={{ color: 'var(--anthropic-orange-light)', fontWeight: 600 }}>{awaiting} {pt ? 'decisão' : 'decision'}</span>}
        <ChevronDown size={13} aria-hidden style={{ color: MUTED, transition: reduce() ? 'none' : 'transform .2s', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      <div
        data-live-leaders-dropdown role="dialog" aria-label={pt ? 'Líderes' : 'Leaders'} aria-hidden={!open}
        style={{
          position: 'absolute', left: shift, top: 'calc(100% + 6px)', width: 'min(400px, calc(100vw / var(--ui-zoom, 1) - 24px))', zIndex: 30, display: 'grid', gap: 8, padding: 8,
          ...surface, background: 'var(--bg-primary, #0d0d10)', boxShadow: '0 12px 32px rgba(0,0,0,.5)', boxSizing: 'border-box',
          opacity: open ? 1 : 0, transform: open ? 'none' : 'translateY(-6px)', pointerEvents: open ? 'auto' : 'none', visibility: open ? 'visible' : 'hidden',
          transition: reduce() ? 'none' : 'opacity .18s, transform .18s, visibility .18s',
        }}
      >
        <span style={{ fontSize: 10.5, color: MUTED }}>{dropdownSummary(leaders, pt)} — {pt ? 'abra um líder; clique num worker para achar o cartão' : 'open a leader; click a worker to find its card'}</span>
        {open && leaders.map(l => (
          <LeaderCard key={l.id} l={l} open={!!openMap[l.id]} onToggle={() => toggle(l.id)} runtime={runtime} accountLabels={accountLabels}
            nowMs={nowMs} pt={pt} titleOf={titleOf} onOpen={onOpen} onPick={pick} notes={notes} mobile={!!mobile} />
        ))}
      </div>
    </span>
  )
}

function LeaderCard({ l, open, onToggle, runtime, accountLabels, nowMs, pt, titleOf, onOpen, onPick, notes, mobile }: {
  l: LeaderRecord; open: boolean; onToggle: () => void; runtime?: Record<string, RuntimeFacts>; accountLabels?: Record<string, string>
  nowMs: number; pt: boolean; titleOf: (id: string) => string | undefined; onOpen: (id: string) => void
  onPick: (w: LeaderWorker) => void; notes: Record<string, string>; mobile: boolean
}) {
  const wc = leaderCounts([l])
  const name = plainLeaderName(l.title)
  const action = l.currentAction ? humanizeAction(l.currentAction, pt ? 'pt' : 'en', titleOf) : null
  const account = l.accountId && accountLabels ? accountDisplayName(accountLabels, l.harness, l.accountId) : null
  const dot = l.state === 'working' || l.state === 'running' ? GREEN : l.state === 'waiting-approval' ? 'var(--accent-red, #ff5f5f)' : MUTED
  const facts = [leaderRuntime(l, runtime, pt), account ? `${pt ? 'conta' : 'account'} ${account}` : null].filter(Boolean).join(' · ')
  return (
    <div data-live-leader={l.id} data-open={open ? '1' : '0'} style={{ ...surface, padding: '7px 10px', minWidth: 0 }}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="ag-tap" title={`${l.title} — ${leaderState(l.state, pt)}`}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: mobile ? 44 : undefined, background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', fontSize: 12.5, textAlign: 'left', minWidth: 0 }}>
        <Dot color={dot} size={8} />
        <b style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}><Crown size={12} aria-hidden style={{ color: 'var(--accent-purple)', flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span></b>
        <span data-live-leader-workers style={{ color: MUTED, fontSize: 11, whiteSpace: 'nowrap' }}>{l.workers.length} {l.workers.length === 1 ? 'worker' : 'workers'}</span>
        <span style={{ display: 'inline-flex', gap: 8, fontSize: 11 }}>
          <Counter color={GREEN} n={wc.working} title={pt ? 'trabalhando' : 'working'} size={6} />
          <Counter color={MUTED} n={wc.waiting} title={pt ? 'esperando' : 'waiting'} size={6} />
          <Counter color={BLOCKED} n={wc.blocked} title={pt ? 'bloqueado' : 'blocked'} size={6} />
        </span>
        {l.publishEtaMs ? <span data-live-publish title={pt ? 'estimativa de publicação do que seus workers executam' : 'estimated publication of what its workers run'} style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--anthropic-orange-light)', whiteSpace: 'nowrap' }}>{pt ? 'publica' : 'publishes'} ~{fmtClock(l.publishEtaMs)}</span> : <span style={{ marginLeft: 'auto' }} />}
        <ChevronRight size={13} aria-hidden style={{ color: MUTED, flexShrink: 0, transition: reduce() ? 'none' : 'transform .2s', transform: open ? 'rotate(90deg)' : 'none' }} />
      </button>
      <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: reduce() ? 'none' : 'grid-template-rows .22s ease' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          {open && (
            <div data-live-leader-body style={{ display: 'grid', gap: 1 }}>
              <span data-live-pill="runtime" style={{ display: 'block', fontSize: 10.5, color: MUTED, padding: '5px 0 3px 16px', overflowWrap: 'anywhere' }}>{facts}</span>
              {action && <span style={{ display: 'flex', gap: 5, fontSize: 10.5, color: MUTED, padding: '0 0 3px 16px', overflowWrap: 'anywhere' }}><CornerDownRight size={11} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} /><span>{action}</span></span>}
              {l.workers.length === 0 && <span style={{ fontSize: 11.5, color: MUTED, padding: '4px 0 4px 16px' }}>{pt ? 'Nenhum worker vivo agora.' : 'No live worker right now.'}</span>}
              <div style={{ display: 'grid', gap: 1, paddingLeft: 10 }}>
                {l.workers.map(w => {
                  const word = wordOfWorker(w)
                  const note = notes[w.id]
                  return (
                    <button key={w.id} type="button" onClick={() => onPick(w)} className="ag-tap" title={note ?? (pt ? 'mostrar no quadro' : 'show on the board')} data-live-worker={w.id} data-word={word}
                      style={{ display: 'grid', gridTemplateColumns: '8px 1fr auto', gap: 8, alignItems: 'center', width: '100%', minHeight: mobile ? 44 : undefined, padding: '4px 6px', border: 0, borderRadius: 6, background: 'none', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11.5, textAlign: 'left', cursor: 'pointer', minWidth: 0 }}>
                      <Dot color={WORD_COLOR[word]} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortTitle(w.subtask ?? w.title, 56)}</span>
                      <span data-live-worker-info style={{ color: note ? 'var(--anthropic-orange-light)' : MUTED, whiteSpace: 'nowrap', fontSize: 11 }}>{note ?? (workerInfo(w, nowMs, pt) || workerWordText(word, pt))}</span>
                    </button>
                  )
                })}
              </div>
              {l.awaiting.map(a => (
                <button key={a.id} type="button" onClick={() => onOpen(a.id)} className="ag-tap"
                  style={{ textAlign: 'left', fontFamily: 'inherit', fontSize: 12, color: 'var(--anthropic-orange-light)', background: 'var(--anthropic-orange-dim)', border: 0, borderRadius: 5, padding: '4px 8px', minHeight: mobile ? 44 : undefined, margin: '4px 0 0 10px', cursor: 'pointer', overflowWrap: 'anywhere' }}
                >{pt ? 'decidir' : 'decide'}: {shortTitle(a.title, 60)}</button>
              ))}
              <button type="button" onClick={() => onOpen(l.id)} className="ag-tap" style={{ justifySelf: 'start', margin: '3px 0 0 16px', minHeight: mobile ? 44 : undefined, background: 'none', border: 0, padding: '2px 0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, color: 'var(--anthropic-orange-light)' }}>{pt ? 'abrir a sessão do líder' : 'open the leader\'s session'}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
