/**
 * task-overview.ts — PURE. The board as a whole: what is in flight, what shipped, and what a
 * delivery costs on average.
 *
 * This is the FIRST thing the page shows, before any kanban. The board's own shape ("which column
 * is full") is a tracking question and comes second; the question people open this for is "what is
 * my work costing me".
 *
 * The averages are the part that can lie, so each one states its DENOMINATOR:
 *  - a task nobody could price is excluded from the cost average and COUNTED, or the average is of
 *    a set the reader cannot see;
 *  - delivery time averages over DELIVERED tasks only — an open task has no duration (`task-stats`),
 *    and treating "so far" as a duration drags every average down as the board grows.
 */

import type { SessionMeta } from '@agentistics/core'
import { sessionTokens } from '@agentistics/core'
import { isClosed, type Task } from './task-model'
import type { Bucket } from './task-stats'
import type { ManagedSession } from './types'
import { conversationOwners, distinctConversations } from './task-conversations'
import { rowsOfTask } from './task-report'

/**
 * One day of board-wide activity — never a zero-filled calendar.
 *
 * A day nothing happened on is ABSENT from the list, the same rule the dashboard's own heatmap
 * applies (`useData.ts`'s `heatmapData`): a bar drawn at zero height for a day with no data is
 * indistinguishable from a real quiet day, so the day is simply not a member of this array at all.
 *
 * `sessionsStarted` is bucketed by each session's OWN `start_time` day (UTC, `.slice(0, 10)`, the
 * same rule `tagSessionDay` applies) — not by the day of the task that filed it, which could put a
 * session's activity on a day it never touched. `created` and `delivered` are task-level events and
 * are bucketed by the task's own `createdAt` / `deliveredAt` day for the same reason.
 */
export interface BoardDailyPoint {
  date: string
  /** Sessions whose OWN start day falls here — real work, not task bookkeeping. */
  sessionsStarted: number
  /** Tasks marked `done` on this day. */
  delivered: number
  /** Tasks opened on this day. */
  created: number
}

export interface BoardOverview {
  /**
   * Every KNOWN status, always present — a column at zero is a fact, not an absence.
   *
   * "Known" is whatever `buildBoardOverview`'s caller passed as `statusIds` (the board's own
   * `TaskBook.statuses`, in practice) — the status vocabulary is a dynamic list now, not the closed
   * seven-value union this field's type used to be, so it is a plain `Record<string, number>` and a
   * reader must not assume any particular set of keys is present beyond what it asked for.
   */
  statusCounts: Record<string, number>
  tasks: number
  inFlight: number
  delivered: number
  abandoned: number

  /** Sum over every task that could be priced at all. */
  totalCostUSD: number | null
  /** `totalCostUSD` (and so `avgCostPerTask`) split by harness; `null` when it is. */
  costByHarness: Record<string, number> | null
  /** `avgCostPerDelivered`'s sessions split by harness; `null` when nothing delivered carries a cost. */
  deliveredCostByHarness: Record<string, number> | null
  /** Mean over the tasks that HAVE a cost. Null when none does. */
  avgCostPerTask: number | null
  /** Mean over DELIVERED tasks that have a cost — the figure people actually want. */
  avgCostPerDelivered: number | null
  /** How many tasks carry no cost at all, so the averages above name their own gap. */
  tasksWithoutCost: number
  /**
   * Of the DELIVERED tasks specifically, how many carry no cost — the denominator
   * `avgCostPerDelivered` needs, since `tasksWithoutCost` also counts open work that was never
   * going to have a cost yet.
   */
  deliveredWithoutCost: number

  avgRoundsPerTask: number | null
  avgSessionsPerTask: number | null
  /** Mean wall time of DELIVERED tasks, ms. Null when nothing has been delivered. */
  avgDeliveryMs: number | null

  totalSessions: number
  totalTokens: number | null

  /** Ranked across every task's sessions. Only what was reported. */
  topModels: Bucket[]
  topHarnesses: Bucket[]

  /** The board's activity over time — sorted ascending. See `BoardDailyPoint`. */
  daily: BoardDailyPoint[]
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
}

function rank(m: Map<string, { sessions: number; tokens: number | null }>): Bucket[] {
  return [...m.entries()]
    .map(([key, v]) => ({ key, sessions: v.sessions, tokens: v.tokens }))
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || b.sessions - a.sessions)
}

/** The UTC day of an ISO timestamp, or `null` for anything that is not one — never a guess. */
function dayOf(iso: string | undefined): string | null {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null
}

type DayCounts = { sessionsStarted: number; delivered: number; created: number }

function bumpDay(m: Map<string, DayCounts>, day: string, field: keyof DayCounts): void {
  const cur = m.get(day) ?? { sessionsStarted: 0, delivered: 0, created: 0 }
  cur[field] += 1
  m.set(day, cur)
}

function addInto(into: Record<string, number>, from: Readonly<Record<string, number>>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v
}

