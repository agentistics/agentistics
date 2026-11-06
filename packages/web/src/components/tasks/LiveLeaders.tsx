/**
 * LiveLeaders — the LEADERS band of the Live view, apart from the delivery columns on purpose: a
 * leader follows and decides, it does not execute a delivery, so it is never a column card.
 *
 * Shape (owner, preview real.html): the band starts CLOSED as one summary line — "2 líderes · 5
 * workers · 3 trabalhando · 1 bloqueado". Opened, it is one compact row per leader (name, how it is
 * and how its workers are counted, harness·model·effort·account·publication); clicking a leader opens
 * ITS workers, each a link to its session. Both folds animate (grid-template-rows) and respect
 * prefers-reduced-motion. A leader's open/closed choice is remembered.
 */

import { useMemo, useState } from 'react'
import { Crown } from 'lucide-react'
import { humanizeAction, plainLeaderName, shortTitle } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { accountDisplayName } from '../../lib/planLimits'
import { SessionChip } from '../sessions/RoleChip'
import { pill, surface } from './board'
import { fmtClock, fmtSpan, STAGE_LABEL, type LeaderRecord, type LeaderWorker, type RuntimeFacts, type WorkerWord } from './liveDeliveryModel'
import { BLOCK_WORD, readOpenLeaders, workerWordOf, workerWordText, writeOpenLeaders } from './liveCardModel'

