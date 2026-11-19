/**
 * AGENT SCHEDULE — when an account may be used by AGENTS (CONTAS.AGENDA-AGENTICA). PURE.
 *
 * An account carries ONE flag the router, the spawn rules and `agentistics_plan_limits` read:
 * `available`. This module never adds a second one; it decides what that flag SHOULD say:
 *
 * - `schedule` (optional, per account): the weekdays it may work, the hour windows of each day, and
 *   a daily ceiling expressed as a percentage of the WEEKLY quota spent since 00:00 local time.
 * - two stored switches (`AgentUseSettings`): `enabled` (Agenda, the master) and `override` (sticky,
 *   ignores the schedule). `available = enabled && (override || schedule says on)`.
 * - No schedule (or a disabled one): an enabled account is simply available.
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
  /** The whole day is one window (00:00 → end of day). `windows` is kept untouched so turning it off restores them. */
  allDay?: boolean
}
export interface AgentSchedule {
  enabled: boolean
  /** Stop agents when ABSOLUTE weekly usage reaches this percentage. Absent = no weekly ceiling. */
  maxWeeklyPct?: number
  /** A day absent from the map is a day the account does not work for agents. */
  days: Partial<Record<AgentDay, AgentDaySchedule>>
}
export type AgentManual = 'on' | 'off'

export type AgentUseReason =
  | 'no-schedule'     // enabled, with no active schedule: always available
  | 'override-on'     // "Sobrescrever a agenda" is on: free at any hour
  | 'agenda-off'      // the Agenda switch is off: agents do not use the account at all
  | 'in-window'       // the schedule has it on now
  | 'outside-window'  // a scheduled day, but not inside one of its windows
  | 'day-off'         // the day is not selected
  | 'daily-cap'       // inside a window, but today's ceiling is spent
  | 'weekly-cap'      // the week has reached the weekly ceiling: off whatever the day says

export interface AgentScheduleVerdict {
  on: boolean
  reason: Exclude<AgentUseReason, 'no-schedule' | 'override-on' | 'agenda-off'>
  /** The day whose rules decided (a window crossing midnight belongs to the day it started on). */
  day: AgentDay
  /** The ceiling in force for that day, if any. */
  maxDailyPct?: number
  /** The weekly ceiling in force, if any. */
  maxWeeklyPct?: number
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
export const isHHMM = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v)
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
/** The END of a window: "23:59" means until the end of the day (1440), so the last minute has no gap. The day runs 00:00-23:59; there is no "24:00". */
const endMinutesOf = (hhmm: string): number => (hhmm === '23:59' ? 1440 : minutesOf(hhmm))

/** Validate and normalise untrusted input; `null` when it is not a schedule at all. */
export function parseAgentSchedule(raw: unknown): AgentSchedule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as { enabled?: unknown; days?: unknown; maxWeeklyPct?: unknown }
  if (typeof r.enabled !== 'boolean') return null
  let maxWeeklyPct: number | undefined
  if (r.maxWeeklyPct !== undefined && r.maxWeeklyPct !== null) {
    if (typeof r.maxWeeklyPct !== 'number' || !Number.isFinite(r.maxWeeklyPct) || r.maxWeeklyPct <= 0 || r.maxWeeklyPct > 100) return null
    maxWeeklyPct = Math.round(r.maxWeeklyPct * 10) / 10
  }
  const days: Partial<Record<AgentDay, AgentDaySchedule>> = {}
  if (r.days !== undefined) {
    if (!r.days || typeof r.days !== 'object' || Array.isArray(r.days)) return null
    for (const [key, value] of Object.entries(r.days as Record<string, unknown>)) {
      if (!AGENT_DAYS.includes(key as AgentDay)) return null
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const v = value as { windows?: unknown; maxDailyPct?: unknown; allDay?: unknown }
      if (v.allDay !== undefined && typeof v.allDay !== 'boolean') return null
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
      days[key as AgentDay] = { windows, ...(maxDailyPct !== undefined ? { maxDailyPct } : {}), ...(v.allDay === true ? { allDay: true } : {}) }
    }
  }
  return { enabled: r.enabled, ...(maxWeeklyPct !== undefined ? { maxWeeklyPct } : {}), days }
}

/** True when the schedule decides anything at all. */
export const scheduleActive = (s: AgentSchedule | undefined | null): s is AgentSchedule => !!s && s.enabled

/**
 * What the schedule says at `now` (local clock). `dayUsedPct` is the weekly quota spent since 00:00
 * local; `null` = not measurable (no weekly reading), which never blocks — a ceiling nobody can
 * measure is not a ceiling that was reached.
 */