export function buildBoardOverview(o: {
  tasks: readonly Task[]
  rows: readonly ManagedSession[]
  metas: ReadonlyMap<string, SessionMeta>
  costOf: (m: SessionMeta) => number
  /**
   * Every status id this board currently knows (`TaskBook.statuses`, mapped to their ids) — seeded
   * so a column nobody is currently in still reports zero rather than being absent. Optional, and
   * falls back to whatever the tasks themselves carry, for callers (tests, mainly) that have no
   * status list handy; a real caller always has one, since `loadTaskWorld` seeds it on first read.
   */
  statusIds?: readonly string[]
}): BoardOverview {
  const knownIds = o.statusIds && o.statusIds.length > 0
    ? o.statusIds
    : [...new Set(o.tasks.map(t => t.status))]
  const statusCounts = Object.fromEntries(
    knownIds.map(s => [s, 0]),
  ) as Record<string, number>

  const models = new Map<string, { sessions: number; tokens: number | null }>()
  const harnesses = new Map<string, { sessions: number; tokens: number | null }>()

  const costs: number[] = []
  const deliveredCosts: number[] = []
  // The same totals split by harness, so the browser can price each slice at ITS OWN plan factor —
  // see `AttemptRollup.costByHarness`.
  const costByHarness: Record<string, number> = {}
  const deliveredCostByHarness: Record<string, number> = {}
  const roundsPer: number[] = []
  const sessionsPer: number[] = []
  const deliveryMs: number[] = []
  let tasksWithoutCost = 0
  let deliveredWithoutCost = 0
  let totalSessions = 0
  let totalTokens: number | null = null
  const days = new Map<string, DayCounts>()

  // WHICH TASK OWNS EACH CONVERSATION, decided once over the whole registry. `rowsOfTask` keeps a
  // conversation for its owner only, so two tasks can no longer both price the same one — the sum
  // below is a sum over DISTINCT conversations, which is what a headline total has to be.
  const owners = conversationOwners(o.rows)

  for (const task of o.tasks) {
    statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1

    const createdDay = dayOf(task.createdAt)
    if (createdDay) bumpDay(days, createdDay, 'created')

    // ONE CONVERSATION, COUNTED ONCE — the same rule `rollupSessionsFor` keeps, and it has to be
    // kept HERE TOO because this walk accumulates its own totals rather than going through it.
    // Six rows of one reopened conversation put its tokens and its cost into the headline six
    // times: measured on a live board, the overview read 13.110.140.051 tokens where the
    // deliveries under it summed to 2.493.697.631.
    const mine = distinctConversations(rowsOfTask(task, o.rows, owners))
    totalSessions += mine.length
    sessionsPer.push(mine.length)

    let taskCost: number | null = null
    const taskByHarness: Record<string, number> = {}
    let taskRounds: number | null = null

    for (const r of mine) {
      const meta = r.conversationId ? o.metas.get(r.conversationId) : undefined
      if (!meta) continue

      const sessionDay = dayOf(meta.start_time)
      if (sessionDay) bumpDay(days, sessionDay, 'sessionsStarted')

      const cost = o.costOf(meta)
      taskCost = (taskCost ?? 0) + cost
      const h = meta.harness ?? 'claude'
      taskByHarness[h] = (taskByHarness[h] ?? 0) + cost
      if (typeof meta.user_message_count === 'number') {
        taskRounds = (taskRounds ?? 0) + meta.user_message_count
      }

      const reported = meta.input_tokens !== undefined || meta.output_tokens !== undefined
        || meta.cache_read_input_tokens !== undefined || meta.cache_creation_input_tokens !== undefined
      const b = reported ? sessionTokens(meta) : null
      const total = b === null ? null : b.input + b.output + b.cacheRead + b.cacheWrite
      if (total !== null) totalTokens = (totalTokens ?? 0) + total

      const bump = (m: typeof models, key: string) => {
        const cur = m.get(key) ?? { sessions: 0, tokens: null }
        m.set(key, {
          sessions: cur.sessions + 1,
          // Absent stays absent: a bucket where nothing reported tokens is not a bucket of zero.
          tokens: total === null ? cur.tokens : (cur.tokens ?? 0) + total,
        })
      }
      // A session with no model contributes no model row — an `unknown` bar is a measurement of our
      // ignorance dressed as a finding about the work.
      if (meta.model) bump(models, meta.model)
      bump(harnesses, meta.harness ?? 'claude')
    }

    if (taskCost === null) {
      tasksWithoutCost += 1
      if (task.status === 'done') deliveredWithoutCost += 1
    } else {
      costs.push(taskCost)
      addInto(costByHarness, taskByHarness)
      if (task.status === 'done') {
        deliveredCosts.push(taskCost)
        addInto(deliveredCostByHarness, taskByHarness)
      }
    }
    if (taskRounds !== null) roundsPer.push(taskRounds)

    if (task.status === 'done' && task.deliveredAt) {
      const ms = Date.parse(task.deliveredAt) - Date.parse(task.createdAt)
      if (Number.isFinite(ms) && ms >= 0) deliveryMs.push(ms)
      const deliveredDay = dayOf(task.deliveredAt)
      if (deliveredDay) bumpDay(days, deliveredDay, 'delivered')
    }
  }

  const inFlight = o.tasks.filter(t => !isClosed(t.status)).length

  const daily: BoardDailyPoint[] = [...days.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    statusCounts,
    tasks: o.tasks.length,
    inFlight,
    delivered: statusCounts.done ?? 0,
    abandoned: statusCounts.abandoned ?? 0,
    totalCostUSD: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    costByHarness: costs.length === 0 ? null : costByHarness,
    deliveredCostByHarness: deliveredCosts.length === 0 ? null : deliveredCostByHarness,
    avgCostPerTask: mean(costs),
    avgCostPerDelivered: mean(deliveredCosts),
    tasksWithoutCost,
    deliveredWithoutCost,
    avgRoundsPerTask: mean(roundsPer),
    avgSessionsPerTask: mean(sessionsPer),
    avgDeliveryMs: mean(deliveryMs),
    totalSessions,
    totalTokens,
    topModels: rank(models),
    topHarnesses: rank(harnesses),
    daily,
  }
}
