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
  humanizeAction, inPublishedPeriod, liveCapOmitted, type LiveCutFacts, liveComparator, LIVE_PERIOD_DEFAULT, LIVE_SORT_DEFAULT, liveTabCounts, liveTabMatches, plainLeaderName,
  type LiveLang, type LivePeriod, type LiveSortId, type LiveTab,
} from '@agentistics/core'
import { HISTORY_CAP, LIVE_STAGES, type LiveDelivery, type LiveReply, type LiveStage } from './task-live'

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

export type LeaderAvailability = 'available' | 'absent' | 'unknown'

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
  /** The leader's own filing on a task with no open piece: the leader is doing the work itself (the card wears the Leader badge). */
  leaderPiece?: boolean
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
   * `tab` / `period` are the EFFECTIVE values (missing or invalid input falls back to `all` / `24h`; `defaulted`
   * names the ones that did). `capped` is set when the per-kind cap left older pieces out of this answer, so a
   * count is never mistaken for the total: `omitted` pieces are missing, the oldest ones.
   */
  view: { tab: LiveTab; period: LivePeriod; counts: Record<LiveTab, number>; defaulted: string[]; capped: { cap: number; omitted: number } | null; capFacts: LiveCutFacts }
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
export interface LiveFilters { task?: string; stage?: LiveStage | 'no-leader'; stalledOnly?: boolean; tab?: LiveTab; period?: LivePeriod; sort?: LiveSortId }

/**
 * Join a review piece with the fleet's real leader heartbeat. A leader from another task never
 * satisfies this check. `unknown` is deliberately distinct from `absent`: a failed fleet read
 * must not make a review look abandoned.
 */
function leaderForTask(o: { taskId: string; taskTitle: string; rows: readonly FleetRowLite[]; leaderIds: ReadonlySet<string>; fleetRead: 'ok' | 'unknown' }): { availability: LeaderAvailability; reason?: string } {
  if (o.fleetRead === 'unknown') return { availability: 'unknown', reason: 'leader availability could not be read from the fleet' }
  const sameTask = (r: FleetRowLite) => r.task === o.taskId || r.task === o.taskTitle
  const leader = o.rows.some(r => o.leaderIds.has(r.id) && sameTask(r) && ALIVE.has(r.state))
  return leader ? { availability: 'available' } : { availability: 'absent', reason: 'no live leader is filed on this task' }
}

