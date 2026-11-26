import { describe, expect, test } from 'bun:test'
import { agentUseSettings, foldDayUsage, parseAgentSchedule, resolveAgentUse, scheduleVerdict, type AgentSchedule } from './agentSchedule'

// 2026-11-02 is a Monday. Local clock, like the evaluator.
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m)
const sched: AgentSchedule = {
  enabled: true,
  days: {
    mon: { windows: [{ from: '09:00', to: '12:00' }, { from: '22:00', to: '02:00' }], maxDailyPct: 20 },
    wed: { windows: [{ from: '10:00', to: '11:00' }] },
  },
}

describe('scheduleVerdict', () => {
  test('inside a window of a selected day', () => {
    expect(scheduleVerdict(sched, at(2, 10), 5)).toMatchObject({ on: true, reason: 'in-window', day: 'mon', maxDailyPct: 20 })
  })
  test('window end is exclusive, start inclusive', () => {
    expect(scheduleVerdict(sched, at(2, 9), 0).on).toBe(true)
    expect(scheduleVerdict(sched, at(2, 12), 0).on).toBe(false)
  })
  test('selected day, outside the windows', () => {
    expect(scheduleVerdict(sched, at(2, 14), 0)).toMatchObject({ on: false, reason: 'outside-window' })
  })
  test('day not selected', () => {
    expect(scheduleVerdict(sched, at(3, 10), 0)).toMatchObject({ on: false, reason: 'day-off', day: 'tue' })
  })
  test('window crossing midnight covers the next morning, under the start day rules', () => {
    expect(scheduleVerdict(sched, at(2, 23), 0)).toMatchObject({ on: true, day: 'mon' })
    expect(scheduleVerdict(sched, at(3, 1, 30), 0)).toMatchObject({ on: true, day: 'mon' })
    expect(scheduleVerdict(sched, at(3, 2), 0).on).toBe(false)
  })
  test('daily ceiling reached closes the window; unmeasurable never blocks', () => {
    expect(scheduleVerdict(sched, at(2, 10), 20)).toMatchObject({ on: false, reason: 'daily-cap' })
    expect(scheduleVerdict(sched, at(2, 10), 19.9).on).toBe(true)
    expect(scheduleVerdict(sched, at(2, 10), null).on).toBe(true)
  })
})

describe('resolveAgentUse — available = enabled && (override || schedule on)', () => {
  const inside = scheduleVerdict(sched, at(2, 10), 0)   // schedule says ON
  const outside = scheduleVerdict(sched, at(2, 14), 0)  // schedule says OFF
  test('all four switch combinations, inside and outside the window', () => {
    // enabled, no override: the schedule rules
    expect(resolveAgentUse({ enabled: true, override: false }, sched, inside)).toEqual({ available: true, reason: 'in-window' })
    expect(resolveAgentUse({ enabled: true, override: false }, sched, outside)).toEqual({ available: false, reason: 'outside-window' })
    // enabled + override: free at any hour, agenda ignored
    expect(resolveAgentUse({ enabled: true, override: true }, sched, outside)).toEqual({ available: true, reason: 'override-on' })
    expect(resolveAgentUse({ enabled: true, override: true }, sched, inside)).toEqual({ available: true, reason: 'override-on' })
    // agenda off: nothing releases it, override included
    expect(resolveAgentUse({ enabled: false, override: false }, sched, inside)).toEqual({ available: false, reason: 'agenda-off' })
    expect(resolveAgentUse({ enabled: false, override: true }, sched, inside)).toEqual({ available: false, reason: 'agenda-off' })
  })
  test('no active schedule: an enabled account is simply available', () => {
    expect(resolveAgentUse({ enabled: true, override: false }, undefined, null)).toEqual({ available: true, reason: 'no-schedule' })
    expect(resolveAgentUse({ enabled: true, override: false }, { ...sched, enabled: false }, outside)).toEqual({ available: true, reason: 'no-schedule' })
    expect(resolveAgentUse({ enabled: false, override: false }, undefined, null)).toEqual({ available: false, reason: 'agenda-off' })
  })
  test('override beats the daily and weekly ceilings, agenda-off beats the override', () => {
    expect(resolveAgentUse({ enabled: true, override: true }, sched, scheduleVerdict(sched, at(2, 10), 50))).toMatchObject({ available: true, reason: 'override-on' })
    expect(resolveAgentUse({ enabled: false, override: true }, sched, scheduleVerdict(sched, at(2, 10), 50))).toMatchObject({ available: false })
  })
  test('the override is STICKY: it does not clear itself when the schedule agrees', () => {
    const s = { enabled: true, override: true }
    expect(resolveAgentUse(s, sched, inside).reason).toBe('override-on')
    expect(resolveAgentUse(s, sched, outside).reason).toBe('override-on')
  })
})

