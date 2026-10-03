/**
 * home.ts — PURE: the `home` tab (HM-01…HM-07, docs/superpowers/specs/2026-09-28-harness-tui-design.md
 * and the prototype's `scrHome`). What each card SAYS, and how wide it may be; `tabs/Home.tsx` only
 * draws these lines.
 *
 * Every figure follows the house rules: the UTC day for "today" (the billing / tag day rule), all four
 * token counters (`sessionTokenTotal`), cost labelled api-equivalent, and N/A — never 0 — for what the
 * source cannot produce, with the sentence that says why.
 */
import { sessionCostUSD, sessionTokenTotal, type SessionMeta } from '@agentistics/core'
import type { ControlSession, SessionState } from './types'

// ── layout ────────────────────────────────────────────────────────────────────────────────────────

export interface HomeLayout {
  /** < 100 columns (D-TUI-10): the compact mark and two cards (resume, your tasks). */
  narrow: boolean
  cardWidth: number
  cards: readonly HomeCardId[]
  promptWidth: number
}

export type HomeCardId = 'today' | 'resume' | 'tasks' | 'providers'

export const NARROW_BELOW = 100

export function homeLayout(width: number): HomeLayout {
  const narrow = width < NARROW_BELOW
  if (narrow) {
    const cardWidth = Math.max(20, Math.floor((width - 3) / 2))
    return { narrow, cardWidth, cards: ['resume', 'tasks'], promptWidth: Math.max(30, width - 4) }
  }
  // Four cards and a one-column gap between each, as the prototype lays them at 108.
  const cardWidth = Math.max(22, Math.floor((width - 5) / 4))
  return { narrow, cardWidth, cards: ['today', 'resume', 'tasks', 'providers'], promptWidth: Math.min(80, width - 4) }
}

// ── today (HM-03) ─────────────────────────────────────────────────────────────────────────────────

export interface TodayFigures {
  costUSD: number | null
  tokens: number | null
  sessions: number
  live: number
  streak: number
  /** Cost per UTC day, oldest first, `days` long; silent days are explicit zeros. */
  spark: number[]
}

const utcDay = (iso: string | undefined): string | null => (iso && iso.length >= 10 ? iso.slice(0, 10) : null)

