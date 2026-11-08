/**
 * task-live-view.ts — PURE. The Live Delivery answer WITH the fleet joined in: the one read model
 * behind the view (`GET /api/tasks/live`) and the MCP tool (`agentistics_live_delivery`), so what
 * Nay says and what the screen shows can never disagree.
 *
 * `task-live.ts` knows the book (stage, times, ETA). This adds what only the live fleet knows —
 * each agent's state — and the LEADERS: leader sessions are NOT deliveries and never become a
 * card; they get a band of their own (what they are doing, which workers they run, what waits on
 * a decision). A worker belongs to a leader through the `parentSessionId` the registry recorded.
 */

import {
  humanizeAction, liveComparator, LIVE_SORT_DEFAULT, liveTabCounts, liveTabMatches, plainLeaderName,
  type LiveLang, type LivePeriod, type LiveSortId, type LiveTab,
} from '@agentistics/core'
import { LIVE_STAGES, type LiveDelivery, type LiveReply, type LiveStage } from './task-live'

/** The slice of a fleet row this module reads (a `ControlSession` satisfies it). */
export interface FleetRowLite {
  id: string
  title: string
  harness: string
  model?: string
  /** The model the transcript says answered — the composer's own source; outranks `model` (only what was asked for). */
  observedModel?: string
  /** The effort the session was started with (registry). */
  effort?: string
  accountId?: string
  state: string
  parentSessionId?: string
  lastLines?: string[]
  /** The title of the task the row is filed on. */
  task?: string
  /** When the session was created, ms. */
  createdMs?: number
}

/** What a harness will use with nothing passed, and whether it has an effort concept at all. */
export interface RuntimeFacts { model?: string; effort?: string; effortConcept: boolean }

export type LiveState = 'working' | 'waiting' | 'needs-you' | 'down' | 'none'

const ALIVE = new Set(['working', 'waiting', 'waiting-approval'])
const DOWN = new Set(['lost', 'unknown'])

export interface LiveAgentView { id: string; harness: string; model: string | null; effort: string | null; accountId: string | null; state: string }

export interface LiveDeliveryView extends LiveDelivery {
  agents: LiveAgentView[]
  liveState: LiveState
  /** Needs a person, an agent is lost, a stated block, or filed sessions the fleet shows nowhere. */
  stalled: boolean
}

/** How a worker reads: its own words, from its state AND where its piece sits. */
export type WorkerWord = 'working' | 'needs-you' | 'blocked' | 'delivered' | 'awaiting-review' | 'idle'

export interface LeaderWorker {
  id: string
  title: string
  state: string
  word: WorkerWord
  stage: LiveStage | null
  /** The board card (`LiveDelivery.key`) this worker's piece is drawn as, so a row can locate it. */
  cardKey: string | null
  subtask: string | null
  taskId: string | null
  stageSinceMs: number | null
  /** Why its piece is blocked, when it is — the card says it in words. */
  blockReason: string | null
  harness: string
  model: string | null
  effort: string | null
}

export interface LeaderView {
  id: string
  title: string
  harness: string
  model: string | null
  effort: string | null
  accountId: string | null
  state: string
  /** Seconds-old truth about the session itself: when it was created. */
  createdMs: number | null
  /** The task the leader is filed on. */
  taskId: string | null
  taskTitle: string | null
  /** The last thing on its screen as a SENTENCE — never raw JSON. Null when nothing is captured. */
  currentAction: string | null
  /** Latest estimated publication across the pieces its workers run; null when none has an estimate. */
  publishEtaMs: number | null
  workers: LeaderWorker[]
  /** Items a person has to decide: this leader or one of its workers sits on a dialog. */
  awaiting: { id: string; title: string }[]
}

export interface LiveView {
  generatedAt: string
  samples: number
  hidden: LiveReply['hidden']
  archived: LiveReply['archived']
  archivedTotal: number
  sessionTasks: LiveReply['sessionTasks']
  runtime: Record<string, RuntimeFacts>
  summary: {
    deliveries: number; agentsWorking: number; stalled: number
    nextEta: { atMs: number; title: string; confidence: string } | null
  }
  deliveries: LiveDeliveryView[]
  /**
   * The tab and period this answer is for, and the count of EVERY tab under the same task filter and period —
   * the very numbers the screen's tabs print (`liveTabCounts`, `@agentistics/core`). `deliveries` is that tab.
   */
  view: { tab: LiveTab; period: LivePeriod; counts: Record<LiveTab, number> }
  leaders: LeaderView[]
}