export function describeLive(o: {
  reply: LiveReply
  rows: readonly FleetRowLite[]
  /** Row ids whose stored role is `leader` (by managed id or conversation key, resolved by the caller). */
  leaderIds: ReadonlySet<string>
  nowMs: number
  filters?: LiveFilters
  lang?: LiveLang
  runtime?: Record<string, RuntimeFacts>
  /** Whether the fleet read succeeded. Omit for pure callers that already provide an authoritative empty fleet. */
  fleetRead?: 'ok' | 'unknown'
}): LiveView {
  const lang = o.lang ?? 'pt'
  const byId = new Map(o.rows.map(r => [r.id, r]))
  const titleOf = (id: string) => { const t = byId.get(id)?.title; return t ? plainLeaderName(t) : undefined }
  const f = o.filters ?? {}
  // History (published beyond 24 h) and the old legacy reviews ride the same pipe as every other piece (a worker
  // can still be filed on one, so agents are joined for them too); the tab + period decide which of them show.
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
    const leader = d.stage === 'leader'
      ? leaderForTask({ taskId: d.taskId, taskTitle: d.taskTitle, rows: o.rows, leaderIds: o.leaderIds, fleetRead: o.fleetRead ?? 'ok' })
      : null
    return { ...d, workMs, agents, liveState, stalled,
      ...(leader?.availability === 'absent' ? { displayStage: 'no-leader' as const } : {}),
      ...(leader ? { leaderAvailability: leader.availability, ...(leader.reason ? { leaderAvailabilityReason: leader.reason } : {}) } : {}) }
  })
  const needle = f.task?.trim().toLowerCase()
  // A piece whose only sessions are LEADERS is the leader's own filing. While the task has an OPEN piece of its own
  // (a subtask / group card that is not published, completed or abandoned) the leader is a coordinator: it stays in
  // the band and adds no duplicate card. With none, the leader IS doing the work, and the filing is ONE card, marked
  // `leaderPiece`, whose clock is the leader session's own start — never the task's age.
  const openTasks = new Set(all.filter(d => d.subtaskId !== null && !d.old && d.stage !== 'published' && d.stage !== 'completed').map(d => d.taskId))
  // A task that rolled up to `done` (its last subtask finished) while a leader filed on it is still LIVE keeps that one
  // card: the leader is still there. A dead, exited or lost leader on a done task gets none, or old tasks would return.
  const liveLeaderOn = (d: LiveDeliveryView) => d.sessionIds.some(id => o.leaderIds.has(id) && ALIVE.has(byId.get(id)?.state ?? ''))
  const isLeaderFiling = (d: LiveDeliveryView) => d.subtaskId === null && d.sessionIds.length > 0 && d.sessionIds.every(id => o.leaderIds.has(id))
    && (d.stage === 'running' || (d.stage === 'completed' && !d.old && liveLeaderOn(d)))
  const leaderOnly = (d: LiveDeliveryView) => isLeaderFiling(d) && openTasks.has(d.taskId)
  const asLeaderPiece = (d: LiveDeliveryView): LiveDeliveryView => {
    if (!isLeaderFiling(d)) return d
    const since = Math.min(...d.sessionIds.map(id => byId.get(id)?.createdMs ?? Infinity))
    const at = Number.isFinite(since) ? since : null
    return { ...d, leaderPiece: true, stage: 'running', deliveredAtMs: null, startedAtMs: at, stageSinceMs: at, workMs: null, eta: { kind: 'none', reason: 'not-started' }, ...(d.round ? { round: { ...d.round, startedAtMs: at } } : {}) }
  }
  // EFFECTIVE values: a caller that names no (or an invalid) tab gets `all`, no period gets `24h`; `view.defaulted` says so.
  const tab: LiveTab = f.tab ?? 'all'
  const period: LivePeriod = f.period ?? LIVE_PERIOD_DEFAULT
  const defaulted = [...(f.tab ? [] : ['tab']), ...(f.period ? [] : ['period'])]
  const cmp = liveComparator(f.sort ?? LIVE_SORT_DEFAULT)
  // The tab counts are asked of the task-filtered set only (as the screen's are): a stage / stalled filter narrows the
  // list, not the tabs.
  const ofTask = all.filter(d => !leaderOnly(d)).map(asLeaderPiece).filter(d => !needle || d.taskId === f.task || d.taskTitle.toLowerCase().includes(needle))
  const counts = liveTabCounts(ofTask, period, o.nowMs)
  const deliveries = ofTask
    .filter(d => liveTabMatches(tab, d, period, o.nowMs) && (!f.stage || (f.stage === 'no-leader' ? d.displayStage === 'no-leader' : d.stage === f.stage)) && (!f.stalledOnly || d.stalled))
    // Stage by stage, as the screen's columns are; within a stage the chosen order.
    .sort((a, b) => LIVE_STAGES.indexOf(a.stage) - LIVE_STAGES.indexOf(b.stage) || cmp(a, b))

  const active = deliveries.filter(d => d.stage !== 'published' && d.stage !== 'completed' && !d.old)
  const etas = active.flatMap(d => d.eta.kind === 'estimate' && d.eta.atMs >= o.nowMs
    ? [{ atMs: d.eta.atMs, title: d.title, confidence: d.eta.confidence }] : [])
  etas.sort((a, b) => a.atMs - b.atMs)

  const pieceOf = new Map<string, LiveDeliveryView>()
  // A piece published more than 24 h ago is history: a worker still filed on it is not "delivering" it.
  for (const d of all) if (d.stage !== 'published' || inPublishedPeriod(d.deliveredAtMs, LIVE_PERIOD_DEFAULT, o.nowMs)) for (const id of d.sessionIds) pieceOf.set(id, d)
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

  // The 400-per-kind cap cuts the OLDEST published / old-review pieces. Say so when the cut could matter for this
  // tab and period, so a count never passes as the total.
  const keptHistory = o.reply.history ?? []
  const keptOld = o.reply.oldReviews ?? []
  const oldestKept = keptHistory.reduce<number | null>((m, d) => d.deliveredAtMs === null ? m : m === null ? d.deliveredAtMs : Math.min(m, d.deliveredAtMs), null)
  const capFacts: LiveCutFacts = {
    cutByTask: o.reply.cutByTask, oldestKeptMs: oldestKept,
    wholeHistory: Math.max(0, (o.reply.historyTotal ?? keptHistory.length) - keptHistory.length),
    wholeOld: Math.max(0, (o.reply.oldReviewsTotal ?? keptOld.length) - keptOld.length),
  }
  const omitted = liveCapOmitted({
    facts: capFacts,
    tab, period, nowMs: o.nowMs, stage: f.stage, stalledOnly: f.stalledOnly,
    match: needle ? (id, title) => id === f.task || title.toLowerCase().includes(needle) : undefined,
  })
  const capped = omitted > 0 ? { cap: HISTORY_CAP, omitted } : null

  return {
    generatedAt: o.reply.generatedAt, samples: o.reply.samples,
    hidden: o.reply.hidden ?? [], sessionTasks: o.reply.sessionTasks ?? {}, runtime: o.runtime ?? {},
    summary: {
      deliveries: active.length,
      agentsWorking: new Set(active.flatMap(d => d.agents.filter(a => a.state === 'working').map(a => a.id))).size,
      stalled: active.filter(d => d.stalled).length,
      nextEta: etas[0] ?? null,
    },
    deliveries, view: { tab, period, counts, defaulted, capped, capFacts }, leaders,
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
