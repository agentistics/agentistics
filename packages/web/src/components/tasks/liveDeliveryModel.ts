/**
 * liveDeliveryModel — PURE. The Live Delivery line as the browser draws it: the server's active
 * pieces (`/api/tasks/live`) joined with the fleet's LIVE rows, grouped into the seven stages.
 *
 * The server knows the book (stage, times, ETA); only the fleet knows what an agent is doing this
 * second. The join is by session id, never by name, and a row the fleet no longer carries is
 * simply not live — it is never invented back from the book.
 */

import { LIVE_FLOW_DEFAULTS, LIVE_SORT_DEFAULT, liveComparator, stageVisible, type LiveSortId } from '@agentistics/core'
import type { FleetRow } from '../../lib/fleet'
import { modelDisplay } from '../../lib/modelDisplay'

export type LiveStage = 'queue' | 'blocked' | 'running' | 'qa' | 'adjust' | 'leader' | 'merge' | 'ci' | 'published'
export const LIVE_STAGES: readonly LiveStage[] = ['queue', 'blocked', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'published']

export type LiveEta =
  | {
      kind: 'estimate'; atMs: number; plusMinusMs: number; confidence: 'low' | 'medium' | 'high'
      basis: { n: number; scope: 'harness-model' | 'harness'; harness: string; model: string | null; medianMs: number }
    }
  | { kind: 'none'; reason: 'no-history' | 'not-started' | 'beyond-range' }

export type LiveStageEta =
  | { kind: 'estimate'; atMs: number; medianMs: number; n: number; nextStage: LiveStage | null }
  | { kind: 'none'; reason: 'no-history' | 'beyond-range' | 'not-started' | 'final'; typicalMs?: number; n?: number }
export type LivePublishEta =
  | { kind: 'estimate'; atMs: number; source: 'stages' | 'total'; n: number; parts: { stage: LiveStage; medianMs: number }[] }
  | { kind: 'none'; reason: 'no-history' | 'beyond-range' | 'not-started' | 'final' }
export type BlockReason = 'dependencia' | 'pedido_de_bloqueio' | 'limite' | 'maquina' | 'externo' | 'fora_das_autorizacoes' | 'decisao_do_dono'
export interface LiveBlock { reason: BlockReason; text: string | null; unlocker: 'leader' | 'owner' | 'self'; originStage: LiveStage | null }
/** The release signal of a piece in "CI · publicando" — stated by the delivery flow, only rendered here. */
export interface LiveCiSignal { mergedMain: boolean; releaseGreen: boolean; tagPublished: boolean; tag: string | null; pr: number | null }
export interface StageVisit { stage: LiveStage; enteredMs: number; ms: number }
export type HiddenReason = 'no-live-session' | 'status-unplaced' | 'published-old' | 'queue-idle' | 'legacy-review-old'
export interface LiveHidden { key: string; taskId: string; subtaskId?: string; title: string; stage: LiveStage | null; reason: HiddenReason; atMs?: number | null }
export interface RuntimeFacts { model?: string; effort?: string; effortConcept: boolean }

