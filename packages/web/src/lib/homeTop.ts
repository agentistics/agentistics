/**
 * homeTop.ts — PURE. The leaderboards on the home page: who led the PERIOD, and who leads TODAY.
 *
 * ## Why both readings, on every card
 *
 * A ranking over the filter's whole window answers "where does my money go", and it is stable —
 * which is exactly why it stops being news. Thirty days of history will not move because of what
 * happened this morning, so a card that only shows the period cannot answer the question people
 * actually open a dashboard with: *what is going on right now*. And a card that only shows today
 * throws away the context that makes today legible — a model at 1,2B tokens means nothing until you
 * know whether that is normal for it.
 *
 * So each board carries the period ranking and, under a rule, one line for the most recent day that
 * has any activity in the current filter. The day is NAMED rather than called "today", because with
 * a date filter on — or simply on a Monday morning — the last active day is frequently not today,
 * and a card labelled "today" showing Friday's numbers is a lie that is very easy to believe.
 *
 * ## The day rule here is the LOCAL day, deliberately
 *
 * This repo has two (see CLAUDE.md): billing uses the UTC `start_time.slice(0, 10)`, and the home's
 * own activity chart, heatmap and hour histogram bucket on the local clock. These cards sit beside
 * those charts, so they use the local day — a "peak hour" from `message_hours` (already local) sold
 * as belonging to a UTC day would put the evening's work on tomorrow's card at UTC-3.
 */

import { format, parseISO } from 'date-fns'
import type { SurfaceHarnessId, SessionMeta } from '@agentistics/core'
import { canonicalProjectPath, sessionCostUSD, sessionModelUsage, calcCost, sessionTokenTotal, totalTokens, usageTokens } from '@agentistics/core'

/** What a board is ranked by. The same three `topUsage.ts` offers, and for the same reason. */
export type TopMetric = 'cost' | 'tokens' | 'sessions'

export interface Leader {
  /** The thing ranked — a model id, a harness id, a tool name, a project path, a session id. */
  key: string
  /** What to print. For a session this is its label; for everything else it equals `key`. */
  label: string
  cost: number
  tokens: number
  sessions: number
  /** Tool CALLS. Zero on boards where the notion does not apply. */
  calls: number
}

export interface Board {
  entries: Leader[]
  /** The total across EVERY entry, not just the ones shown — a share needs its whole. */
  total: number
  /** How many distinct entries existed before the top N was taken. */
  distinct: number
}

const EMPTY_BOARD: Board = { entries: [], total: 0, distinct: 0 }

/** The local calendar day a session started on, or `null` when it has no usable start time. */
export function sessionDayLocal(s: SessionMeta): string | null {
  if (typeof s.start_time !== 'string' || s.start_time === '') return null
  const t = parseISO(s.start_time)
  return Number.isNaN(t.getTime()) ? null : format(t, 'yyyy-MM-dd')
}

/**
 * The most recent day with any session in this set, or `null`.
 *
 * Derived from the data rather than from the clock: with a date filter on, "today" may hold nothing
 * at all, and a card that renders an empty day because the calendar says so — while the filter is
 * plainly full of sessions — reads as a broken card rather than as an empty Tuesday.
 */
export function lastActiveDay(sessions: readonly SessionMeta[]): string | null {
  let best: string | null = null
  for (const s of sessions) {
    const day = sessionDayLocal(s)
    if (day && (best === null || day > best)) best = day
  }
  return best
}

export function sessionsOnDay(sessions: readonly SessionMeta[], day: string | null): SessionMeta[] {
  if (!day) return []
  return sessions.filter(s => sessionDayLocal(s) === day)
}

function valueOf(e: Leader, metric: TopMetric): number {
  return metric === 'cost' ? e.cost : metric === 'tokens' ? e.tokens : e.sessions
}

/** Rank, with ties broken on the runner-up metrics and then the key — so renders are stable. */
function finish(acc: Map<string, Leader>, metric: TopMetric, limit: number): Board {
  const all = [...acc.values()]
  all.sort((a, b) =>
    valueOf(b, metric) - valueOf(a, metric)
    || b.cost - a.cost
    || b.tokens - a.tokens
    || a.key.localeCompare(b.key))
  return {
    entries: all.slice(0, limit),
    total: all.reduce((sum, e) => sum + valueOf(e, metric), 0),
    distinct: all.length,
  }
}

const blank = (key: string, label = key): Leader =>
  ({ key, label, cost: 0, tokens: 0, sessions: 0, calls: 0 })

/**
 * Rank whole SESSIONS.
 *
 * The one board whose key is not a category: it answers "which single conversation cost me that",
 * which is the question a surprising monthly figure actually raises. `labelOf` is passed in because
 * naming a session is `sessionLabel()`'s job and that lives beside the UI's fallbacks.
 */
