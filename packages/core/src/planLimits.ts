/**
 * PLAN LIMITS — how much of a subscription's rolling windows (5 hours, one week) is used, per
 * harness account. PURE: the server reads the harness's own records and hands the parsed lines in;
 * every surface (the composer circle, the new-session cards, Nay's Limits tab, the threshold
 * notices) reads the SAME record through the helpers below, so they can never disagree.
 *
 * Sources, both official and both free (no extra request that would spend quota):
 * - claude: the stream-json `rate_limit_event` every structured turn emits
 *   (`rate_limit_info.unifiedWindows.{five_hour,seven_day}`, `utilization` 0..1, `resetsAt` epoch s).
 * - codex: the `rate_limits` block on every rollout `token_count` event
 *   (`primary`/`secondary`, `used_percent` 0..100, `window_minutes` 300 / 10080, `resets_at` epoch s).
 *
 * A harness with no record has NO entry — never a zero: nothing observed is not nothing used.
 */
import type { HarnessId } from './types'
import type { BillingSettings } from './billing'
import { dayFromMs } from './billing'
import { findPlan } from './plan-catalog'

export type PlanWindowKind = '5h' | 'week'

const DAY_MS = 24 * 60 * 60_000

export const PLAN_WINDOW_MS: Record<PlanWindowKind, number> = {
  '5h': 5 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
}

export interface PlanLimitWindow {
  kind: PlanWindowKind
  /** 0..100 (may exceed 100 when a harness reports overage). */
  usedPct: number
  /** Epoch ms at which the window renews. */
  resetsAt: number
}

export type PlanLimitSource = 'claude-stream' | 'codex-rollout' | 'codex-app-server'

export interface PlanLimits {
  harness: HarnessId
  /** Account key within the harness; one account per harness today (`'default'`). */
  account: string
  /** The plan as registered in Settings → Billing (filled by `withPlanLabel`). */
  plan?: string
  /** A plan name the harness itself reported (codex `plan_type`), the fallback for `plan`. */
  sourcePlan?: string
  windows: PlanLimitWindow[]
  /** Epoch ms of the record the windows were read from. */
  updatedAt: number
  source: PlanLimitSource
}

export const PLAN_BUDGET_HOLD_5H_PCT = 85
export const PLAN_BUDGET_HOLD_WEEK_PCT = 95
export const PLAN_BUDGET_TIGHT_WEEK_PCT = 80

export type PlanBudgetStatus = 'ok' | 'tight' | 'hold'
export interface PlanBudget {
  harness: HarnessId
  plan: string
  fiveHourPct: number
  weekPct: number
  weekResetsAt: number
  daysToWeekReset: number
  dailyBudgetPct: number
  status: PlanBudgetStatus
}

export type PlanPaceStatus = 'under' | 'on' | 'over'
export interface PlanPace {
  paceStatus: PlanPaceStatus
  burnPctPerHour: number
  sustainablePctPerHour: number
  suggestedParallel: number
  note: string
  /** Slots remaining after the currently live sessions' measured burn. */
  freeSlots: number
  /** Whether freeSlots is based on a positive measured per-session burn. */
  freeSlotsMeasured: boolean
  /** The live sessions used to calculate the shared pool. */
  liveSessions: LivePlanSession[]
  /** When an over-pace plan can be considered again. */
  pauseUntil?: number
}

export interface LivePlanSession {
  id: string
  model: string
  burnPctPerHour: number
  /** Internal routing hint; API responses omit it. */
  harness?: HarnessId
}

export interface PlanSlotInput {
  sustainablePctPerHour: number
  liveSessions: readonly LivePlanSession[]
  /** Typical burn for one additional session, when no live session is available. */
  typicalBurnPctPerHour?: number
  /** Number of sessions represented by the plan burn reading, when no live session is present. */
  measuredLiveCount?: number
  /** Cadence fallback when no per-session burn has been measured yet. */
  fallbackParallel?: number
  pauseUntil?: number
}

/** Calculate the one shared pool used by all harnesses and all owners. */
export function planSlots(input: PlanSlotInput): { freeSlots: number; freeSlotsMeasured: boolean; liveSessions: LivePlanSession[]; pauseUntil?: number } {
  const sessions = input.liveSessions.filter(s => finite(s.burnPctPerHour) && s.burnPctPerHour >= 0)
  const totalBurn = sessions.reduce((sum, s) => sum + s.burnPctPerHour, 0)
  const perSession = sessions.length
    ? sessions.reduce((sum, s) => sum + s.burnPctPerHour, 0) / sessions.length
    : (input.typicalBurnPctPerHour ?? input.sustainablePctPerHour) / Math.max(1, input.measuredLiveCount ?? 1)
  const freeSlotsMeasured = perSession > 0
  const freeSlots = freeSlotsMeasured
    ? Math.max(0, Math.floor((input.sustainablePctPerHour - totalBurn) / perSession))
    : Math.max(0, (input.fallbackParallel ?? 1) - sessions.length)
  return {
    freeSlots,
    freeSlotsMeasured,
    liveSessions: sessions.map(({ harness: _harness, ...s }) => ({ ...s })),
    ...(input.pauseUntil !== undefined ? { pauseUntil: input.pauseUntil } : {}),
  }
}

