/**
 * AGENT SCHEDULE — the host half (CONTAS.AGENDA-AGENTICA, reworked by CONTAS.AGENDA-SALVAR). The
 * rule is pure in `@agentistics/core` (`agentSchedule.ts`):
 *
 *   available = agentUseEnabled && (agentOverride || schedule says on)
 *
 * This module reads the registry and the stored weekly readings, and WRITES the result into the
 * account's one flag, `available` — which every router, spawn rule and `agentistics_plan_limits`
 * already honours. There is no second flag.
 *
 * Runs once a minute in the server process and right after any edit. A session already running on
 * an account whose window closes is NOT killed: it only stops being offered new work (and the
 * automatic account switch moves it at its next turn, as it does for any account turned off).
 */
import {
  agentUseSettings, foldDayUsage, resolveAgentUse, scheduleActive, scheduleVerdict,
  type AgentDayBaseline, type AgentSchedule, type AgentUseReason, type PlanLimits,
} from '@agentistics/core'
import { readAccounts, updateAccount, type AccountPatch, type HarnessAccount } from './harness-accounts'

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

/** What the screens show next to the two switches. Present for every account that is not retired. */
export interface AgentUseView {
  reason: AgentUseReason
  on: boolean
  /** The "Agenda" master switch. */
  enabled: boolean
  /** "Sobrescrever a agenda". */
  override: boolean
  /** Weekly quota spent today, in percentage points; null = not measurable. */
  dayUsedPct: number | null
  maxDailyPct?: number
  /** Absolute weekly usage now (null = no weekly reading) and the weekly ceiling, if any. */
  weekUsedPct: number | null
  maxWeeklyPct?: number
}

function evaluate(a: HarnessAccount, limits: readonly PlanLimits[], now: Date) {
  if (a.retired) return null
  const settings = agentUseSettings(a)
  const schedule = a.agentSchedule
  let baseline = a.agentDayBaseline, dayUsedPct: number | null = null, weekUsedPct: number | null = null
  let verdict: ReturnType<typeof scheduleVerdict> | null = null
  if (scheduleActive(schedule)) {
    const week = weekReading(limits, a.id)
    const folded = foldDayUsage(a.agentDayBaseline, week, now)
    baseline = folded.baseline; dayUsedPct = folded.dayUsedPct
    weekUsedPct = week ? week.usedPct : null
    verdict = scheduleVerdict(schedule, now, dayUsedPct, weekUsedPct)
  }
  const state = resolveAgentUse(settings, schedule, verdict)
  return { settings, baseline, dayUsedPct, weekUsedPct, verdict, state }
}

export function agentUseView(a: HarnessAccount, limits: readonly PlanLimits[], now = new Date()): AgentUseView | undefined {
  const e = evaluate(a, limits, now)
  if (!e) return undefined
  return {
    reason: e.state.reason, on: e.state.available, enabled: e.settings.enabled, override: e.settings.override,
    dayUsedPct: e.dayUsedPct, weekUsedPct: e.weekUsedPct,
    ...(e.verdict?.maxDailyPct !== undefined ? { maxDailyPct: e.verdict.maxDailyPct } : {}),
    ...(e.verdict?.maxWeeklyPct !== undefined ? { maxWeeklyPct: e.verdict.maxWeeklyPct } : {}),
  }
}

const sameBaseline = (a?: AgentDayBaseline, b?: AgentDayBaseline) =>
  a?.day === b?.day && a?.weekPct === b?.weekPct && a?.resetsAt === b?.resetsAt

/** Apply the rule to every account; writes only what changed. Returns the ids that changed `available`. */
export async function evaluateAgentSchedules(now = new Date(), only?: string): Promise<string[]> {
  const file = await readAccounts().catch(() => null)
  if (!file) return []
  const targets = file.accounts.filter(a => (!only || a.id === only) && !a.retired)
  if (!targets.length) return []
  const limits = await limitsSource().catch(() => [] as PlanLimits[])
  const flipped: string[] = []
  for (const a of targets) {
    const e = evaluate(a, limits, now)
    if (!e) continue
    const changedFlag = e.state.available !== a.available
    const storedOk = a.agentUseEnabled === e.settings.enabled && (a.agentOverride ?? false) === e.settings.override && a.agentManual === undefined
    const baselineChanged = scheduleActive(a.agentSchedule) && !sameBaseline(e.baseline, a.agentDayBaseline)
    if (!changedFlag && storedOk && !baselineChanged) continue
    await updateAccount(a.id, {
      available: e.state.available,
      // The migration lands here: old records gain the two stored fields and lose `agentManual`.
      agentUseEnabled: e.settings.enabled,
      agentOverride: e.settings.override,
      agentManual: null,
      ...(e.baseline && baselineChanged ? { agentDayBaseline: e.baseline } : {}),
    })
    if (changedFlag) flipped.push(a.id)
  }
  if (flipped.length) notify()
  return flipped
}

/** What one request may change about how agents use an account. */
export interface AgentUseEdit {
  agentUseEnabled?: boolean
  agentOverride?: boolean
  /** `null` removes the schedule. */
  agentSchedule?: AgentSchedule | null
}

/**
 * Apply the switches and/or the schedule in ONE write, then recompute `available` at once. The
 * drawer's single Save and the popup's single-field edits both come through here.
 */
export async function setAccountAgentUse(
  id: string, edit: AgentUseEdit, extra: Pick<AccountPatch, 'nickname'> = {}, now = new Date(),
): Promise<HarnessAccount | null> {
  const patch: AccountPatch = { ...extra }
  if (edit.agentUseEnabled !== undefined) patch.agentUseEnabled = edit.agentUseEnabled
  if (edit.agentOverride !== undefined) patch.agentOverride = edit.agentOverride
  if (edit.agentSchedule !== undefined) patch.agentSchedule = edit.agentSchedule
  const saved = await updateAccount(id, patch)
  if (!saved) return null
  // `evaluateAgentSchedules` already announces a flip of `available`; announce an edit that flipped nothing (a switch, a schedule) once.
  if ((await evaluateAgentSchedules(now, saved.id)).length === 0) notify()
  const file = await readAccounts().catch(() => null)
  return file?.accounts.find(x => x.id === saved.id) ?? saved
}

/** The old single switch (`PATCH {available}`, MCP, scripts): it is the "Agenda" master. */
export const toggleAccountAgentUse = (id: string, desired: boolean, now = new Date()) =>
  setAccountAgentUse(id, { agentUseEnabled: desired }, {}, now)

/** Save (or remove, with `null`) a schedule and apply it at once. */
export const setAccountAgentSchedule = (id: string, schedule: AgentSchedule | null, now = new Date()) =>
  setAccountAgentUse(id, { agentSchedule: schedule }, {}, now)

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
