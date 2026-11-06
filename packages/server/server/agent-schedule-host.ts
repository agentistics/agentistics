/**
 * AGENT SCHEDULE — the host half (CONTAS.AGENDA-AGENTICA). The rule is pure in
 * `@agentistics/core` (`agentSchedule.ts`); this module reads the registry and the stored weekly
 * readings, and WRITES the effective state into the account's one flag, `available` — which every
 * router, spawn rule and `agentistics_plan_limits` already honours. There is no second flag.
 *
 * Runs once a minute in the server process and right after any edit. A session already running on
 * an account whose window closes is NOT killed: it only stops being offered new work (and the
 * automatic account switch moves it at its next turn, as it does for any account turned off).
 */
import {
  foldDayUsage, resolveAgentUse, scheduleActive, scheduleVerdict, toggleAgentUse,
  type AgentDayBaseline, type AgentSchedule, type AgentUseReason, type PlanLimits,
} from '@agentistics/core'
import { readAccounts, updateAccount, type HarnessAccount } from './harness-accounts'

type Limits = () => Promise<readonly PlanLimits[]>
let limitsSource: Limits = async () => (await import('./plan-limits')).storedPlanLimits()
let notify: () => void = () => { void import('./sse').then(m => m.broadcastPlanLimitsChanged()).catch(() => {}) }

/** The account's weekly window (the largest when the harness reports several scopes). */
export function weekReading(limits: readonly PlanLimits[], accountId: string): { usedPct: number; resetsAt?: number } | null {
  let best: { usedPct: number; resetsAt?: number } | null = null
  for (const l of limits) {
    if (l.account !== accountId) continue
    for (const w of l.windows) if (w.kind === 'week' && (!best || w.usedPct > best.usedPct)) best = { usedPct: w.usedPct, resetsAt: w.resetsAt }
  }
  return best
}

/** What the screens show next to the switch. Absent when no schedule is active (plain switch). */
export interface AgentUseView {
  reason: AgentUseReason
  on: boolean
  /** Weekly quota spent today, in percentage points; null = not measurable. */
  dayUsedPct: number | null
  maxDailyPct?: number
  /** Absolute weekly usage now (null = no weekly reading) and the weekly ceiling, if any. */
  weekUsedPct: number | null
  maxWeeklyPct?: number
}

function evaluate(a: HarnessAccount, limits: readonly PlanLimits[], now: Date) {
  const schedule = a.agentSchedule
  if (!scheduleActive(schedule) || a.retired) return null
  const week = weekReading(limits, a.id)
  const { baseline, dayUsedPct } = foldDayUsage(a.agentDayBaseline, week, now)
  const weekUsedPct = week ? week.usedPct : null
  const verdict = scheduleVerdict(schedule, now, dayUsedPct, weekUsedPct)
  const state = resolveAgentUse(schedule, a.agentManual, verdict)!
  return { baseline, dayUsedPct, weekUsedPct, verdict, state }
}

export function agentUseView(a: HarnessAccount, limits: readonly PlanLimits[], now = new Date()): AgentUseView | undefined {
  const e = evaluate(a, limits, now)
  if (!e) return undefined
  // The view reports the state the evaluator WILL write, so a screen is never a minute behind an edit.
  return { reason: e.state.reason, on: e.state.available, dayUsedPct: e.dayUsedPct, weekUsedPct: e.weekUsedPct, ...(e.verdict.maxDailyPct !== undefined ? { maxDailyPct: e.verdict.maxDailyPct } : {}), ...(e.verdict.maxWeeklyPct !== undefined ? { maxWeeklyPct: e.verdict.maxWeeklyPct } : {}) }
}

const sameBaseline = (a?: AgentDayBaseline, b?: AgentDayBaseline) =>
  a?.day === b?.day && a?.weekPct === b?.weekPct && a?.resetsAt === b?.resetsAt

/** Apply the schedule to every account; writes only what changed. Returns the ids that changed `available`. */
export async function evaluateAgentSchedules(now = new Date(), only?: string): Promise<string[]> {
  const file = await readAccounts().catch(() => null)
  if (!file) return []
  const targets = file.accounts.filter(a => (!only || a.id === only) && scheduleActive(a.agentSchedule) && !a.retired)
  if (!targets.length) return []
  const limits = await limitsSource().catch(() => [] as PlanLimits[])
  const flipped: string[] = []
  for (const a of targets) {
    const e = evaluate(a, limits, now)
    if (!e) continue
    const changedFlag = e.state.available !== a.available
    if (!changedFlag && e.state.manual === a.agentManual && sameBaseline(e.baseline, a.agentDayBaseline)) continue
    await updateAccount(a.id, {
      available: e.state.available,
      agentManual: e.state.manual ?? null,
      ...(e.baseline && !sameBaseline(e.baseline, a.agentDayBaseline) ? { agentDayBaseline: e.baseline } : {}),
    })
    if (changedFlag) flipped.push(a.id)
  }
  if (flipped.length) notify()
  return flipped
}

/** A person flipped the switch: with an active schedule, against it is a manual override, with it is "back to the schedule". */
export async function toggleAccountAgentUse(id: string, desired: boolean, now = new Date()): Promise<HarnessAccount | null> {
  const file = await readAccounts().catch(() => null)
  const a = file?.accounts.find(x => x.id === id)
  if (!a || !scheduleActive(a.agentSchedule)) return updateAccount(id, { available: desired })
  const e = evaluate(a, await limitsSource().catch(() => []), now)
  const next = toggleAgentUse(a.agentSchedule, desired, e?.verdict ?? null)
  const out = await updateAccount(id, { available: next.available, agentManual: next.manual ?? null })
  notify()
  return out
}

/** Save (or remove, with `null`) a schedule and apply it at once. */
export async function setAccountAgentSchedule(id: string, schedule: AgentSchedule | null, now = new Date()): Promise<HarnessAccount | null> {
  // A new schedule starts from the schedule, not from an override made under the old one.
  const saved = await updateAccount(id, { agentSchedule: schedule, agentManual: null })
  if (!saved) return null
  if (scheduleActive(schedule)) await evaluateAgentSchedules(now, saved.id)
  else notify()
  const file = await readAccounts().catch(() => null)
  return file?.accounts.find(x => x.id === saved.id) ?? saved
}

let timer: ReturnType<typeof setInterval> | null = null
/** Once a minute, in the server process only. */
export function startAgentScheduleTicker(): void {
  if (timer) return
  void evaluateAgentSchedules().catch(() => {})
  timer = setInterval(() => { void evaluateAgentSchedules().catch(() => {}) }, 60_000)
  timer.unref?.()
}

export function __setAgentScheduleDepsForTest(deps: { limits?: Limits; notify?: () => void } | null): void {
  limitsSource = deps?.limits ?? (async () => (await import('./plan-limits')).storedPlanLimits())
  notify = deps?.notify ?? (() => { void import('./sse').then(m => m.broadcastPlanLimitsChanged()).catch(() => {}) })
}
