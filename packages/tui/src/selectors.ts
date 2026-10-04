/**
 * Pure `AppData -> view model` transforms for the terminal UI.
 *
 * Everything here is a total function of its inputs: no I/O, no clock reads (callers pass
 * `today`), no React. That is what makes the screens thin and this file testable.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: `stats-cache.json` is Claude-only. Claude totals come
 * from the cache (it holds deep history that no longer exists as individual session files);
 * every other harness is summed per-session. Mixing the two directions inflates or shrinks
 * numbers silently, so each aggregation below picks its source explicitly.
 */

import type { AppData, SurfaceHarnessId, ModelUsage, SessionMeta, StatsCache } from '@agentistics/core'
import { calcCost, isUnpricedModel, unpricedTokens, canonicalProjectPath, sessionCostUSD, sessionModelUsage, sessionLabel, sessionTokenTotal, usageTokenTotal, SURFACE_HARNESS_ORDER } from '@agentistics/core'

export interface HarnessRow {
  harness: SurfaceHarnessId
  sessions: number
  /** `null` on the projected path: the journal counts the person's turns, not transcript lines. */
  messages: number | null
  tokens: number
  costUSD: number
  /** PRICE.UNKNOWN: tokens of models with no price. Absent = 0. */
  unpricedTokens?: number
  /** Recorded Agent-tool invocations. Only Claude reports these (HARNESS_CAPABILITIES.agents),
   *  so for every other harness this is structurally 0 and must render as N/A, not as a count. */
  /** `null` on the projected path: no agent-invocation count is projected. */
  agents: number | null
}

export interface Totals {
  sessions: number
  tokens: number
  costUSD: number
  /** PRICE.UNKNOWN: tokens of models with no price — `costUSD` is a floor when above 0. Absent = 0. */
  unpricedTokens?: number
  messages: number | null
}

export interface ProjectRow {
  name: string
  path: string
  sessions: number
  tokens: number
  costUSD: number
  lastActivity: string
}

export interface ModelRow {
  model: string
  tokens: number
  costUSD: number
  /** PRICE.UNKNOWN: the table has no price for this model — `costUSD` is 0 and must be shown as "unknown". */
  unpriced?: boolean
}

export interface SessionRow {
  id: string
  label: string
  harness: SurfaceHarnessId
  project: string
  tokens: number
  costUSD: number
  startTime: string
  live: boolean
}

/** A session's harness, defaulting legacy/untagged rows to claude (same rule as the web app). */
export function sessionHarness(s: SessionMeta): SurfaceHarnessId {
  return (s.harness as SurfaceHarnessId | undefined) ?? 'claude'
}

/**
 * Both delegate to `@agentistics/core/tokens`, which is the single definition of what the word
 * "tokens" means in this product.
 *
 * The arithmetic here was already right — all four counters — while several web surfaces were
 * summing two. Keeping a private copy of a rule that other files got wrong is how the two drift
 * apart again, and this way `tokens.lint.test.ts` covers the terminal as well.
 */
function usageTokens(u: ModelUsage): number {
  return usageTokenTotal(u)
}

export function sessionTokens(s: SessionMeta): number {
  return sessionTokenTotal(s)
}

function agentCount(sessions: SessionMeta[]): number {
  let n = 0
  for (const s of sessions) {
    const m = s.agentMetrics
    if (!m) continue
    // totalInvocations is authoritative; fall back to the array for older records that
    // carry the invocation list without the rollup.
    n += m.totalInvocations ?? m.invocations?.length ?? 0
  }
  return n
}

/** Claude's authoritative totals. Read ONLY from the statsCache — see the file header.
 *  Agent invocations are the exception: the cache has no agent data, so they are counted from
 *  whatever sessions still exist individually. */
function claudeTotals(sc: StatsCache, sessions: SessionMeta[]): Omit<HarnessRow, 'harness'> & { messages: number; agents: number } {
  let tokens = 0
  let costUSD = 0
  let unpriced = 0
  for (const [model, usage] of Object.entries(sc.modelUsage ?? {})) {
    if (!usage) continue
    tokens += usageTokens(usage)
    costUSD += calcCost(usage, model)
    if (isUnpricedModel(model)) unpriced += usageTokens(usage)
  }
  return {
    sessions: sc.totalSessions ?? 0,
    messages: sc.totalMessages ?? 0,
    tokens,
    costUSD,
    ...(unpriced > 0 ? { unpricedTokens: unpriced } : {}),
    agents: agentCount(sessions),
  }
}