function dayBefore(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

const LIVE: ReadonlySet<SessionState> = new Set(['working', 'waiting-approval', 'waiting'])

/**
 * The day's figures from the dashboard's own data (`/api/data` sessions). `sessions` counts sessions
 * that STARTED today (UTC); `live` counts the fleet rows that are running right now. Tokens are the
 * four counters of today's sessions — `null` when none of them reported any (a harness that records
 * no tokens is not a free day). The streak counts consecutive UTC days with a session, ending today
 * (or yesterday, when today has none yet — a streak is not broken by a morning).
 */
export function todayFigures(sessions: readonly SessionMeta[], fleet: readonly ControlSession[], now: Date, days = 14): TodayFigures {
  const today = now.toISOString().slice(0, 10)
  const byDay = new Map<string, number>()
  const active = new Set<string>()
  let cost: number | null = null
  let tokens: number | null = null
  let count = 0
  for (const s of sessions) {
    const day = utcDay(s.start_time)
    if (!day) continue
    active.add(day)
    const c = sessionCostUSD(s)
    if (c !== null) byDay.set(day, (byDay.get(day) ?? 0) + c)
    if (day !== today) continue
    count += 1
    if (c !== null) cost = (cost ?? 0) + c
    const reported = s.input_tokens !== undefined || s.output_tokens !== undefined
      || s.cache_read_input_tokens !== undefined || s.cache_creation_input_tokens !== undefined
    if (reported) tokens = (tokens ?? 0) + sessionTokenTotal(s)
  }
  let streak = 0
  let cursor = active.has(today) ? today : dayBefore(today, 1)
  while (active.has(cursor)) { streak += 1; cursor = dayBefore(cursor, 1) }
  const spark: number[] = []
  for (let i = days - 1; i >= 0; i--) spark.push(byDay.get(dayBefore(today, i)) ?? 0)
  return { costUSD: cost, tokens, sessions: count, live: fleet.filter(f => LIVE.has(f.state)).length, streak, spark }
}

// ── formatting ────────────────────────────────────────────────────────────────────────────────────

export function money(usd: number | null): string {
  if (usd === null) return 'N/A'
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export function compactTokens(n: number | null): string {
  if (n === null) return 'N/A'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** `3m`, `2h`, `4d` — how long ago, from epoch ms. */
export function ageOf(ms: number | undefined, now: number): string {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// ── resume (HM-04) ────────────────────────────────────────────────────────────────────────────────

export interface ResumeRow {
  id: string
  title: string
  cost?: string
  task?: string
  age: string
  state: SessionState
  stateLabel: string
  /** A native session opens in the `code` tab; anything else attaches (or refuses) like `sessions`. */
  native: boolean
}

/**
 * The 3 most recent sessions a person can go back to: running ones first (newest activity first),
 * then closed ones that can be reopened. A row with no way back (`unknown` — agentop did not start it)
 * is left out: a numbered shortcut to "cannot open that" is not a resume.
 */
/** A native session the code host can reopen (engine-api 1.8 `CodeRecentSession`). */
export interface NativeRecent { sessionId: string; title: string; task?: string; updatedAt: string; status: string }

export function resumeRows(
  fleet: readonly ControlSession[],
  now: number,
  max = 3,
  native: readonly NativeRecent[] = [],
  nativeLabel: (status: string) => string = s => `native · ${s}`,
): ResumeRow[] {
  const resumable = fleet.filter(f => f.state !== 'unknown' && f.state !== 'lost' && (f.state !== 'closed' || f.resume))
  const when = (f: ControlSession) => f.endedAt ?? f.startedAt ?? 0
  const rows: (ResumeRow & { at: number; live: number })[] = resumable.map(f => ({
    id: f.id,
    title: f.title,
    ...(f.cost ? { cost: f.cost } : {}),
    ...(f.task ? { task: f.task } : {}),
    age: ageOf(when(f), now),
    state: f.state,
    stateLabel: f.stateLabel,
    native: f.harness === 'agentistics',
    at: when(f),
    live: LIVE.has(f.state) ? 1 : 0,
  }))
  for (const n of native) {
    const at = Date.parse(n.updatedAt) || 0
    rows.push({
      id: n.sessionId, title: n.title, ...(n.task ? { task: n.task } : {}), age: ageOf(at, now),
      state: n.status === 'open' ? 'waiting' : 'closed', stateLabel: nativeLabel(n.status), native: true, at, live: 0,
    })
  }
  return rows
    .sort((a, b) => b.live - a.live || b.at - a.at)
    .slice(0, max)
    .map(({ at: _at, live: _live, ...r }) => r)
}

// ── your tasks (HM-05) ────────────────────────────────────────────────────────────────────────────

export interface HomeTask {
  id: string
  /** The board's short handle (`t-0539`). */
  ref: string
  title: string
  status: string
  statusLabel: string
  /** Subtasks done / total; absent when the task has no subtasks (then no progress is drawn). */
  progress?: { done: number; total: number }
  /** The rollup cost, already formatted (`$1.42`, `N/A` when no session reported one). */
  cost?: string
  /** A closed task (done / abandoned): dimmed in `tasks`, left out of the home card. */
  closed?: boolean
}

/** The status glyph, by the board's own vocabulary (unknown ids get the neutral dot). */
export function statusGlyph(status: string): { glyph: string; tone: 'running' | 'warn' | 'done' | 'muted' } {
  if (status === 'in_progress') return { glyph: '◐', tone: 'running' }
  if (status === 'blocked') return { glyph: '■', tone: 'warn' }
  if (status === 'done') return { glyph: '✓', tone: 'done' }
  if (status === 'review') return { glyph: '◑', tone: 'running' }
  return { glyph: '○', tone: 'muted' }
}

export function shortTaskRef(id: string): string {
  const m = /^t-([0-9a-f]{4})/.exec(id)
  return m ? `t-${m[1]}` : id
}

// ── providers (HM-06) ─────────────────────────────────────────────────────────────────────────────

export type ProviderState = 'ready' | 'off' | 'unreachable' | 'missing'

export interface HomeProvider {
  id: string
  label: string
  state: ProviderState
  /** Where the credential comes from (`env`, `stored`, `keyless`), when it has one. */
  source?: string
}

export function providerTone(state: ProviderState): 'running' | 'danger' | 'muted' {
  return state === 'ready' ? 'running' : state === 'unreachable' ? 'danger' : 'muted'
}

// ── machine line (HM-07) ──────────────────────────────────────────────────────────────────────────

/** Sessions on this machine other than the one being worked in, and how many wait on a person. */
export function machineLine(fleet: readonly ControlSession[]): { others: number; need: number } {
  const others = fleet.filter(f => f.state !== 'closed').length
  const need = fleet.filter(f => f.state === 'waiting-approval' || f.state === 'waiting').length
  return { others, need }
}
