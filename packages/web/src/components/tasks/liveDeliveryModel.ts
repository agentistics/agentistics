/**
 * liveDeliveryModel — PURE. The Live Delivery line as the browser draws it: the server's active
 * pieces (`/api/tasks/live`) joined with the fleet's LIVE rows, grouped into the seven stages.
 *
 * The server knows the book (stage, times, ETA); only the fleet knows what an agent is doing this
 * second. The join is by session id, never by name, and a row the fleet no longer carries is
 * simply not live — it is never invented back from the book.
 */

import type { FleetRow } from '../../lib/fleet'

export type LiveStage = 'queue' | 'running' | 'qa' | 'adjust' | 'leader' | 'merge' | 'published'
export const LIVE_STAGES: readonly LiveStage[] = ['queue', 'running', 'qa', 'adjust', 'leader', 'merge', 'published']

export type LiveEta =
  | {
      kind: 'estimate'; atMs: number; plusMinusMs: number; confidence: 'low' | 'medium' | 'high'
      basis: { n: number; scope: 'harness-model' | 'harness'; harness: string; model: string | null; medianMs: number }
    }
  | { kind: 'none'; reason: 'no-history' | 'not-started' | 'beyond-range' }

/** Mirror of the server's `LiveDelivery` (`task-live.ts`). */
export interface LiveDeliveryRecord {
  key: string; taskId: string; taskTitle: string; subtaskId: string | null; title: string
  status: string; stage: LiveStage; stageSinceMs: number | null; startedAtMs: number | null
  sessionIds: string[]; harnesses: string[]; models: string[]; eta: LiveEta
  lastAction: { text: string; atMs: number } | null; blockedReason: string | null; deliveredAtMs: number | null
}
/** Mirror of the server's `LeaderView` (`task-live-view.ts`). Leaders are never deliveries. */
export interface LeaderRecord {
  id: string; title: string; harness: string; model: string | null; state: string
  currentAction: string | null
  workers: { id: string; title: string; state: string }[]
  awaiting: { id: string; title: string }[]
}
export interface LiveReply { generatedAt: string; deliveries: LiveDeliveryRecord[]; leaders?: LeaderRecord[]; samples: number }

export interface LiveAgent {
  id: string; harness: string; model: string | null; effort?: string | null; accountId: string | null
  state: FleetRow['state']; stateLabel: string
}

/** What the card says about the agents, in one word's worth of state. */
export type LiveState = 'working' | 'waiting' | 'needs-you' | 'down' | 'none'

export interface LiveCard {
  d: LiveDeliveryRecord
  agents: LiveAgent[]
  liveState: LiveState
  /** Red border: somebody is blocked on a person, an agent is lost, or the piece is stuck in Adjust. */
  alert: boolean
}

const RUNNING_STATES = new Set<FleetRow['state']>(['working', 'waiting', 'waiting-approval'])

/** PURE: the state a piece shows, from its agents. */
export function liveStateOf(agents: readonly LiveAgent[]): LiveState {
  if (agents.length === 0) return 'none'
  if (agents.some(a => a.state === 'waiting-approval')) return 'needs-you'
  if (agents.some(a => a.state === 'working')) return 'working'
  if (agents.some(a => a.state === 'waiting')) return 'waiting'
  return 'down'
}

export function joinLive(
  deliveries: readonly LiveDeliveryRecord[], fleet: readonly FleetRow[],
): LiveCard[] {
  const byId = new Map(fleet.map(r => [r.id, r]))
  return deliveries.map(d => {
    const agents: LiveAgent[] = d.sessionIds.flatMap(id => {
      const r = byId.get(id)
      return r && RUNNING_STATES.has(r.state) || r && (r.state === 'lost' || r.state === 'unknown')
        ? [{ id: r.id, harness: r.harness, model: r.model ?? null, effort: r.effort ?? null, accountId: r.accountId ?? null, state: r.state, stateLabel: r.stateLabel }]
        : []
    })
    const liveState = liveStateOf(agents)
    const alert = liveState === 'needs-you' || liveState === 'down'
      || (d.stage === 'adjust' && d.blockedReason !== null)
      // Sessions are filed and live in the book, yet the fleet shows none of them running.
      || (d.sessionIds.length > 0 && agents.length === 0 && (d.stage === 'running' || d.stage === 'qa'))
    return { d, agents, liveState, alert }
  })
}

export interface LiveFilters { taskId: string | null; onlyActive: boolean }

/** The Live view's defaults (LIVE.ATALHO): only pieces with active agents, every task, every step. */
export type StageFilter = 'all' | LiveStage
export const LIVE_DEFAULTS: { taskId: string | null; onlyActive: boolean; stage: StageFilter } = { taskId: null, onlyActive: true, stage: 'all' }

/** A piece sitting in the queue column is waiting for a slot: it is drawn dimmed and never gets an ETA verdict. */
export const isQueued = (c: LiveCard): boolean => c.d.stage === 'queue'