/** Any non-Claude harness: per-session sums, because no cache covers them. */
function sessionTotals(sessions: SessionMeta[]): Omit<HarnessRow, 'harness'> & { messages: number; agents: number } {
  let tokens = 0
  let costUSD = 0
  let messages = 0
  let unpriced = 0
  for (const s of sessions) {
    tokens += sessionTokens(s)
    costUSD += sessionCostUSD(s) ?? 0
    unpriced += unpricedTokens(s)
    messages += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
  }
  return { sessions: sessions.length, messages, tokens, costUSD, ...(unpriced > 0 ? { unpricedTokens: unpriced } : {}), agents: agentCount(sessions) }
}

export function harnessRows(data: AppData): HarnessRow[] {
  const present = new Set(data.harnesses ?? [])
  return SURFACE_HARNESS_ORDER.filter(h => present.has(h)).map(harness => {
    const own = (data.sessions ?? []).filter(s => sessionHarness(s) === harness)
    if (harness === 'claude') return { harness, ...claudeTotals(data.statsCache, own) }
    return { harness, ...sessionTotals(own) }
  })
}

export function overviewTotals(data: AppData): Totals {
  return harnessRows(data).reduce<Totals>(
    (acc, r) => ({
      sessions: acc.sessions + r.sessions,
      tokens: acc.tokens + r.tokens,
      costUSD: acc.costUSD + r.costUSD,
      ...((acc.unpricedTokens ?? 0) + (r.unpricedTokens ?? 0) > 0 ? { unpricedTokens: (acc.unpricedTokens ?? 0) + (r.unpricedTokens ?? 0) } : {}),
      messages: acc.messages === null || r.messages === null ? null : acc.messages + r.messages,
    }),
    { sessions: 0, tokens: 0, costUSD: 0, messages: 0 },
  )
}

function isoDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Message counts for the last `days` days, oldest first, with silent days as explicit zeros —
 * a sparkline that omitted them would compress the gaps and misrepresent the rhythm.
 */
export function activitySeries(data: AppData, days: number, today: Date): number[] {
  const byDate = new Map<string, number>()
  for (const d of data.statsCache?.dailyActivity ?? []) {
    byDate.set(d.date, (byDate.get(d.date) ?? 0) + (d.messageCount ?? 0))
  }
  const out: number[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    out.push(byDate.get(isoDay(d)) ?? 0)
  }
  return out
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function projectRows(data: AppData): ProjectRow[] {
  const acc = new Map<string, ProjectRow>()
  for (const s of data.sessions ?? []) {
    // The project ROOT: a worktree's sessions roll up to its repository, as on every surface.
    const path = canonicalProjectPath(s.project_path || '')
    let row = acc.get(path)
    if (!row) {
      row = { name: basename(path), path, sessions: 0, tokens: 0, costUSD: 0, lastActivity: '' }
      acc.set(path, row)
    }
    row.sessions += 1
    row.tokens += sessionTokens(s)
    row.costUSD += sessionCostUSD(s) ?? 0
    const t = s.end_time || s.start_time || ''
    if (t > row.lastActivity) row.lastActivity = t
  }
  return [...acc.values()].sort((a, b) => b.costUSD - a.costUSD)
}

/**
 * Per-model totals. Claude's share comes from the statsCache and every other harness from its
 * sessions, so a model driven by two harnesses accumulates from both without double counting.
 */
export function modelRows(data: AppData): ModelRow[] {
  const acc = new Map<string, ModelRow>()
  const add = (model: string, usage: ModelUsage) => {
    let row = acc.get(model)
    if (!row) {
      row = { model, tokens: 0, costUSD: 0 }
      acc.set(model, row)
    }
    row.tokens += usageTokens(usage)
    row.costUSD += calcCost(usage, model)
    if (isUnpricedModel(model)) row.unpriced = true
  }

  for (const [model, usage] of Object.entries(data.statsCache?.modelUsage ?? {})) {
    if (usage) add(model, usage)
  }
  for (const s of data.sessions ?? []) {
    if (sessionHarness(s) === 'claude') continue // already in the cache above
    for (const [model, usage] of sessionModelUsage(s)) add(model, usage)
  }

  return [...acc.values()].sort((a, b) => b.costUSD - a.costUSD)
}

export function sessionRows(data: AppData, opts: { limit?: number } = {}): SessionRow[] {
  const live = new Set(data.liveSessionIds ?? [])
  const rows = (data.sessions ?? [])
    .map<SessionRow>(s => ({
      id: s.session_id,
      label: sessionLabel(s),
      harness: sessionHarness(s),
      project: basename(s.project_path || ''),
      tokens: sessionTokens(s),
      costUSD: sessionCostUSD(s) ?? 0,
      startTime: s.start_time || '',
      live: live.has(s.session_id),
    }))
    .sort((a, b) => (a.startTime < b.startTime ? 1 : a.startTime > b.startTime ? -1 : 0))
  return opts.limit != null ? rows.slice(0, opts.limit) : rows
}