describe('agentUseSettings — migration of records written before the two switches', () => {
  test('stored fields win', () => {
    expect(agentUseSettings({ available: false, agentUseEnabled: true, agentOverride: true, agentManual: 'off' })).toEqual({ enabled: true, override: true })
    expect(agentUseSettings({ available: true, agentUseEnabled: false })).toEqual({ enabled: false, override: false })
  })
  test("agentManual 'on' becomes an override, 'off' a disabled account", () => {
    expect(agentUseSettings({ available: true, agentManual: 'on', agentSchedule: sched })).toEqual({ enabled: true, override: true })
    expect(agentUseSettings({ available: false, agentManual: 'off', agentSchedule: sched })).toEqual({ enabled: false, override: false })
  })
  test('no manual choice: a schedule means enabled, a plain account keeps its flag', () => {
    expect(agentUseSettings({ available: false, agentSchedule: sched })).toEqual({ enabled: true, override: false })
    expect(agentUseSettings({ available: true })).toEqual({ enabled: true, override: false })
    expect(agentUseSettings({ available: false })).toEqual({ enabled: false, override: false })
  })
})

describe('the day runs 00:00-23:59 — an end of 23:59 is the end of the day, with no gap', () => {
  const late: AgentSchedule = { enabled: true, days: { mon: { windows: [{ from: '09:00', to: '23:59' }] } } }
  const whole: AgentSchedule = { enabled: true, days: { mon: { windows: [{ from: '00:00', to: '23:59' }] } } }
  test('the last minute (23:59) is inside, the next midnight is not', () => {
    expect(scheduleVerdict(late, at(2, 23, 58), 0).on).toBe(true)
    expect(scheduleVerdict(late, at(2, 23, 59), 0)).toMatchObject({ on: true, reason: 'in-window' })
    expect(scheduleVerdict(late, at(3, 0, 0), 0).on).toBe(false) // Tuesday: the window does not run past 23:59
  })
  test('00:00-23:59 covers every minute of the day', () => {
    for (const [h, m] of [[0, 0], [0, 1], [12, 0], [23, 58], [23, 59]] as const) expect(scheduleVerdict(whole, at(2, h, m), 0).on).toBe(true)
    expect(scheduleVerdict(whole, at(3, 0, 0), 0).on).toBe(false)
  })
  test('an ordinary end stays exclusive', () => {
    expect(scheduleVerdict(sched, at(2, 12, 0), 0).on).toBe(false)
  })
})

describe('foldDayUsage', () => {
  test('first reading of the day is the baseline', () => {
    const r = foldDayUsage(undefined, { usedPct: 40, resetsAt: 1 }, at(2, 8))
    expect(r.dayUsedPct).toBe(0)
    expect(r.baseline).toEqual({ day: '2026-11-02', weekPct: 40, resetsAt: 1 })
    expect(foldDayUsage(r.baseline, { usedPct: 52.5, resetsAt: 1 }, at(2, 15)).dayUsedPct).toBe(12.5)
  })
  test('a new day takes a new baseline', () => {
    const r = foldDayUsage({ day: '2026-11-01', weekPct: 10 }, { usedPct: 30 }, at(2, 0, 1))
    expect(r).toEqual({ baseline: { day: '2026-11-02', weekPct: 30 }, dayUsedPct: 0 })
  })
  test('a weekly renewal restarts the count', () => {
    const r = foldDayUsage({ day: '2026-11-02', weekPct: 90, resetsAt: 1 }, { usedPct: 3, resetsAt: 1 + 7 * 86_400_000 }, at(2, 15))
    expect(r.dayUsedPct).toBe(3)
    expect(r.baseline?.weekPct).toBe(0)
  })
  test('no weekly reading: not measurable', () => {
    expect(foldDayUsage(undefined, null, at(2, 8)).dayUsedPct).toBeNull()
  })
})