export function rankSessions(
  sessions: readonly SessionMeta[],
  metric: TopMetric,
  labelOf: (s: SessionMeta) => string,
  limit = 5,
): Board {
  const acc = new Map<string, Leader>()
  for (const s of sessions) {
    if (!s.session_id) continue
    const e = acc.get(s.session_id) ?? blank(s.session_id, labelOf(s))
    e.cost += sessionCostUSD(s) ?? 0
    e.tokens += sessionTokenTotal(s)
    e.sessions = 1
    e.calls += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
    acc.set(s.session_id, e)
  }
  return finish(acc, metric, limit)
}

/**
 * Rank MODELS.
 *
 * Per model rather than per session, because one session can span several (an Antigravity parent
 * with its subagent children folded in runs Opus and Gemini Flash) and filing all of it under one
 * label hands the cheap model the expensive one's spend.
 */
export function rankModels(sessions: readonly SessionMeta[], metric: TopMetric, limit = 5): Board {
  const acc = new Map<string, Leader>()
  for (const s of sessions) {
    for (const [model, usage] of sessionModelUsage(s)) {
      if (!model) continue
      const e = acc.get(model) ?? blank(model)
      e.cost += calcCost(usage, model)
      e.tokens += totalTokens(usageTokens(usage))
      // A session that used both models really did touch both, so it counts once for each.
      e.sessions += 1
      acc.set(model, e)
    }
  }
  return finish(acc, metric, limit)
}

export function rankHarnesses(sessions: readonly SessionMeta[], metric: TopMetric, limit = 5): Board {
  const acc = new Map<string, Leader>()
  for (const s of sessions) {
    const key: SurfaceHarnessId = s.harness ?? 'claude'
    const e = acc.get(key) ?? blank(key)
    e.cost += sessionCostUSD(s) ?? 0
    e.tokens += sessionTokenTotal(s)
    e.sessions += 1
    acc.set(key, e)
  }
  return finish(acc, metric, limit)
}

export function rankProjects(sessions: readonly SessionMeta[], metric: TopMetric, limit = 5): Board {
  const acc = new Map<string, Leader>()
  for (const s of sessions) {
    const key = canonicalProjectPath(s.project_path ?? '')
    if (!key) continue
    const e = acc.get(key) ?? blank(key)
    e.cost += sessionCostUSD(s) ?? 0
    e.tokens += sessionTokenTotal(s)
    e.sessions += 1
    acc.set(key, e)
  }
  return finish(acc, metric, limit)
}

/**
 * Rank TOOL CALLS.
 *
 * Always by call count — the only metric this board has. A per-tool cost cannot be honestly
 * attributed: a tool's result is billed as part of whatever turn read it, and dividing a session's
 * spend among its tools by call count would invent a number that looks measured. `Board.total` is
 * therefore calls, and `metric` is not a parameter here rather than being one that is ignored.
 */
export function rankTools(sessions: readonly SessionMeta[], limit = 5): Board {
  const acc = new Map<string, Leader>()
  for (const s of sessions) {
    for (const [tool, n] of Object.entries(s.tool_counts ?? {})) {
      if (!tool || !n) continue
      const e = acc.get(tool) ?? blank(tool)
      e.calls += n
      e.sessions += 1
      acc.set(tool, e)
    }
  }
  const all = [...acc.values()].sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key))
  return {
    entries: all.slice(0, limit),
    total: all.reduce((sum, e) => sum + e.calls, 0),
    distinct: all.length,
  }
}

export interface HourPeak {
  /** 0–23, local clock. */
  hour: number
  messages: number
  /** Share of the day's messages that fell in this hour, 0–1. */
  share: number
}

/**
 * The 24 local-clock buckets and the busiest one.
 *
 * From `message_hours`, which every adapter is required to bucket on the LOCAL clock — the same
 * source the home's hour histogram uses, so the two can never disagree about when the peak was.
 * `peak` is `null` when nothing was recorded, never hour 0: midnight is a real answer and "no data"
 * must not be able to impersonate it.
 */
export function hourProfile(sessions: readonly SessionMeta[]): { hours: number[]; peak: HourPeak | null } {
  const hours = Array.from({ length: 24 }, () => 0)
  for (const s of sessions) {
    for (const h of s.message_hours ?? []) {
      if (Number.isInteger(h) && h >= 0 && h <= 23) hours[h] = (hours[h] ?? 0) + 1
    }
  }
  const total = hours.reduce((a, b) => a + b, 0)
  if (total === 0) return { hours, peak: null }
  let peakHour = 0
  for (let i = 1; i < 24; i++) if ((hours[i] ?? 0) > (hours[peakHour] ?? 0)) peakHour = i
  return {
    hours,
    peak: { hour: peakHour, messages: hours[peakHour] ?? 0, share: (hours[peakHour] ?? 0) / total },
  }
}

/** Share of the board's whole, 0–1. Zero when there is nothing to take a share of. */
export function shareOf(entry: Leader, board: Board, metric: TopMetric | 'calls'): number {
  if (board.total <= 0) return 0
  const v = metric === 'calls' ? entry.calls : valueOf(entry, metric)
  return v / board.total
}

export { EMPTY_BOARD }