const WORD_ORDER: readonly WorkerWord[] = ['needs-you', 'working', 'blocked', 'awaiting-review', 'delivered', 'idle']
const WORD_COLOR: Record<WorkerWord, string> = {
  'needs-you': 'var(--accent-red, #ff5f5f)', working: 'var(--accent-green, #3ecf8e)', blocked: 'var(--accent-red, #ff5f5f)',
  'awaiting-review': 'var(--accent-purple, #b78bff)', delivered: 'var(--accent-blue, #4c9aff)', idle: 'var(--text-tertiary)',
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
const MUTED = 'var(--text-tertiary)'

export const wordOfWorker = (w: LeaderWorker): WorkerWord => w.word ?? workerWordOf(w.state, w.stage)

/** PURE: [{word, n}] in reading order, only the states that exist. */
export function workerCounts(ws: readonly LeaderWorker[]): { word: WorkerWord; n: number }[] {
  return WORD_ORDER.map(word => ({ word, n: ws.filter(w => wordOfWorker(w) === word).length })).filter(x => x.n > 0)
}

/** PURE: the band's closed line — "2 líderes · 5 workers · 3 trabalhando · 1 bloqueado". */
export function bandSummary(leaders: readonly LeaderRecord[], pt: boolean): string {
  const ws = leaders.flatMap(l => l.workers)
  const parts = [
    `${leaders.length} ${pt ? (leaders.length === 1 ? 'líder' : 'líderes') : (leaders.length === 1 ? 'leader' : 'leaders')}`,
    `${ws.length} ${ws.length === 1 ? 'worker' : 'workers'}`,
    ...workerCounts(ws).map(c => `${c.n} ${workerWordText(c.word, pt)}`),
  ]
  return parts.join(' · ')
}

/** The harness·model·effort of a leader, with the harness's own default marked when it was not asked for. */
export function leaderRuntime(l: LeaderRecord, runtime: Record<string, RuntimeFacts> | undefined, pt: boolean): string {
  const f = runtime?.[l.harness]
  const dflt = pt ? 'padrão' : 'default'
  return [
    l.harness,
    l.model ?? (f?.model ? `${f.model} (${dflt})` : (pt ? 'modelo padrão' : 'default model')),
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

const fold = (open: boolean): React.CSSProperties => ({ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows .22s ease' })
const reduce = (): boolean => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

export function LiveLeaders({ leaders, runtime, accountLabels, nowMs, lang, onOpen }: {
  leaders: readonly LeaderRecord[]
  runtime?: Record<string, RuntimeFacts>
  accountLabels?: Record<string, string>
  nowMs: number
  lang: 'pt' | 'en'
  onOpen: (sessionId: string) => void
}) {
  const pt = lang === 'pt'
  const mobile = useIsMobile()
  const [band, setBand] = useState(false)
  const [openMap, setOpenMap] = useState(() => readOpenLeaders())
  const toggle = (id: string) => setOpenMap(m => { const n = { ...m, [id]: !m[id] }; writeOpenLeaders(n); return n })
  const titleOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of leaders) { m.set(l.id, l.title); for (const w of l.workers) m.set(w.id, w.title) }
    return (id: string) => m.get(id)
  }, [leaders])
  if (leaders.length === 0) return null
  const awaiting = leaders.reduce((n, l) => n + l.awaiting.length, 0)
  const anim = reduce() ? { transition: 'none' } : {}
  return (
    <section data-live-leaders data-open={band ? '1' : '0'} style={{ ...surface, padding: '6px 12px', display: 'grid' }}>
      <button
        type="button" id="live-leaders-head" aria-expanded={band} onClick={() => setBand(v => !v)} className="ag-tap"
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0', background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--text-primary)', textAlign: 'left', minWidth: 0 }}
      >
        <SessionChip color="var(--accent-purple)">{pt ? 'LÍDERES' : 'LEADERS'}</SessionChip>
        <span data-live-leaders-summary style={{ color: MUTED, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: mobile ? 'normal' : 'nowrap' }}>{bandSummary(leaders, pt)}</span>
        {awaiting > 0 && <span style={{ ...pill('var(--anthropic-orange)'), fontWeight: 600 }}>{awaiting} {pt ? 'aguardando decisão' : 'awaiting a decision'}</span>}
        <span aria-hidden style={{ color: MUTED, transition: reduce() ? 'none' : 'transform .2s', transform: band ? 'rotate(180deg)' : 'none' }}>▾</span>
      </button>
      <div style={{ ...fold(band), ...anim }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          {band && leaders.map(l => (
            <LeaderRow key={l.id} l={l} open={!!openMap[l.id]} onToggle={() => toggle(l.id)} runtime={runtime} accountLabels={accountLabels} nowMs={nowMs} pt={pt} mobile={mobile} titleOf={titleOf} onOpen={onOpen} />
          ))}
        </div>
      </div>
    </section>
  )
}

function LeaderRow({ l, open, onToggle, runtime, accountLabels, nowMs, pt, mobile, titleOf, onOpen }: {
  l: LeaderRecord; open: boolean; onToggle: () => void; runtime?: Record<string, RuntimeFacts>; accountLabels?: Record<string, string>
  nowMs: number; pt: boolean; mobile: boolean; titleOf: (id: string) => string | undefined; onOpen: (id: string) => void
}) {
  const counts = workerCounts(l.workers)
  const name = plainLeaderName(l.title)
  const action = l.currentAction ? humanizeAction(l.currentAction, pt ? 'pt' : 'en', titleOf) : null
  const account = l.accountId && accountLabels ? accountDisplayName(accountLabels, l.harness, l.accountId) : null
  const facts = [leaderRuntime(l, runtime, pt), account, l.publishEtaMs ? `${pt ? 'publicação' : 'publication'} ~${fmtClock(l.publishEtaMs)}` : null].filter(Boolean).join(' · ')
  const dot = l.state === 'working' || l.state === 'running' ? 'var(--accent-green, #3ecf8e)' : l.state === 'waiting-approval' ? 'var(--accent-red, #ff5f5f)' : MUTED
  const summary = [
    leaderState(l.state, pt),
    `${l.workers.length} ${l.workers.length === 1 ? 'worker' : 'workers'}`,
    ...counts.map(c => `${c.n} ${workerWordText(c.word, pt)}`),
  ].join(' · ')
  return (
    <div data-live-leader={l.id} data-open={open ? '1' : '0'} style={{ borderTop: '1px solid var(--border)', padding: '7px 2px', minWidth: 0 }}>
      <button
        type="button" aria-expanded={open} onClick={onToggle} className="ag-tap" title={l.title}
        style={{ display: 'grid', gridTemplateColumns: mobile ? 'auto 1fr auto' : 'auto 1fr auto auto', gap: 10, alignItems: 'center', width: '100%', background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', fontSize: 12, textAlign: 'left', minWidth: 0 }}
      >
        <b style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Crown size={12} aria-hidden style={{ color: 'var(--accent-purple)' }} />{name}</b>
        <span data-live-leader-summary style={{ color: MUTED, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: mobile ? 'normal' : 'nowrap' }}>
          <span aria-hidden style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: dot, marginRight: 5 }} />{summary}
        </span>
        {!mobile && <span data-live-pill="runtime" style={{ color: MUTED, fontSize: 11, whiteSpace: 'nowrap' }}>{facts}</span>}
        <span aria-hidden style={{ color: MUTED, transition: reduce() ? 'none' : 'transform .2s', transform: open ? 'rotate(90deg)' : 'none' }}>▸</span>
      </button>
      {mobile && <div data-live-pill="runtime" style={{ color: MUTED, fontSize: 11, marginTop: 2, overflowWrap: 'anywhere' }}>{facts}</div>}
      <div style={{ ...fold(open), ...(reduce() ? { transition: 'none' } : {}) }}>
        <div style={{ overflow: 'hidden', minHeight: 0, paddingLeft: mobile ? 0 : 22 }}>
          {open && (
            <div data-live-leader-body style={{ display: 'grid', gap: 1, paddingTop: 4 }}>
              {(l.taskTitle || action) && (
                <div style={{ fontSize: 11, color: MUTED, padding: '2px 0 4px', overflowWrap: 'anywhere' }}>
                  {l.taskTitle && <b style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{shortTitle(l.taskTitle, 60)}</b>}{action ? <>{l.taskTitle ? ' · ' : ''}↳ {action}</> : null}
                </div>
              )}
              {l.workers.length === 0 && <span style={{ fontSize: 11.5, color: MUTED }}>{pt ? 'Nenhum worker vivo agora.' : 'No live worker right now.'}</span>}
              {l.workers.map(w => (
                <button key={w.id} type="button" onClick={() => onOpen(w.id)} className="ag-tap" title={w.title} data-live-worker={w.id}
                  style={{ display: 'grid', gridTemplateColumns: mobile ? '82px 1fr' : '96px 1fr auto', gap: 8, fontSize: 11, padding: '3px 0', background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', textAlign: 'left', minWidth: 0 }}>
                  <span style={{ color: WORD_COLOR[wordOfWorker(w)] }}>{workerWordText(wordOfWorker(w), pt)}</span>
                  <span style={{ overflowWrap: 'anywhere' }}>{shortTitle(w.subtask ?? w.title, 56)}</span>
                  <span style={{ color: MUTED, gridColumn: mobile ? '2' : undefined }}>{workerInfo(w, nowMs, pt)}</span>
                </button>
              ))}
              {l.awaiting.map(a => (
                <button key={a.id} type="button" onClick={() => onOpen(a.id)} className="ag-tap"
                  style={{ textAlign: 'left', fontFamily: 'inherit', fontSize: 12, color: 'var(--anthropic-orange-light)', background: 'var(--anthropic-orange-dim)', border: 0, borderRadius: 5, padding: '4px 8px', marginTop: 4, cursor: 'pointer', overflowWrap: 'anywhere' }}
                >{pt ? 'decidir' : 'decide'}: {shortTitle(a.title, 60)}</button>
              ))}
              <button type="button" onClick={() => onOpen(l.id)} className="ag-tap" style={{ justifySelf: 'start', marginTop: 3, background: 'none', border: 0, padding: '2px 0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, color: 'var(--anthropic-orange-light)' }}>{pt ? 'abrir a sessão do líder' : 'open the leader\'s session'}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