export type RouteKind = 'lead' | 'hard-bug' | 'design' | 'spec-impl' | 'mechanical' | 'qa' | 'probe'
export interface RouteRecommendation {
  harness: HarnessId | null
  model?: string
  reason: string
  alternatives: HarnessId[]
  cadence: { parallel: number; note: string }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** Epoch seconds → ms; a value already in ms (> year 2200 in seconds) is kept. */
const toMs = (v: number): number => (v > 7_258_118_400 ? v : v * 1000)

/**
 * One stream-json line (already `JSON.parse`d) → a claude record, or `null` when it is not a
 * `rate_limit_event` or carries no usable window. `atMs` is when the line was written.
 */
export function parseClaudeRateLimitEvent(line: unknown, atMs: number): PlanLimits | null {
  const o = obj(line)
  if (!o || o.type !== 'rate_limit_event') return null
  const info = obj(o.rate_limit_info)
  const unified = obj(info?.unifiedWindows)
  if (!unified) return null
  const windows: PlanLimitWindow[] = []
  const pairs: [string, PlanWindowKind][] = [['five_hour', '5h'], ['seven_day', 'week']]
  for (const [key, kind] of pairs) {
    const w = obj(unified[key])
    if (!w || !finite(w.utilization) || !finite(w.resetsAt)) continue
    windows.push({ kind, usedPct: round1(w.utilization * 100), resetsAt: toMs(w.resetsAt) })
  }
  if (!windows.length || !finite(atMs)) return null
  return { harness: 'claude', account: 'default', windows, updatedAt: atMs, source: 'claude-stream' }
}

/**
 * One codex rollout line (already parsed) → a codex record, or `null`. Only a `token_count`
 * event's `rate_limits` counts; the window kind is read from `window_minutes`, never from the
 * primary/secondary position.
 */
export function parseCodexRateLimits(line: unknown): PlanLimits | null {
  const o = obj(line)
  const payload = obj(o?.payload)
  if (!o || payload?.type !== 'token_count') return null
  const rl = obj(payload.rate_limits)
  if (!rl) return null
  const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  if (!Number.isFinite(at)) return null
  const windows: PlanLimitWindow[] = []
  for (const key of ['primary', 'secondary']) {
    const w = obj(rl[key])
    if (!w || !finite(w.used_percent) || !finite(w.resets_at) || !finite(w.window_minutes)) continue
    const kind: PlanWindowKind | null =
      w.window_minutes === 300 ? '5h' : w.window_minutes === 10080 ? 'week' : null
    if (!kind) continue
    windows.push({ kind, usedPct: round1(w.used_percent), resetsAt: toMs(w.resets_at) })
  }
  if (!windows.length) return null
  windows.sort((a, b) => (a.kind === '5h' ? -1 : 1) - (b.kind === '5h' ? -1 : 1))
  const plan = typeof rl.plan_type === 'string' && rl.plan_type ? rl.plan_type : undefined
  return {
    harness: 'codex',
    account: 'default',
    ...(plan ? { sourcePlan: plan } : {}),
    windows,
    updatedAt: at,
    source: 'codex-rollout',
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/** The newer of two records for the same account (by `updatedAt`). */
export function newerLimits(a: PlanLimits | undefined, b: PlanLimits): PlanLimits {
  return a && a.updatedAt >= b.updatedAt ? a : b
}

/** The plan registered for `harness` on the day of `nowMs`, by its catalog label. */
export function registeredPlanLabel(
  billing: BillingSettings | undefined,
  harness: HarnessId,
  nowMs: number,
): string | undefined {
  const today = dayFromMs(nowMs)
  const periods = billing?.profiles?.[harness]?.periods
  if (!today || !periods) return undefined
  const p = periods.find(x => x.from <= today && (!x.to || x.to >= today))
  if (!p || p.mode !== 'subscription') return undefined
  const fromCatalog = p.planId && p.planId !== 'other' ? findPlan(p.planId)?.label : undefined
  return p.label || fromCatalog || undefined
}

export function withPlanLabel(l: PlanLimits, billing: BillingSettings | undefined, nowMs: number): PlanLimits {
  const plan = registeredPlanLabel(billing, l.harness, nowMs)
  return plan ? { ...l, plan } : l
}

/** A window whose renewal time has passed has renewed: its stored percentage no longer applies. */
export function windowRenewed(w: PlanLimitWindow, nowMs: number): boolean {
  return nowMs >= w.resetsAt
}

/** The used percentage that applies NOW — `0` once the window renewed (a fact, not a guess). */
export function currentUsedPct(w: PlanLimitWindow, nowMs: number): number {
  return windowRenewed(w, nowMs) ? 0 : w.usedPct
}

/** A record is stale when it was read more than this long ago. */
export const PLAN_LIMITS_STALE_MS = 10 * 60_000

export function limitsStale(l: PlanLimits, nowMs: number): boolean {
  return nowMs - l.updatedAt > PLAN_LIMITS_STALE_MS
}

export type PlanForecast =
  | { kind: 'renewed' }
  | { kind: 'exhausted'; until: number }
  | { kind: 'lasts' }
  | { kind: 'runs-out'; at: number }

/**
 * At the AVERAGE pace of the window so far (used ÷ elapsed since the window opened), does the
 * window last until it renews, or when does it run out? The window opened at
 * `resetsAt - length`; a pace measured over less than a minute is clamped to one minute.
 */
export function forecastWindow(w: PlanLimitWindow, nowMs: number): PlanForecast {
  if (windowRenewed(w, nowMs)) return { kind: 'renewed' }
  if (w.usedPct >= 100) return { kind: 'exhausted', until: w.resetsAt }
  if (w.usedPct <= 0) return { kind: 'lasts' }
  const opened = w.resetsAt - PLAN_WINDOW_MS[w.kind]
  const elapsed = Math.max(60_000, nowMs - opened)
  const perMs = w.usedPct / elapsed
  const at = nowMs + (100 - w.usedPct) / perMs
  return at >= w.resetsAt ? { kind: 'lasts' } : { kind: 'runs-out', at: Math.round(at) }
}

/** The fullest window that applies now (the one that binds first). */
export function bindingPct(l: PlanLimits, nowMs: number): number {
  return Math.max(0, ...l.windows.map(w => currentUsedPct(w, nowMs)))
}

const windowOf = (l: PlanLimits, kind: PlanWindowKind): PlanLimitWindow | undefined => l.windows.find(w => w.kind === kind)

export function planBudget(l: PlanLimits, nowMs: number): PlanBudget {
  const five = windowOf(l, '5h')
  const week = windowOf(l, 'week')
  const fiveHourPct = five ? currentUsedPct(five, nowMs) : 0
  const weekPct = week ? currentUsedPct(week, nowMs) : 0
  const weekResetsAt = week?.resetsAt ?? nowMs
  const daysToWeekReset = Math.max(0, (weekResetsAt - nowMs) / DAY_MS)
  const dailyBudgetPct = (100 - weekPct) / Math.max(daysToWeekReset, 0.5)
  const forecast = week ? forecastWindow(week, nowMs) : { kind: 'lasts' as const }
  const status: PlanBudgetStatus = fiveHourPct >= PLAN_BUDGET_HOLD_5H_PCT || weekPct >= PLAN_BUDGET_HOLD_WEEK_PCT
    ? 'hold'
    : weekPct >= PLAN_BUDGET_TIGHT_WEEK_PCT || forecast.kind === 'runs-out'
      ? 'tight'
      : 'ok'
  return {
    harness: l.harness,
    plan: l.plan ?? l.sourcePlan ?? 'unregistered',
    fiveHourPct, weekPct, weekResetsAt, daysToWeekReset, dailyBudgetPct, status,
  }
}

export function planPace(
  l: PlanLimits,
  nowMs: number,
  history: readonly PlanLimits[] = [],
  liveSessions: readonly LivePlanSession[] = [],
): PlanPace {
  const week = windowOf(l, 'week')
  const weekPct = week ? currentUsedPct(week, nowMs) : 0
  const hoursToReset = week ? Math.max(0.5, (week.resetsAt - nowMs) / 3_600_000) : 0.5
  const sustainablePctPerHour = Math.max(0, (100 - weekPct) / hoursToReset)
  const readings = [...history.filter(x => x.updatedAt !== l.updatedAt), l]
    .filter(x => x.harness === l.harness && x.account === l.account)
    .sort((a, b) => a.updatedAt - b.updatedAt)
  const first = readings.find(x => nowMs - x.updatedAt <= 6 * 3_600_000)
  const last = readings.at(-1)
  const firstWeek = first && windowOf(first, 'week')
  const lastWeek = last && windowOf(last, 'week')
  const elapsedHours = firstWeek && lastWeek && last!.updatedAt > first!.updatedAt
    ? Math.max(1 / 60, (last!.updatedAt - first!.updatedAt) / 3_600_000) : 0
  // With only one reading there is no measured burn yet; classify as on pace until the ring has
  // a second point, so an unobserved plan does not steal a route merely because its burn is unknown.
  const burnPctPerHour = elapsedHours > 0
    ? Math.max(0, (currentUsedPct(lastWeek!, nowMs) - currentUsedPct(firstWeek!, nowMs)) / elapsedHours)
    : sustainablePctPerHour
  const ratio = sustainablePctPerHour > 0 ? burnPctPerHour / sustainablePctPerHour : 0
  const paceStatus: PlanPaceStatus = ratio > 1.2 ? 'over' : ratio < 0.8 ? 'under' : 'on'
  const five = windowOf(l, '5h')
  const fivePct = five ? currentUsedPct(five, nowMs) : 0
  const pauseReset = fivePct >= PLAN_BUDGET_HOLD_5H_PCT
    ? five?.resetsAt
    : week && weekPct >= PLAN_BUDGET_HOLD_WEEK_PCT
      ? week.resetsAt
      : undefined
  const budgetHold = pauseReset !== undefined
  const projectedPauseHours = week && burnPctPerHour > 0
    ? Math.max(0, hoursToReset - (100 - weekPct) / burnPctPerHour)
    : 0
  const nextFiveHourReset = five?.resetsAt ?? week?.resetsAt ?? nowMs
  const pauseUntil = budgetHold
    ? pauseReset
    : paceStatus === 'over'
    ? (pauseReset ?? Math.min(nextFiveHourReset, nowMs + projectedPauseHours * 3_600_000))
    : undefined
  const suggestedParallel = budgetHold || paceStatus === 'over' ? 0 : Math.max(1, Math.min(8, paceStatus === 'under'
    ? Math.max(2, Math.ceil(sustainablePctPerHour / Math.max(burnPctPerHour, sustainablePctPerHour / 2)))
    : Math.ceil(Math.max(burnPctPerHour, sustainablePctPerHour) / Math.max(sustainablePctPerHour, 0.01))))
  const slots = planSlots({
    sustainablePctPerHour,
    liveSessions,
    // With no live measurements, the measured plan burn is the only honest estimate for one
    // additional session. This keeps the old route recommendation useful while live sessions
    // are being discovered.
    typicalBurnPctPerHour: burnPctPerHour,
    measuredLiveCount: liveSessions.length,
    fallbackParallel: suggestedParallel,
    ...(pauseUntil !== undefined ? { pauseUntil } : {}),
  })
  const note = paceStatus === 'under'
    ? `Under pace: keep up to ${suggestedParallel} parallel worker${suggestedParallel === 1 ? '' : 's'} so quota is used before reset.`
    : paceStatus === 'over'
      ? `Over pace: pause until ${pauseUntil ? new Date(pauseUntil).toISOString() : 'the next reset'}; reduce concurrency until burn is sustainable.`
      : 'On pace: keep the current cadence through the weekly reset.'
  return {
    paceStatus, burnPctPerHour, sustainablePctPerHour, suggestedParallel, note,
    ...slots,
    ...(budgetHold ? { freeSlots: 0, pauseUntil } : {}),
  }
}

const ROUTE_PREFERENCES: Record<RouteKind, readonly [HarnessId, string?][]> = {
  lead: [['claude', 'opus'], ['codex']],
  'hard-bug': [['claude', 'opus'], ['codex']],
  design: [['claude', 'opus'], ['codex']],
  'spec-impl': [['codex'], ['claude', 'sonnet'], ['gemini'], ['copilot']],
  mechanical: [['codex'], ['claude', 'sonnet'], ['gemini'], ['copilot']],
  qa: [['gemini'], ['copilot'], ['codex'], ['claude', 'sonnet']],
  probe: [['claude', 'haiku'], ['gemini']],
}

export function routeRecommendation(
  /** The flat `{ ...planBudget, ...planPace }` row `/api/plan-limits` serves; pace fields are optional. */
  budgets: readonly (PlanBudget & Partial<PlanPace>)[],
  kind: RouteKind,
  authorHarness?: string,
): RouteRecommendation {
  const allowTight = kind === 'lead'
  const eligible = budgets.filter(b => b.plan !== 'unregistered' && b.status !== 'hold' && (allowTight || b.status !== 'tight') && b.harness !== (kind === 'qa' ? authorHarness : undefined))
  const ordered = [...eligible].sort((a, b) => {
    const ap = a.paceStatus === 'under' ? 0 : 1
    const bp = b.paceStatus === 'under' ? 0 : 1
    if (ap !== bp) return ap - bp
    const ai = ROUTE_PREFERENCES[kind].findIndex(([h]) => h === a.harness)
    const bi = ROUTE_PREFERENCES[kind].findIndex(([h]) => h === b.harness)
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
  })
  const preference = ROUTE_PREFERENCES[kind]
  const chosen = ordered.find(b => preference.some(([h]) => h === b.harness))
  const pick = chosen ?? ordered[0]
  if (!pick) {
    const earliest = budgets.filter(b => b.status === 'hold').sort((a, b) => a.weekResetsAt - b.weekResetsAt)[0]
    const reset = earliest ? new Date(earliest.weekResetsAt).toISOString() : 'the next reset'
    return { harness: null, reason: `all plans on hold until ${reset}`, alternatives: [], cadence: { parallel: 0, note: 'Wait for a plan to renew.' } }
  }
  const selected = preference.find(([h]) => h === pick.harness)
  const alternatives = ordered.filter(b => b.harness !== pick.harness).map(b => b.harness)
  const paceText = pick.note ? ` ${pick.note}` : ''
  return {
    harness: pick.harness,
    ...(selected?.[1] ? { model: selected[1] } : {}),
    reason: `${pick.harness} is the preferred eligible plan for ${kind}.${paceText}`,
    alternatives,
    cadence: { parallel: pick.freeSlotsMeasured ? (pick.freeSlots ?? 0) : (pick.suggestedParallel ?? 1), note: pick.note ?? 'Keep one worker running.' },
  }
}

/** The harness with the most room left, or `null` when there is nothing to compare. */
export function mostRoom(all: readonly PlanLimits[], nowMs: number): HarnessId | null {
  let best: PlanLimits | null = null
  for (const l of all) {
    if (!l.windows.length) continue
    if (!best || bindingPct(l, nowMs) < bindingPct(best, nowMs)) best = l
  }
  return best && all.length > 1 ? best.harness : null
}

/** Another harness that can take work now (every window under 95%). */
export function alternativeWithRoom(
  all: readonly PlanLimits[],
  except: HarnessId,
  nowMs: number,
): HarnessId | null {
  const others = all.filter(l => l.harness !== except && l.windows.length && bindingPct(l, nowMs) < 95)
  others.sort((a, b) => bindingPct(a, nowMs) - bindingPct(b, nowMs))
  return others[0]?.harness ?? null
}

// ─── Threshold notices ────────────────────────────────────────────────────────────────────────

export const PLAN_THRESHOLDS = [75, 85, 95, 100] as const

/** Per `harness:account:kind`: which period (its `resetsAt`) and the highest threshold told. */
export type PlanNoticeState = Record<string, { resetsAt: number; told: number }>

export interface PlanThresholdNotice {
  harness: HarnessId
  account: string
  kind: PlanWindowKind
  threshold: number
  usedPct: number
  resetsAt: number
}

/** A `resetsAt` that moved forward by more than this is a new period (absorbs second-level jitter). */
const NEW_PERIOD_MS = 5 * 60_000

/**
 * The notices `l` raises against `state`, and the state after them. ONE notice per threshold per
 * window period: crossing several at once (70% → 96%) tells only the highest; a renewal (the
 * window's `resetsAt` moving forward) clears what was told.
 */
export function planThresholdNotices(
  state: PlanNoticeState,
  l: PlanLimits,
): { notices: PlanThresholdNotice[]; state: PlanNoticeState } {
  const next: PlanNoticeState = { ...state }
  const notices: PlanThresholdNotice[] = []
  for (const w of l.windows) {
    const key = `${l.harness}:${l.account}:${w.kind}`
    const prev = next[key]
    const samePeriod = prev && w.resetsAt - prev.resetsAt <= NEW_PERIOD_MS
    if (prev && w.resetsAt < prev.resetsAt - NEW_PERIOD_MS) continue // an older record: ignore
    const told = samePeriod ? prev.told : 0
    const reached = PLAN_THRESHOLDS.filter(t => w.usedPct >= t).pop() ?? 0
    if (reached > told) {
      notices.push({
        harness: l.harness, account: l.account, kind: w.kind,
        threshold: reached, usedPct: w.usedPct, resetsAt: w.resetsAt,
      })
    }
    next[key] = { resetsAt: samePeriod ? prev.resetsAt : w.resetsAt, told: Math.max(told, reached) }
  }
  return { notices, state: next }
}
