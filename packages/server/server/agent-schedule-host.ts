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
  accountAvailableForAgents, accountAvailableNotice, agentUseSettings, foldDayUsage, HARNESS_LABELS, resolveAgentUse,
  scheduleActive, scheduleVerdict, scheduleWindowEnd, stepAvailability,
  type AccountAvailabilityState, type AgentDayBaseline, type AgentSchedule, type AgentUseReason, type PlanLimits,
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
  // An edit (Agenda on, override on, a schedule saved) is announced at once, not at the next tick.
  // Only where the ticker runs (the server process): a CLI or a test never sends a notice.
  if (timer) void checkAccountAvailability(now).catch(() => {})
  const file = await readAccounts().catch(() => null)
  return file?.accounts.find(x => x.id === saved.id) ?? saved
}

/** The old single switch (`PATCH {available}`, MCP, scripts): it is the "Agenda" master. */
export const toggleAccountAgentUse = (id: string, desired: boolean, now = new Date()) =>
  setAccountAgentUse(id, { agentUseEnabled: desired }, {}, now)

/** Save (or remove, with `null`) a schedule and apply it at once. */
export const setAccountAgentSchedule = (id: string, schedule: AgentSchedule | null, now = new Date()) =>
  setAccountAgentUse(id, { agentSchedule: schedule }, {}, now)

// ─── CONTAS.AVISO-LIDER: tell the live LEADERS when an account becomes available ────────────────

/** One account as the plan-limits payload sees it right now. */
export interface AccountObservation {
  id: string
  available: boolean
  label: string
  harness: string
  plan?: string
  reason?: AgentUseReason
  until?: string | null
}

export interface AccountNoticeDeps {
  /** Every account the payload can judge (an account with no meter at all is absent: not judged). */
  observe(now: Date): Promise<AccountObservation[]>
  /** The stored state per account id (the account records' `agentAvailability`). */
  readState(): Promise<Record<string, AccountAvailabilityState | undefined>>
  writeState(id: string, state: AccountAvailabilityState): Promise<void>
  /** The managed sessions, with whether each is running (the away notice's `liveRows`). */
  rows(): Promise<readonly { id: string; conversationId?: string; running: boolean }[]>
  /** The stored role of a session (the role store). Only `leader` is told; a worker never. */
  roleOf(id: string, conversationId?: string): Promise<string | undefined>
  send(id: string, text: string): Promise<{ ok: boolean }>
  lang(): Promise<'pt' | 'en'>
}

/** Bound on one leader's delivery, above the composer's 4 s ack (same budget as the away notice). */
const NOTICE_SEND_TIMEOUT_MS = 8_000

const defaultNoticeDeps: AccountNoticeDeps = {
  async observe(now) {
    const { planLimitsPayload, storedPlanLimits } = await import('./plan-limits')
    const { readPreferences } = await import('./preferences')
    const { canonicalAccountId } = await import('./harness-accounts')
    const nowMs = now.getTime()
    const [payload, file, stored] = await Promise.all([
      planLimitsPayload((await readPreferences()).billing, nowMs), readAccounts(), storedPlanLimits(),
    ])
    const seen = new Map<string, AccountObservation>()
    const put = (rawId: string, harness: string, available: boolean, label?: string) => {
      const rec = file.accounts.find(a => a.id === canonicalAccountId(file, rawId) && a.harness === harness && !a.retired)
      if (!rec) return
      const prior = seen.get(rec.id)
      if (prior) { prior.available ||= available; return }
      const view = agentUseView(rec, stored, now)
      const plan = rec.plan ?? payload.limits.find(l => l.harness === rec.harness && l.account === rawId)?.plan
      seen.set(rec.id, {
        id: rec.id, available, label: label ?? rec.nickname ?? HARNESS_LABELS[rec.harness], harness: HARNESS_LABELS[rec.harness],
        ...(plan ? { plan } : {}),
        ...(view ? { reason: view.reason } : {}),
        ...(view?.reason === 'in-window' ? { until: scheduleWindowEnd(rec.agentSchedule, now) } : {}),
      })
    }
    for (const b of payload.budgets) put(b.account, b.harness, accountAvailableForAgents({ visible: true, spawnable: b.spawnable, status: b.status }), b.accountLabel)
    for (const b of payload.hiddenFromAgents) put(b.account, b.harness, false, b.accountLabel)
    for (const u of payload.unmeasured ?? []) put(u.account, u.harness, false)
    return [...seen.values()]
  },
  async readState() {
    const file = await readAccounts()
    return Object.fromEntries(file.accounts.map(a => [a.id, a.agentAvailability]))
  },
  async writeState(id, state) { await updateAccount(id, { agentAvailability: state }) },
  async rows() {
    const { liveRows, awaySessionRunning } = await import('./away')
    return (await liveRows()).map(r => ({ id: r.id, ...(r.conversationId ? { conversationId: r.conversationId } : {}), running: awaySessionRunning(r) }))
  },
  async roleOf(id, conversationId) {
    const { storedRoleFor } = await import('./sessions/session-roles')
    return storedRoleFor([conversationId, id])
  },
  async send(id, text) {
    const { runFleetAction } = await import('./sessions/fleet-web')
    let t: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ ok: boolean }>(resolve => { t = setTimeout(() => resolve({ ok: false }), NOTICE_SEND_TIMEOUT_MS) })
    const sent = runFleetAction('en', { action: 'prompt', id, text: `[from agentistics · conta]\n${text}` }).then(o => ({ ok: o.ok }), () => ({ ok: false }))
    return Promise.race([sent, timeout]).finally(() => clearTimeout(t))
  },
  async lang() {
    const { readPreferences } = await import('./preferences')
    return (await readPreferences()).lang === 'pt' ? 'pt' : 'en'
  },
}
let noticeDeps: AccountNoticeDeps = defaultNoticeDeps
let noticeChain: Promise<unknown> = Promise.resolve()

