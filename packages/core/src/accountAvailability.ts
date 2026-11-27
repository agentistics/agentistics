/**
 * ACCOUNT AVAILABLE → LEADER NOTICE (CONTAS.AVISO-LIDER). PURE.
 *
 * When an account goes from NOT available to AVAILABLE for agents, the live LEADER sessions are told
 * once. Availability is the EXISTING status and nothing else:
 *
 * - the account is agent-visible — its registry flag `available`, which the schedule evaluator writes
 *   from `resolveAgentUse` (Agenda off = never; override on = any hour; otherwise inside its schedule);
 * - its plan-limits row is spawnable (a login that expired or is gone is not);
 * - its plan-limits row is not on `hold` (a 5 h / weekly window that renewed lifts it).
 *
 * The state per account is persisted by the host, so a restart does not re-send.
 */
import type { AgentSchedule, AgentUseReason } from './agentSchedule'

/** A notice inside this long after the previous one for the same account is flapping: not sent. */
export const ACCOUNT_FLAP_MS = 10 * 60_000

/** What is stored per account. `since` = when the current state began; `notifiedAt` = the last notice. */
export interface AccountAvailabilityState { available: boolean; since: number; notifiedAt?: number }

export interface AvailabilityStep { next: AccountAvailabilityState; notify: boolean; changed: boolean }

/**
 * One observation. First sight records only (a boot or an upgrade does not announce every account);
 * unavailable → available notifies unless the last notice for the account is under `ACCOUNT_FLAP_MS`
 * old; going unavailable is recorded and never notified.
 */
export function stepAvailability(prev: AccountAvailabilityState | undefined, available: boolean, now: number): AvailabilityStep {
  if (!prev) return { next: { available, since: now }, notify: false, changed: true }
  if (prev.available === available) return { next: prev, notify: false, changed: false }
  const keep = prev.notifiedAt !== undefined ? { notifiedAt: prev.notifiedAt } : {}
  if (!available) return { next: { available: false, since: now, ...keep }, notify: false, changed: true }
  const flapping = prev.notifiedAt !== undefined && now - prev.notifiedAt < ACCOUNT_FLAP_MS
  if (flapping) return { next: { available: true, since: now, ...keep }, notify: false, changed: true }
  return { next: { available: true, since: now, notifiedAt: now }, notify: true, changed: true }
}

/** The plan-limits facts about one account, read as the existing status. */
export interface AccountAvailabilityFacts {
  /** In the agent-visible `budgets` (as opposed to `hiddenFromAgents`). */
  visible: boolean
  spawnable?: boolean
  status?: string
}
export const accountAvailableForAgents = (f: AccountAvailabilityFacts): boolean =>
  f.visible && f.spawnable !== false && f.status !== 'hold'

const DAY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const endMinutes = (hhmm: string) => (hhmm === '23:59' ? 1440 : minutes(hhmm))

/**
 * The end (`HH:MM`, local) of the schedule window holding `now` — the same window rule as
 * `scheduleVerdict`. An all-day day ends at `23:59`. `null` outside every window or with no active schedule.
 */
export function scheduleWindowEnd(schedule: AgentSchedule | undefined | null, now: Date): string | null {
  if (!schedule?.enabled) return null
  const minute = now.getHours() * 60 + now.getMinutes()
  const today = schedule.days[DAY_INDEX[now.getDay()]!]
  if (today?.allDay) return '23:59'
  for (const w of today?.windows ?? []) {
    const from = minutes(w.from), to = endMinutes(w.to)
    if (to > from ? minute >= from && minute < to : minute >= from) return w.to
  }
  const yesterday = schedule.days[DAY_INDEX[(now.getDay() + 6) % 7]!]
  if (!yesterday?.allDay) {
    for (const w of yesterday?.windows ?? []) {
      const from = minutes(w.from), to = endMinutes(w.to)
      if (to <= from && minute < to) return w.to
    }
  }
  return null
}

export interface AccountNoticeInput {
  /** The account's display label (nickname or "Claude Code #2"). */
  label: string
  /** The harness's display name. */
  harness: string
  plan?: string
  reason?: AgentUseReason
  /** End of the current schedule window, `HH:MM`. */
  until?: string | null
}

/** The one sentence a leader reads. */
export function accountAvailableNotice(n: AccountNoticeInput, lang: 'pt' | 'en'): string {
  const what = n.plan ? `${n.harness}, ${n.plan}` : n.harness
  const why = lang === 'pt'
    ? n.reason === 'override-on' ? 'sobrescrito ligado'
      : n.reason === 'in-window' ? (n.until ? `dentro da agenda até ${n.until}` : 'dentro da agenda')
        : n.reason === 'no-schedule' ? 'sem agenda (livre a qualquer hora)' : ''
    : n.reason === 'override-on' ? 'schedule override on'
      : n.reason === 'in-window' ? (n.until ? `inside its schedule until ${n.until}` : 'inside its schedule')
        : n.reason === 'no-schedule' ? 'no schedule (free at any hour)' : ''
  return lang === 'pt'
    ? `[agentistics · conta] A conta ${n.label} (${what}) está disponível para agentes${why ? `: ${why}` : ''}. Veja agentistics_plan_limits antes de abrir sessões.`
    : `[agentistics · account] The account ${n.label} (${what}) is available for agents${why ? `: ${why}` : ''}. Check agentistics_plan_limits before opening sessions.`
}
