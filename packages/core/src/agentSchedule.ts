/**
 * AGENT SCHEDULE — when an account may be used by AGENTS (CONTAS.AGENDA-AGENTICA). PURE.
 *
 * An account carries ONE flag the router, the spawn rules and `agentistics_plan_limits` read:
 * `available`. This module never adds a second one; it decides what that flag SHOULD say:
 *
 * - `schedule` (optional, per account): the weekdays it may work, the hour windows of each day, and
 *   a daily ceiling expressed as a percentage of the WEEKLY quota spent since 00:00 local time.
 * - `manual` (optional): a person flipped the switch against the schedule. The manual choice wins
 *   until the schedule itself reaches the same answer — then it is cleared and the schedule rules
 *   again ("turning it off returns to what the schedule says"). So a manual ON outside a window
 *   lasts until the next window opens AND closes; a manual OFF inside a window lasts until it closes.
 * - No schedule (or a disabled one): `available` is the plain manual switch, exactly as before.
 *
 * Times are the MACHINE's local clock — the windows are the person's working hours.
 */

export type AgentDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
/** Display order (Monday first). */
export const AGENT_DAYS: readonly AgentDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
/** `Date#getDay()` index (0 = Sunday) → day id. */
const DAY_OF_INDEX: readonly AgentDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** `to <= from` means the window crosses midnight into the next day (22:00–02:00). */
export interface AgentWindow { from: string; to: string }
export interface AgentDaySchedule {
  windows: AgentWindow[]
  /** Ceiling for the day: percentage points of the WEEKLY quota spent since 00:00 local. Absent = no ceiling. */
  maxDailyPct?: number
}
export interface AgentSchedule {
  enabled: boolean
  /** A day absent from the map is a day the account does not work for agents. */
  days: Partial<Record<AgentDay, AgentDaySchedule>>
}
export type AgentManual = 'on' | 'off'

export type AgentUseReason =
  | 'no-schedule'     // no active schedule: the plain manual switch
  | 'manual-on'       // turned on by hand against the schedule
  | 'manual-off'      // turned off by hand against the schedule
  | 'in-window'       // the schedule has it on now
  | 'outside-window'  // a scheduled day, but not inside one of its windows
  | 'day-off'         // the day is not selected
  | 'daily-cap'       // inside a window, but today's ceiling is spent

export interface AgentScheduleVerdict {
  on: boolean
  reason: Exclude<AgentUseReason, 'no-schedule' | 'manual-on' | 'manual-off'>
  /** The day whose rules decided (a window crossing midnight belongs to the day it started on). */
  day: AgentDay
  /** The ceiling in force for that day, if any. */
  maxDailyPct?: number
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
export const isHHMM = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v)
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** Validate and normalise untrusted input; `null` when it is not a schedule at all. */
export function parseAgentSchedule(raw: unknown): AgentSchedule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as { enabled?: unknown; days?: unknown }
  if (typeof r.enabled !== 'boolean') return null
  const days: Partial<Record<AgentDay, AgentDaySchedule>> = {}
  if (r.days !== undefined) {
    if (!r.days || typeof r.days !== 'object' || Array.isArray(r.days)) return null
    for (const [key, value] of Object.entries(r.days as Record<string, unknown>)) {
      if (!AGENT_DAYS.includes(key as AgentDay)) return null
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const v = value as { windows?: unknown; maxDailyPct?: unknown }
      if (!Array.isArray(v.windows) || v.windows.length > 12) return null
      const windows: AgentWindow[] = []
      for (const w of v.windows) {
        if (!w || typeof w !== 'object' || !isHHMM((w as AgentWindow).from) || !isHHMM((w as AgentWindow).to)) return null
        if ((w as AgentWindow).from === (w as AgentWindow).to) return null
        windows.push({ from: (w as AgentWindow).from, to: (w as AgentWindow).to })
      }
      let maxDailyPct: number | undefined
      if (v.maxDailyPct !== undefined && v.maxDailyPct !== null) {
        if (typeof v.maxDailyPct !== 'number' || !Number.isFinite(v.maxDailyPct) || v.maxDailyPct <= 0 || v.maxDailyPct > 100) return null
        maxDailyPct = Math.round(v.maxDailyPct * 10) / 10
      }
      days[key as AgentDay] = { windows, ...(maxDailyPct !== undefined ? { maxDailyPct } : {}) }
    }
  }
  return { enabled: r.enabled, days }
}

/** True when the schedule decides anything at all. */
export const scheduleActive = (s: AgentSchedule | undefined | null): s is AgentSchedule => !!s && s.enabled

/**
 * What the schedule says at `now` (local clock). `dayUsedPct` is the weekly quota spent since 00:00
 * local; `null` = not measurable (no weekly reading), which never blocks — a ceiling nobody can
 * measure is not a ceiling that was reached.
 */