/**
 * Observe every account, persist the new states, and tell each live leader ONCE per account that
 * became available (`stepAvailability`: first sight records only, flapping inside 10 min and going
 * unavailable never notify). Serialised: the minute tick and an edit never both send. Returns the
 * ids of the accounts announced.
 */
export function checkAccountAvailability(now = new Date()): Promise<string[]> {
  const run = noticeChain.then(() => runAvailabilityCheck(now))
  noticeChain = run.catch(() => {})
  return run
}

async function runAvailabilityCheck(now: Date): Promise<string[]> {
  const d = noticeDeps
  const [observed, state] = await Promise.all([d.observe(now), d.readState()])
  const announce: AccountObservation[] = []
  for (const o of observed) {
    const step = stepAvailability(state[o.id], o.available, now.getTime())
    if (step.changed) await d.writeState(o.id, step.next)
    if (step.notify) announce.push(o)
  }
  if (!announce.length) return []
  const [rows, lang] = await Promise.all([d.rows().catch(() => []), d.lang().catch(() => 'en' as const)])
  const running = rows.filter(r => r.running)
  const roles = await Promise.all(running.map(r => d.roleOf(r.id, r.conversationId).catch(() => undefined)))
  const leaders = running.filter((_, i) => roles[i] === 'leader').map(r => r.id)
  for (const o of announce) {
    const text = accountAvailableNotice({ label: o.label, harness: o.harness, plan: o.plan, reason: o.reason, until: o.until }, lang)
    await Promise.all(leaders.map(id => d.send(id, text).catch(() => ({ ok: false }))))
  }
  return announce.map(o => o.id)
}

export function __setAccountNoticeDepsForTest(deps: Partial<AccountNoticeDeps> | null): void {
  noticeDeps = deps ? { ...defaultNoticeDeps, ...deps } : defaultNoticeDeps
  noticeChain = Promise.resolve()
}

let timer: ReturnType<typeof setInterval> | null = null
/** Once a minute, in the server process only: apply the schedules, then announce what became available. */
export function startAgentScheduleTicker(): void {
  if (timer) return
  const tick = () => { void evaluateAgentSchedules().catch(() => {}).then(() => checkAccountAvailability()).catch(() => {}) }
  tick()
  timer = setInterval(tick, 60_000)
  timer.unref?.()
}

export function __setAgentScheduleDepsForTest(deps: { limits?: Limits; notify?: () => void } | null): void {
  limitsSource = deps?.limits ?? (async () => (await import('./plan-limits')).storedPlanLimits())
  notify = deps?.notify ?? (() => { void import('./sse').then(m => m.broadcastPlanLimitsChanged()).catch(() => {}) })
}