describe('parseAgentSchedule', () => {
  test('accepts a valid schedule and refuses bad input', () => {
    expect(parseAgentSchedule(sched)).toEqual(sched)
    expect(parseAgentSchedule({ enabled: true, days: { mon: { windows: [{ from: '9:00', to: '10:00' }] } } })).toBeNull()
    expect(parseAgentSchedule({ enabled: true, days: { xyz: { windows: [] } } })).toBeNull()
    expect(parseAgentSchedule({ enabled: true, days: { mon: { windows: [], maxDailyPct: 0 } } })).toBeNull()
    expect(parseAgentSchedule({ enabled: true, days: { mon: { windows: [{ from: '10:00', to: '10:00' }] } } })).toBeNull()
    expect(parseAgentSchedule('x')).toBeNull()
  })
})

describe('allDay', () => {
  const full: AgentSchedule = { enabled: true, days: { mon: { windows: [{ from: '09:00', to: '12:00' }], allDay: true, maxDailyPct: 20 }, tue: { windows: [] } } }
  test('the whole calendar day is on: 00:00, 12:00, 23:59', () => {
    for (const [h, m] of [[0, 0], [12, 0], [23, 59]] as const) expect(scheduleVerdict(full, at(2, h, m), 0)).toMatchObject({ on: true, reason: 'in-window', day: 'mon' })
  })
  test('the next day boundary: Tuesday 00:00 is not covered, and there is no tail', () => {
    expect(scheduleVerdict(full, at(3, 0, 0), 0)).toMatchObject({ on: false, day: 'tue' })
  })
  test('the daily ceiling still applies on an all-day day', () => {
    expect(scheduleVerdict(full, at(2, 12), 20)).toMatchObject({ on: false, reason: 'daily-cap' })
  })
  test('parse round-trips allDay and rejects a non-boolean', () => {
    expect(parseAgentSchedule(full)!.days.mon).toEqual({ windows: [{ from: '09:00', to: '12:00' }], maxDailyPct: 20, allDay: true })
    expect(parseAgentSchedule({ enabled: true, days: { mon: { windows: [], allDay: 'yes' } } })).toBeNull()
  })
})

describe('weekly ceiling', () => {
  const w: AgentSchedule = { enabled: true, maxWeeklyPct: 60, days: { mon: { windows: [{ from: '09:00', to: '12:00' }] } } }
  test('below / at / above', () => {
    expect(scheduleVerdict(w, at(2, 10), 0, 59.9)).toMatchObject({ on: true, maxWeeklyPct: 60 })
    expect(scheduleVerdict(w, at(2, 10), 0, 60)).toMatchObject({ on: false, reason: 'weekly-cap' })
    expect(scheduleVerdict(w, at(2, 10), 0, 80)).toMatchObject({ on: false, reason: 'weekly-cap' })
  })
  test('no weekly reading never blocks', () => {
    expect(scheduleVerdict(w, at(2, 10), null, null).on).toBe(true)
  })
  test('override still wins over the weekly ceiling', () => {
    const v = scheduleVerdict(w, at(2, 10), 0, 90)
    expect(resolveAgentUse({ enabled: true, override: true }, w, v)).toMatchObject({ available: true, reason: 'override-on' })
  })
  test('parse validates and round-trips', () => {
    expect(parseAgentSchedule(w)!.maxWeeklyPct).toBe(60)
    expect(parseAgentSchedule({ ...w, maxWeeklyPct: 0 })).toBeNull()
    expect(parseAgentSchedule({ ...w, maxWeeklyPct: 101 })).toBeNull()
  })
})