export function scheduleVerdict(schedule: AgentSchedule, now: Date, dayUsedPct: number | null): AgentScheduleVerdict {
  const today = DAY_OF_INDEX[now.getDay()]!
  const yesterday = DAY_OF_INDEX[(now.getDay() + 6) % 7]!
  const minute = now.getHours() * 60 + now.getMinutes()
  const inToday = (w: AgentWindow) => {
    const from = minutesOf(w.from), to = minutesOf(w.to)
    return to > from ? minute >= from && minute < to : minute >= from
  }
  // The tail of yesterday's window that crossed midnight.
  const inYesterdayTail = (w: AgentWindow) => {
    const from = minutesOf(w.from), to = minutesOf(w.to)
    return to <= from && minute < to
  }
  const decide = (day: AgentDay): AgentScheduleVerdict => {
    const cap = schedule.days[day]?.maxDailyPct
    if (cap !== undefined && dayUsedPct !== null && dayUsedPct >= cap) return { on: false, reason: 'daily-cap', day, maxDailyPct: cap }
    return { on: true, reason: 'in-window', day, ...(cap !== undefined ? { maxDailyPct: cap } : {}) }
  }
  const t = schedule.days[today]
  if (t?.windows.some(inToday)) return decide(today)
  if (schedule.days[yesterday]?.windows.some(inYesterdayTail)) return decide(yesterday)
  const cap = t?.maxDailyPct
  return { on: false, reason: t ? 'outside-window' : 'day-off', day: today, ...(cap !== undefined ? { maxDailyPct: cap } : {}) }
}

export interface AgentUseState {
  /** What `available` must say. */
  available: boolean
  /** The manual override after this evaluation (cleared once the schedule agrees with it). */
  manual: AgentManual | undefined
  reason: AgentUseReason
}

/**
 * Combine the schedule's verdict with the manual override. Returns `null` when no schedule is
 * active: `available` is then the plain switch and must not be touched.
 */
export function resolveAgentUse(
  schedule: AgentSchedule | undefined | null, manual: AgentManual | undefined, verdict: AgentScheduleVerdict | null,
): AgentUseState | null {
  if (!scheduleActive(schedule) || !verdict) return null
  const kept = manual && (manual === 'on') !== verdict.on ? manual : undefined
  if (kept) return { available: kept === 'on', manual: kept, reason: kept === 'on' ? 'manual-on' : 'manual-off' }
  return { available: verdict.on, manual: undefined, reason: verdict.reason }
}

/**
 * A person flipped the switch to `desired`. With no active schedule it is the plain flag. With one,
 * agreeing with the schedule clears the override (back to the schedule); disagreeing records it.
 */
export function toggleAgentUse(
  schedule: AgentSchedule | undefined | null, desired: boolean, verdict: AgentScheduleVerdict | null,
): { available: boolean; manual: AgentManual | undefined } {
  if (!scheduleActive(schedule) || !verdict) return { available: desired, manual: undefined }
  return { available: desired, manual: desired === verdict.on ? undefined : desired ? 'on' : 'off' }
}

/** The local calendar day `YYYY-MM-DD` of `now` (machine clock). */
export function localDayKey(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** The weekly reading the day's spend is measured against, taken at the first evaluation of the day. */
export interface AgentDayBaseline { day: string; weekPct: number; resetsAt?: number }

/**
 * How much of the weekly quota was spent today. `weekPct`/`resetsAt` = the account's current
 * weekly window (the largest when a harness reports several scopes); `null` = no weekly reading.
 * Returns the baseline to keep. A weekly window that RENEWED since the baseline (a different
 * `resetsAt`, or a reading below the baseline) restarts the count from zero.
 */
export function foldDayUsage(
  prev: AgentDayBaseline | undefined, week: { usedPct: number; resetsAt?: number } | null, now: Date,
): { baseline: AgentDayBaseline | undefined; dayUsedPct: number | null } {
  if (!week) return { baseline: prev, dayUsedPct: null }
  const day = localDayKey(now)
  const fresh = (weekPct: number): AgentDayBaseline => ({ day, weekPct, ...(week.resetsAt !== undefined ? { resetsAt: week.resetsAt } : {}) })
  if (!prev || prev.day !== day) return { baseline: fresh(week.usedPct), dayUsedPct: 0 }
  const renewed = (prev.resetsAt !== undefined && week.resetsAt !== undefined && Math.abs(week.resetsAt - prev.resetsAt) > 60 * 60_000)
    || week.usedPct < prev.weekPct
  if (renewed) return { baseline: fresh(0), dayUsedPct: week.usedPct }
  return { baseline: prev, dayUsedPct: Math.max(0, week.usedPct - prev.weekPct) }
}

/** A sensible starting schedule for the editor: weekdays 09:00–18:00, no ceiling, disabled. */
export function defaultAgentSchedule(): AgentSchedule {
  const day = (): AgentDaySchedule => ({ windows: [{ from: '09:00', to: '18:00' }] })
  return { enabled: false, days: { mon: day(), tue: day(), wed: day(), thu: day(), fri: day() } }
}