/** Mirror of the server's `LiveDelivery` (`task-live.ts`). The newer fields are optional: an older server omits them. */
export interface LiveDeliveryRecord {
  key: string; taskId: string; taskTitle: string; subtaskId: string | null; title: string
  status: string; stage: LiveStage; stageSinceMs: number | null; startedAtMs: number | null
  sessionIds: string[]; harnesses: string[]; models: string[]; eta: LiveEta
  efforts?: string[]; workMs?: number | null; trail?: StageVisit[]
  stageEta?: LiveStageEta; publishEta?: LivePublishEta; block?: LiveBlock | null
  /** The Agentask priority (urgent | high | medium | low); a subtask inherits its task's. Absent from an older server = low. */
  priority?: string
  ci?: LiveCiSignal | null; step?: number | null
  /** Where `step` came from: stated by the worker/flow (`reported`) or read off observed facts (`signals`, named by `stepSignal`). */
  stepSource?: 'reported' | 'signals' | null; stepSignal?: string | null
  lastAction: { text: string; atMs: number; kind?: string; from?: string; to?: string } | null; blockedReason: string | null; deliveredAtMs: number | null
  /** FLUXO.ENTREGA-DSL: the pre-dispatch a queued piece starts with, and the vaga gate's last verdict. */
  staged?: { harness: string | null; model: string | null; effort: string | null; account: string | null } | null
  slot?: { ok: boolean; reason: string | null; at: string } | null
  phase?: string | null
  /** A human gate the owner was asked about and has not answered: the card offers approve / reject. */
  awaitingApproval?: { phase: string } | null
  /** FILA.PRIORIDADE (a queued piece only): the leader's `nao`/`agendar`, the open question, an approval waiting for a slot. */
  queue?: { hold: { kind: 'nao' | 'agendar'; reason: string; until: string | null; by: string; atMs: number | null } | null; asking: boolean; approved: boolean } | null
}
export type WorkerWord = 'working' | 'needs-you' | 'blocked' | 'delivered' | 'awaiting-review' | 'idle'
export interface LeaderWorker {
  id: string; title: string; state: string
  word?: WorkerWord; stage?: LiveStage | null; cardKey?: string | null; subtask?: string | null; taskId?: string | null
  stageSinceMs?: number | null; blockReason?: BlockReason | null; harness?: string; model?: string | null; effort?: string | null
}
/** Mirror of the server's `LeaderView` (`task-live-view.ts`). Leaders are never deliveries. */
export interface LeaderRecord {
  id: string; title: string; harness: string; model: string | null; effort?: string | null; accountId?: string | null; state: string
  createdMs?: number | null; taskId?: string | null; taskTitle?: string | null
  currentAction: string | null; publishEtaMs?: number | null
  workers: LeaderWorker[]
  awaiting: { id: string; title: string }[]
}
export interface LiveReply {
  generatedAt: string; deliveries: LiveDeliveryRecord[]; leaders?: LeaderRecord[]; samples: number
  /** Published more than 24 h ago (the Histórico column); absent from an older server. */
  history?: LiveDeliveryRecord[]
  hidden?: LiveHidden[]; archived?: LiveHidden[]; archivedTotal?: number; sessionTasks?: Record<string, string>; runtime?: Record<string, RuntimeFacts>
}

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

export interface LiveFilters {
  /** Tasks to show; empty = every task. Several at once (the Live task filter is multi-select). */
  taskIds: readonly string[]
  /** "apenas ativas": the cards of the columns AFTER the queue (Bloqueado … Publicado). */
  onlyActive: boolean
  /** "exibir itens na fila": the cards of the Na fila column. Absent = on (an older caller). */
  showQueue?: boolean
}

/**
 * The Live view's defaults: every task, every step, BOTH switches on (everything in the flow is shown),
 * highest priority first. The filter rules themselves live in `@agentistics/core` (`liveBoard.ts`) so the MCP
 * tool answers by the very same ones.
 */
export type StageFilter = 'all' | LiveStage
export const LIVE_DEFAULTS: { taskIds: readonly string[]; onlyActive: boolean; showQueue: boolean; stage: StageFilter; sort: LiveSortId } =
  { taskIds: [], ...LIVE_FLOW_DEFAULTS, stage: 'all', sort: LIVE_SORT_DEFAULT }

/** A piece sitting in the queue column is waiting for a slot: it is drawn dimmed and never gets an ETA verdict. */
export const isQueued = (c: LiveCard): boolean => c.d.stage === 'queue'

/** 1-based place in the queue (oldest first by stage-since, then key); null when the card is not queued. */
export function queuePosition(cards: readonly LiveCard[], c: LiveCard, sort?: LiveSortId): number | null {
  if (!isQueued(c)) return null
  // Default: oldest first (the order the queue has always read in). With a sort chosen, the place is the one the column draws.
  const cmp = liveComparator(sort ?? 'time-in-stage')
  const q = cards.filter(isQueued).sort((a, b) => cmp(a.d, b.d))
  const i = q.findIndex(x => x.d.key === c.d.key)
  return i < 0 ? null : i + 1
}

/**
 * The two pills of a card: [harness · model · effort] and [account · name].
 *
 * EVERY harness shows all three parts. The live agent's own row wins; a card with no live agent reads
 * the registry facts the server carried (`models`/`efforts`); and a session started with no flags
 * shows the harness's own default (`runtime`) marked as such. Only a harness with no effort concept
 * at all omits the effort part — never one that merely was not asked.
 */
