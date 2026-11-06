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

import { LIVE_STAGES, type LiveDelivery, type LiveReply, type LiveStage } from './task-live'

/** The slice of a fleet row this module reads (a `ControlSession` satisfies it). */
export interface FleetRowLite {
  id: string
  title: string
  harness: string
  model?: string
  accountId?: string
  state: string
  parentSessionId?: string
  lastLines?: string[]
}

export type LiveState = 'working' | 'waiting' | 'needs-you' | 'down' | 'none'

const ALIVE = new Set(['working', 'waiting', 'waiting-approval'])
const DOWN = new Set(['lost', 'unknown'])

export interface LiveAgentView { id: string; harness: string; model: string | null; accountId: string | null; state: string }

export interface LiveDeliveryView extends LiveDelivery {
  agents: LiveAgentView[]
  liveState: LiveState
  /** Needs a person, an agent is lost, a stated block, or filed sessions the fleet shows nowhere. */
  stalled: boolean
}

export interface LeaderView {
  id: string
  title: string
  harness: string
  model: string | null
  state: string
  /** The last thing on its screen, trimmed — what it is doing now. Null when nothing is captured. */
  currentAction: string | null
  workers: { id: string; title: string; state: string }[]
  /** Items a person has to decide: this leader or one of its workers sits on a dialog. */
  awaiting: { id: string; title: string }[]
}

export interface LiveView {
  generatedAt: string
  samples: number
  summary: {
    deliveries: number; agentsWorking: number; stalled: number
    nextEta: { atMs: number; title: string; confidence: string } | null
  }
  deliveries: LiveDeliveryView[]
  leaders: LeaderView[]
}

function liveStateOf(agents: readonly LiveAgentView[]): LiveState {
  if (agents.length === 0) return 'none'
  if (agents.some(a => a.state === 'waiting-approval')) return 'needs-you'
  if (agents.some(a => a.state === 'working')) return 'working'
  if (agents.some(a => a.state === 'waiting')) return 'waiting'
  return 'down'
}

const lastLine = (lines: readonly string[] | undefined): string | null => {
  const l = (lines ?? []).map(x => x.trim()).filter(Boolean).pop()
  return l ? l.slice(0, 140) : null
}

export interface LiveFilters { task?: string; stage?: LiveStage; stalledOnly?: boolean }

export function describeLive(o: {
  reply: LiveReply
  rows: readonly FleetRowLite[]
  /** Row ids whose stored role is `leader` (by managed id or conversation key, resolved by the caller). */
  leaderIds: ReadonlySet<string>
  nowMs: number
  filters?: LiveFilters
}): LiveView {
  const byId = new Map(o.rows.map(r => [r.id, r]))
  const f = o.filters ?? {}
  const all: LiveDeliveryView[] = o.reply.deliveries.map(d => {
    const agents: LiveAgentView[] = d.sessionIds.flatMap(id => {
      const r = byId.get(id)
      return r && (ALIVE.has(r.state) || DOWN.has(r.state))
        ? [{ id: r.id, harness: r.harness, model: r.model ?? null, accountId: r.accountId ?? null, state: r.state }]
        : []
    })
    const liveState = liveStateOf(agents)
    const stalled = liveState === 'needs-you' || liveState === 'down'
      || (d.stage === 'adjust' && d.blockedReason !== null)
      || (d.sessionIds.length > 0 && agents.length === 0 && (d.stage === 'running' || d.stage === 'qa'))
    return { ...d, agents, liveState, stalled }
  })
  const needle = f.task?.trim().toLowerCase()
  const deliveries = all.filter(d =>
    (!needle || d.taskId === f.task || d.taskTitle.toLowerCase().includes(needle))
    && (!f.stage || d.stage === f.stage)
    && (!f.stalledOnly || d.stalled))

  const active = deliveries.filter(d => d.stage !== 'published')
  const etas = active.flatMap(d => d.eta.kind === 'estimate' && d.eta.atMs >= o.nowMs
    ? [{ atMs: d.eta.atMs, title: d.title, confidence: d.eta.confidence }] : [])
  etas.sort((a, b) => a.atMs - b.atMs)

  const leaders: LeaderView[] = o.rows.filter(r => o.leaderIds.has(r.id) && (ALIVE.has(r.state) || DOWN.has(r.state))).map(r => {
    const workers = o.rows.filter(w => w.parentSessionId === r.id && !o.leaderIds.has(w.id) && ALIVE.has(w.state))
    const awaiting = [r, ...workers].filter(x => x.state === 'waiting-approval').map(x => ({ id: x.id, title: x.title }))
    return {
      id: r.id, title: r.title, harness: r.harness, model: r.model ?? null, state: r.state,
      currentAction: lastLine(r.lastLines),
      workers: workers.map(w => ({ id: w.id, title: w.title, state: w.state })), awaiting,
    }
  })

  return {
    generatedAt: o.reply.generatedAt, samples: o.reply.samples,
    summary: {
      deliveries: active.length,
      agentsWorking: new Set(active.flatMap(d => d.agents.filter(a => a.state === 'working').map(a => a.id))).size,
      stalled: active.filter(d => d.stalled).length,
      nextEta: etas[0] ?? null,
    },
    deliveries, leaders,
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
