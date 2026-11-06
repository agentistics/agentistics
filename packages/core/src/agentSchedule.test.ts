import { describe, expect, test } from 'bun:test'
import { foldDayUsage, parseAgentSchedule, resolveAgentUse, scheduleVerdict, toggleAgentUse, type AgentSchedule } from './agentSchedule'

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

describe('resolveAgentUse — manual wins, then returns to the schedule', () => {
  test('no schedule: plain switch, untouched', () => {
    expect(resolveAgentUse(undefined, undefined, null)).toBeNull()
    expect(resolveAgentUse({ ...sched, enabled: false }, 'on', scheduleVerdict(sched, at(2, 14), 0))).toBeNull()
  })
  test('manual on outside the schedule wins', () => {
    const v = scheduleVerdict(sched, at(2, 14), 0)
    expect(resolveAgentUse(sched, 'on', v)).toEqual({ available: true, manual: 'on', reason: 'manual-on' })
  })
  test('manual on is cleared once the schedule agrees, so the window close turns it off', () => {
    const opened = resolveAgentUse(sched, 'on', scheduleVerdict(sched, at(2, 9, 30), 0))!
    expect(opened).toEqual({ available: true, manual: undefined, reason: 'in-window' })
    expect(resolveAgentUse(sched, opened.manual, scheduleVerdict(sched, at(2, 12, 1), 0))).toMatchObject({ available: false, reason: 'outside-window' })
  })
  test('manual off inside a window wins until the window closes', () => {
    expect(resolveAgentUse(sched, 'off', scheduleVerdict(sched, at(2, 10), 0))).toMatchObject({ available: false, manual: 'off' })
    expect(resolveAgentUse(sched, 'off', scheduleVerdict(sched, at(2, 13), 0))).toMatchObject({ available: false, manual: undefined, reason: 'outside-window' })
  })
  test('manual on overrides the daily ceiling too', () => {
    expect(resolveAgentUse(sched, 'on', scheduleVerdict(sched, at(2, 10), 50))).toMatchObject({ available: true, reason: 'manual-on' })
  })
})

describe('toggleAgentUse', () => {
  test('no schedule: the plain flag', () => {
    expect(toggleAgentUse(undefined, false, null)).toEqual({ available: false, manual: undefined })
  })
  test('turning on outside a window records manual on; turning it off returns to the schedule', () => {
    const v = scheduleVerdict(sched, at(2, 14), 0)
    expect(toggleAgentUse(sched, true, v)).toEqual({ available: true, manual: 'on' })
    expect(toggleAgentUse(sched, false, v)).toEqual({ available: false, manual: undefined })
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
  test('manual ON still wins over the weekly ceiling', () => {
    const v = scheduleVerdict(w, at(2, 10), 0, 90)
    expect(resolveAgentUse(w, 'on', v)).toMatchObject({ available: true, reason: 'manual-on' })
  })
  test('parse validates and round-trips', () => {
    expect(parseAgentSchedule(w)!.maxWeeklyPct).toBe(60)
    expect(parseAgentSchedule({ ...w, maxWeeklyPct: 0 })).toBeNull()
    expect(parseAgentSchedule({ ...w, maxWeeklyPct: 101 })).toBeNull()
  })
})