function liveStateOf(agents: readonly LiveAgentView[]): LiveState {
  if (agents.length === 0) return 'none'
  if (agents.some(a => a.state === 'waiting-approval')) return 'needs-you'
  if (agents.some(a => a.state === 'working')) return 'working'
  if (agents.some(a => a.state === 'waiting')) return 'waiting'
  return 'down'
}

/** The newest line on the screen that is not furniture, as a sentence (never JSON). */
export const lastLine = (lines: readonly string[] | undefined, lang: LiveLang = 'pt', titleOf?: (id: string) => string | undefined): string | null => {
  const l = (lines ?? []).map(x => x.trim()).filter(Boolean).pop()
  return l ? humanizeAction(l, lang, titleOf) : null
}

/** PURE. A worker's state in its own words: `waiting` is idle at its prompt, which is NOT "waiting for you". */
export function workerWord(state: string, stage: LiveStage | null): WorkerWord {
  if (state === 'waiting-approval') return 'needs-you'
  if (stage === 'blocked') return 'blocked'
  if (state === 'working') return 'working'
  if (stage === 'leader') return 'awaiting-review'
  if (stage === 'qa' || stage === 'merge' || stage === 'published') return 'delivered'
  return 'idle'
}

/**
 * The screen's own choices, answered by the same rules (`@agentistics/core` `liveBoard.ts`): the `tab`
 * (active | queue | published | all — an API caller that names none gets `all`, the screen opens on `active`),
 * the Publicado `period` (24h default) and `sort` (default: highest priority first).
 */
export interface LiveFilters { task?: string; stage?: LiveStage; stalledOnly?: boolean; tab?: LiveTab; period?: LivePeriod; sort?: LiveSortId }