export function scheduleVerdict(schedule: AgentSchedule, now: Date, dayUsedPct: number | null, weekUsedPct: number | null = null): AgentScheduleVerdict {
  const today = DAY_OF_INDEX[now.getDay()]!
  const yesterday = DAY_OF_INDEX[(now.getDay() + 6) % 7]!
  const minute = now.getHours() * 60 + now.getMinutes()
  const inToday = (w: AgentWindow) => {
    const from = minutesOf(w.from), to = endMinutesOf(w.to)
    return to > from ? minute >= from && minute < to : minute >= from
  }
  // The tail of yesterday's window that crossed midnight.
  const inYesterdayTail = (w: AgentWindow) => {
    const from = minutesOf(w.from), to = endMinutesOf(w.to)
    return to <= from && minute < to
  }
  const weekCap = schedule.maxWeeklyPct
  const withWeek = <T extends AgentScheduleVerdict>(v: T): T => (weekCap !== undefined ? { ...v, maxWeeklyPct: weekCap } : v)
  const decide = (day: AgentDay): AgentScheduleVerdict => {
    const cap = schedule.days[day]?.maxDailyPct
    if (cap !== undefined && dayUsedPct !== null && dayUsedPct >= cap) return { on: false, reason: 'daily-cap', day, maxDailyPct: cap }
    return { on: true, reason: 'in-window', day, ...(cap !== undefined ? { maxDailyPct: cap } : {}) }
  }
  const t = schedule.days[today]
  // A weekly ceiling no reading can measure never blocks (like the daily one).
  if (weekCap !== undefined && weekUsedPct !== null && weekUsedPct >= weekCap) {
    return withWeek({ on: false, reason: 'weekly-cap', day: today, ...(t?.maxDailyPct !== undefined ? { maxDailyPct: t.maxDailyPct } : {}) })
  }
  // An all-day day is the whole of its calendar day; it has no tail into the next one.
  if (t?.allDay || t?.windows.some(inToday)) return withWeek(decide(today))
  const yd = schedule.days[yesterday]
  if (!yd?.allDay && yd?.windows.some(inYesterdayTail)) return withWeek(decide(yesterday))
  const cap = t?.maxDailyPct
  return withWeek({ on: false, reason: t ? 'outside-window' : 'day-off', day: today, ...(cap !== undefined ? { maxDailyPct: cap } : {}) })
}

/**
 * The two switches a person sees (CONTAS.AGENDA-SALVAR), both STORED:
 * - `enabled` ("Agenda"): the master — may agents use this account at all.
 * - `override` ("Sobrescrever a agenda"): STICKY — while on, the account is free at any hour and the
 *   schedule is ignored (kept, not erased). It replaces the old self-clearing `agentManual`.
 */
export interface AgentUseSettings { enabled: boolean; override: boolean }

/**
 * The settings of an account, migrating records written before the two switches existed: a stored
 * `agentUseEnabled` wins; otherwise `agentManual: 'on'` becomes an override, `'off'` a disabled
 * account, and with no manual choice an active schedule means enabled while a plain account keeps
 * what its `available` flag said.
 */
export function agentUseSettings(a: {
  available: boolean; agentUseEnabled?: boolean; agentOverride?: boolean; agentManual?: AgentManual; agentSchedule?: AgentSchedule | null
}): AgentUseSettings {
  if (typeof a.agentUseEnabled === 'boolean') return { enabled: a.agentUseEnabled, override: a.agentOverride === true }
  if (a.agentManual === 'on') return { enabled: true, override: true }
  if (a.agentManual === 'off') return { enabled: false, override: false }
  return { enabled: scheduleActive(a.agentSchedule) ? true : a.available !== false, override: a.agentOverride === true }
}

export interface AgentUseState {
  /** What `available` must say. */
  available: boolean
  reason: AgentUseReason
}

/**
 * THE rule: `available = enabled && (override || schedule says on)`. A schedule that is absent or
 * switched off never blocks (the plain account), a verdict is only needed when one is active.
 */
export function resolveAgentUse(
  settings: AgentUseSettings, schedule: AgentSchedule | undefined | null, verdict: AgentScheduleVerdict | null,
): AgentUseState {
  if (!settings.enabled) return { available: false, reason: 'agenda-off' }
  if (settings.override) return { available: true, reason: 'override-on' }
  if (!scheduleActive(schedule) || !verdict) return { available: true, reason: 'no-schedule' }
  return { available: verdict.on, reason: verdict.reason }
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

/** Short weekday names, both languages — shared by every schedule summary (account agenda and autonomous mode). */
export const DAY_SHORT: Record<AgentDay, { pt: string; en: string }> = {
  mon: { pt: 'seg', en: 'Mon' }, tue: { pt: 'ter', en: 'Tue' }, wed: { pt: 'qua', en: 'Wed' }, thu: { pt: 'qui', en: 'Thu' },
  fri: { pt: 'sex', en: 'Fri' }, sat: { pt: 'sáb', en: 'Sat' }, sun: { pt: 'dom', en: 'Sun' },
}

/** Summary of a day's hours for plan popups and agenda lines: "dia inteiro" instead of 00:00–24:00. */
export function dayWindowsText(day: { windows: readonly AgentWindow[]; allDay?: boolean }, lang: 'pt' | 'en'): string {
  if (day.allDay) return lang === 'pt' ? 'dia inteiro' : 'all day'
  return day.windows.map(w => `${w.from}–${w.to}`).join(', ')
}

/** One line for a whole schedule: "seg, ter: dia inteiro · qua: 09:00–18:00". Empty when no day is set. */
export function scheduleSummaryText(schedule: { days: Partial<Record<AgentDay, { windows: readonly AgentWindow[]; allDay?: boolean }>> } | undefined, lang: 'pt' | 'en'): string {
  if (!schedule) return ''
  const groups = new Map<string, AgentDay[]>()
  for (const d of Object.keys(DAY_SHORT) as AgentDay[]) {
    const day = schedule.days[d]
    if (!day) continue
    const t = dayWindowsText(day, lang)
    groups.set(t, [...(groups.get(t) ?? []), d])
  }
  return [...groups].map(([t, ds]) => `${ds.map(d => DAY_SHORT[d][lang]).join(', ')}: ${t || (lang === 'pt' ? 'sem janela' : 'no window')}`).join(' · ')
}

/** True when at least one selected day can ever be ON (all day, or a window). A schedule that cannot is a mistake, not a choice. */
export function scheduleCanBeOn(s: AgentSchedule): boolean {
  return Object.values(s.days).some(d => !!d && (d.allDay === true || d.windows.length > 0))
}