export function cardPills(
  c: LiveCard, accountOf: (a: LiveAgent) => string | null, accountWord: string,
  runtime?: Record<string, RuntimeFacts>, pt = true,
): { runtime: string | null; account: string | null } {
  const a = c.agents[0]
  const harness = a ? a.harness : c.d.harnesses[0]
  if (!harness) return { runtime: null, account: null }
  const facts = runtime?.[harness]
  const dflt = pt ? 'padrão' : 'default'
  const model = a?.model ?? c.d.models[0] ?? null
  const effort = a?.effort ?? c.d.efforts?.[0] ?? null
  const parts = [
    harness,
    // A person reads "Opus 5.5", not the transcript's "claude-opus-5-5" (owner's approved preview, QA MED 8).
    (model ? modelDisplay(harness, model) : null) ?? (facts?.model ? `${modelDisplay(harness, facts.model) ?? facts.model} (${dflt})` : (pt ? 'modelo padrão' : 'default model')),
    effort ?? (facts?.effortConcept === false ? null : facts?.effort ? `${facts.effort} (${dflt})` : facts?.effortConcept ? (pt ? 'esforço padrão' : 'default effort') : null),
  ].filter((x): x is string => !!x)
  const acc = a ? accountOf(a) : null
  return { runtime: parts.join(' · '), account: acc ? `${accountWord} · ${acc}` : null }
}

export function filterCards(cards: readonly LiveCard[], f: LiveFilters): LiveCard[] {
  return cards.filter(c =>
    (f.taskIds.length === 0 || f.taskIds.includes(c.d.taskId))
    && stageVisible(c.d.stage, { onlyActive: f.onlyActive, showQueue: f.showQueue ?? true }))
}

export function byStage(cards: readonly LiveCard[]): Record<LiveStage, LiveCard[]> {
  const out = Object.fromEntries(LIVE_STAGES.map(s => [s, [] as LiveCard[]])) as Record<LiveStage, LiveCard[]>
  for (const c of cards) out[c.d.stage].push(c)
  return out
}

/** PURE. Every column lists its cards in the chosen order (default: highest priority first, then longest in the stage). */
export function orderColumns(cols: Record<LiveStage, LiveCard[]>, sort: LiveSortId): Record<LiveStage, LiveCard[]> {
  const cmp = liveComparator(sort)
  const out = {} as Record<LiveStage, LiveCard[]>
  for (const s of LIVE_STAGES) out[s] = [...cols[s]].sort((a, b) => cmp(a.d, b.d))
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
    line: `${pt ? 'prevista' : 'expected'} ~${fmtClock(eta.atMs)}`,
    title: pt
      ? `Mediana de ${eta.basis.n} entregas parecidas (${scope}): ${fmtSpan(eta.basis.medianMs)} (margem ±${pm >= 90 ? `${Math.round(pm / 60)}h` : `${pm}min`}).`
      : `Median of ${eta.basis.n} similar deliveries (${scope}): ${fmtSpan(eta.basis.medianMs)} (margin ±${pm >= 90 ? `${Math.round(pm / 60)}h` : `${pm}min`}).`,
  }
}

export const STAGE_LABEL: Record<LiveStage, { pt: string; en: string; color: string }> = {
  queue: { pt: 'Na fila', en: 'Queued', color: '#8b8b95' },
  blocked: { pt: 'Bloqueado', en: 'Blocked', color: '#c2410c' },
  running: { pt: 'Em desenvolvimento', en: 'In development', color: '#f5a623' },
  qa: { pt: 'QA', en: 'QA', color: '#4c9aff' },
  adjust: { pt: 'Ajuste', en: 'Adjusting', color: '#ff5f5f' },
  leader: { pt: 'Revisão do líder', en: 'Leader review', color: '#b78bff' },
  merge: { pt: 'PR / merge', en: 'PR / merge', color: '#3ecf8e' },
  ci: { pt: 'CI · publicando', en: 'CI · publishing', color: 'rgb(45,180,200)' },
  published: { pt: 'Publicado', en: 'Published', color: '#26b573' },
}

export const LIVE_STATE_LABEL: Record<LiveState, { pt: string; en: string }> = {
  working: { pt: 'trabalhando', en: 'working' },
  waiting: { pt: 'esperando', en: 'waiting' },
  'needs-you': { pt: 'precisa de você', en: 'needs you' },
  down: { pt: 'parado', en: 'stopped' },
  none: { pt: 'sem agente vivo', en: 'no live agent' },
}