export function describeLive(o: {
  reply: LiveReply
  rows: readonly FleetRowLite[]
  /** Row ids whose stored role is `leader` (by managed id or conversation key, resolved by the caller). */
  leaderIds: ReadonlySet<string>
  nowMs: number
  filters?: LiveFilters
  lang?: LiveLang
  runtime?: Record<string, RuntimeFacts>
}): LiveView {
  const lang = o.lang ?? 'pt'
  const byId = new Map(o.rows.map(r => [r.id, r]))
  const titleOf = (id: string) => { const t = byId.get(id)?.title; return t ? plainLeaderName(t) : undefined }
  const f = o.filters ?? {}
  // History (published beyond 24 h) and the old legacy reviews carry no live agents by definition; they ride the
  // same pipe as every other piece, and the tab + period decide which of them show.
  const all: LiveDeliveryView[] = [...o.reply.deliveries, ...(o.reply.history ?? []), ...(o.reply.oldReviews ?? [])].map(d => {
    const agents: LiveAgentView[] = d.sessionIds.flatMap(id => {
      const r = byId.get(id)
      return r && (ALIVE.has(r.state) || DOWN.has(r.state))
        ? [{ id: r.id, harness: r.harness, model: r.observedModel ?? r.model ?? null, effort: r.effort ?? null, accountId: r.accountId ?? null, state: r.state }]
        : []
    })
    const liveState = liveStateOf(agents)
    const stalled = liveState === 'needs-you' || liveState === 'down'
      || (d.stage === 'adjust' && d.blockedReason !== null)
      || (d.sessionIds.length > 0 && agents.length === 0 && (d.stage === 'running' || d.stage === 'qa'))
    // MEASURED work only: the book's `activeMinutes`, or — when nothing was measured — the span of a session the
    // FLEET shows alive right now. A session the book thinks open while no agent runs counts nothing.
    const alive = agents.some(a => ALIVE.has(a.state))
    const workMs = d.workMs ?? (alive && d.startedAtMs !== null ? Math.max(0, o.nowMs - d.startedAtMs) : null)
    return { ...d, workMs, agents, liveState, stalled }
  })
  const needle = f.task?.trim().toLowerCase()
  // A piece whose only sessions are LEADERS is the leader's own filing, not delivery work: the leader
  // has its card in the band, and a column card would show the task's age as "total".
  const leaderOnly = (d: LiveDeliveryView) => d.sessionIds.length > 0 && d.sessionIds.every(id => o.leaderIds.has(id))
  const tab: LiveTab = f.tab ?? 'all'
  const period: LivePeriod = f.period ?? '24h'
  const cmp = liveComparator(f.sort ?? LIVE_SORT_DEFAULT)
  // The tab counts are asked of the task-filtered set only (as the screen's are): a stage / stalled filter narrows the
  // list, not the tabs.
  const ofTask = all.filter(d => !leaderOnly(d)).filter(d => !needle || d.taskId === f.task || d.taskTitle.toLowerCase().includes(needle))
  const counts = liveTabCounts(ofTask, period, o.nowMs)
  const deliveries = ofTask
    .filter(d => liveTabMatches(tab, d, period, o.nowMs) && (!f.stage || d.stage === f.stage) && (!f.stalledOnly || d.stalled))
    // Stage by stage, as the screen's columns are; within a stage the chosen order.
    .sort((a, b) => LIVE_STAGES.indexOf(a.stage) - LIVE_STAGES.indexOf(b.stage) || cmp(a, b))

  const active = deliveries.filter(d => d.stage !== 'published' && !d.old)
  const etas = active.flatMap(d => d.eta.kind === 'estimate' && d.eta.atMs >= o.nowMs
    ? [{ atMs: d.eta.atMs, title: d.title, confidence: d.eta.confidence }] : [])
  etas.sort((a, b) => a.atMs - b.atMs)

  const pieceOf = new Map<string, LiveDeliveryView>()
  for (const d of all) for (const id of d.sessionIds) pieceOf.set(id, d)
  const leaders: LeaderView[] = o.rows.filter(r => o.leaderIds.has(r.id) && (ALIVE.has(r.state) || DOWN.has(r.state))).map(r => {
    const workers = o.rows.filter(w => w.parentSessionId === r.id && !o.leaderIds.has(w.id) && ALIVE.has(w.state))
    const awaiting = [r, ...workers].filter(x => x.state === 'waiting-approval').map(x => ({ id: x.id, title: x.title }))
    const pubs = workers.flatMap(w => { const d = pieceOf.get(w.id); return d && d.publishEta.kind === 'estimate' ? [d.publishEta.atMs] : [] })
    const taskId = [...pieceOf.values()].find(d => d.sessionIds.includes(r.id))?.taskId ?? o.reply.sessionTasks?.[r.id] ?? null
    return {
      id: r.id, title: r.title, harness: r.harness, model: r.observedModel ?? r.model ?? null, effort: r.effort ?? null, accountId: r.accountId ?? null,
      state: r.state, createdMs: r.createdMs ?? null, taskId, taskTitle: r.task ?? null,
      currentAction: lastLine(r.lastLines, lang, titleOf),
      publishEtaMs: pubs.length ? Math.max(...pubs) : null,
      workers: workers.map(w => {
        const d = pieceOf.get(w.id)
        return {
          id: w.id, title: w.title, state: w.state, word: workerWord(w.state, d?.stage ?? null),
          stage: d?.stage ?? null, cardKey: d?.key ?? null, subtask: d?.subtaskId ? d.title : null, taskId: d?.taskId ?? null,
          stageSinceMs: d?.stageSinceMs ?? null, blockReason: d?.block?.reason ?? null, harness: w.harness, model: w.observedModel ?? w.model ?? null, effort: w.effort ?? null,
        }
      }),
      awaiting,
    }
  })

  return {
    generatedAt: o.reply.generatedAt, samples: o.reply.samples,
    hidden: o.reply.hidden ?? [], archived: o.reply.archived ?? [], archivedTotal: o.reply.archivedTotal ?? 0, sessionTasks: o.reply.sessionTasks ?? {}, runtime: o.runtime ?? {},
    summary: {
      deliveries: active.length,
      agentsWorking: new Set(active.flatMap(d => d.agents.filter(a => a.state === 'working').map(a => a.id))).size,
      stalled: active.filter(d => d.stalled).length,
      nextEta: etas[0] ?? null,
    },
    deliveries, view: { tab, period, counts }, leaders,
  }
}

/** The one-line summary Nay can read aloud. English: the model translates to the person's language. */
export function liveSentence(v: LiveView, nowMs: number): string {
  const s = v.summary
  const parts = [
    `${s.deliveries} active ${s.deliveries === 1 ? 'delivery' : 'deliveries'}`,
    `${s.agentsWorking} ${s.agentsWorking === 1 ? 'agent' : 'agents'} working`,
    s.stalled > 0 ? `${s.stalled} stalled` : 'none stalled',
    s.nextEta ? `next expected "${s.nextEta.title}" in ${Math.max(0, Math.round((s.nextEta.atMs - nowMs) / 60_000))} min (${s.nextEta.confidence} confidence)` : 'no delivery has an estimate yet',
  ]
  return parts.join(' · ')
}

export const STAGE_ORDER = LIVE_STAGES