/** 1-based place in the queue (oldest first by stage-since, then key); null when the card is not queued. */
export function queuePosition(cards: readonly LiveCard[], c: LiveCard): number | null {
  if (!isQueued(c)) return null
  const q = cards.filter(isQueued).sort((a, b) =>
    (a.d.stageSinceMs ?? Infinity) - (b.d.stageSinceMs ?? Infinity) || a.d.key.localeCompare(b.d.key))
  const i = q.findIndex(x => x.d.key === c.d.key)
  return i < 0 ? null : i + 1
}

/** The two pills of a card, one per line: [harness · model · effort] and [account · name]. Effort only when reported. */
export function cardPills(c: LiveCard, accountOf: (a: LiveAgent) => string | null, accountWord: string): { runtime: string | null; account: string | null } {
  const a = c.agents[0]
  const harness = a ? a.harness : c.d.harnesses[0]
  const model = a ? a.model : c.d.models[0]
  const runtime = harness ? [harness, model, a?.effort].filter(Boolean).join(' · ') : null
  const acc = a ? accountOf(a) : null
  return { runtime, account: acc ? `${accountWord} · ${acc}` : null }
}

export function filterCards(cards: readonly LiveCard[], f: LiveFilters): LiveCard[] {
  return cards.filter(c =>
    (f.taskId === null || c.d.taskId === f.taskId)
    && (!f.onlyActive || c.agents.some(a => RUNNING_STATES.has(a.state))))
}

export function byStage(cards: readonly LiveCard[]): Record<LiveStage, LiveCard[]> {
  const out = Object.fromEntries(LIVE_STAGES.map(s => [s, [] as LiveCard[]])) as Record<LiveStage, LiveCard[]>
  for (const c of cards) out[c.d.stage].push(c)
  return out
}

export interface LiveSummary { deliveries: number; agentsWorking: number; nextEtaMs: number | null }

export function summarize(cards: readonly LiveCard[], nowMs: number): LiveSummary {
  const active = cards.filter(c => c.d.stage !== 'published')
  const etas = active.flatMap(c => c.d.eta.kind === 'estimate' && c.d.eta.atMs >= nowMs ? [c.d.eta.atMs] : [])
  return {
    deliveries: active.length,
    agentsWorking: new Set(active.flatMap(c => c.agents.filter(a => a.state === 'working').map(a => a.id))).size,
    nextEtaMs: etas.length ? Math.min(...etas) : null,
  }
}

// ---------------------------------------------------------------------------------- words

export function fmtSpan(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '0 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60), m = min % 60
  if (h < 24) return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`
}

export const fmtClock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The ETA line, and the sentence behind it (the title attribute): no number without its source. */
export function etaText(eta: LiveEta, lang: 'pt' | 'en'): { line: string; title: string } {
  const pt = lang === 'pt'
  if (eta.kind === 'none') {
    const m = {
      'no-history': pt ? ['sem estimativa', 'Ainda não há entregas parecidas o bastante (mesmo assistente e modelo) para estimar.']
        : ['no estimate', 'Not enough similar delivered work (same assistant and model) to estimate from.'],
      'not-started': pt ? ['sem estimativa', 'O trabalho ainda não começou.'] : ['no estimate', 'The work has not started yet.'],
      'beyond-range': pt ? ['acima do típico', 'Já passou do tempo típico de entregas parecidas; não há número honesto.']
        : ['past the typical range', 'Already past what similar deliveries took; there is no honest number.'],
    }[eta.reason]
    return { line: m[0]!, title: m[1]! }
  }
  const pm = Math.max(1, Math.round(eta.plusMinusMs / 60_000))
  const scope = eta.basis.scope === 'harness-model'
    ? `${eta.basis.harness} · ${eta.basis.model ?? ''}` : eta.basis.harness
  return {
    line: `${pt ? 'prevista' : 'expected'} ${fmtClock(eta.atMs)} ±${pm >= 90 ? `${Math.round(pm / 60)}h` : `${pm}min`}`,
    title: pt
      ? `Mediana de ${eta.basis.n} entregas parecidas (${scope}): ${fmtSpan(eta.basis.medianMs)}.`
      : `Median of ${eta.basis.n} similar deliveries (${scope}): ${fmtSpan(eta.basis.medianMs)}.`,
  }
}

export const STAGE_LABEL: Record<LiveStage, { pt: string; en: string; color: string }> = {
  queue: { pt: 'Na fila', en: 'Queued', color: '#8b8b95' },
  running: { pt: 'Executando', en: 'Running', color: '#f5a623' },
  qa: { pt: 'Em QA', en: 'In QA', color: '#4c9aff' },
  adjust: { pt: 'Ajuste', en: 'Adjusting', color: '#ff5f5f' },
  leader: { pt: 'Revisão do líder', en: 'Leader review', color: '#b78bff' },
  merge: { pt: 'PR / merge', en: 'PR / merge', color: '#3ecf8e' },
  published: { pt: 'Publicado', en: 'Published', color: '#26b573' },
}

export const LIVE_STATE_LABEL: Record<LiveState, { pt: string; en: string }> = {
  working: { pt: 'trabalhando', en: 'working' },
  waiting: { pt: 'esperando', en: 'waiting' },
  'needs-you': { pt: 'precisa de você', en: 'needs you' },
  down: { pt: 'parado', en: 'stopped' },
  none: { pt: 'sem agente vivo', en: 'no live agent' },
}
