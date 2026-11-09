import { describe, expect, test } from 'bun:test'
import type { AgentSchedule } from '@agentistics/core'
import { addWindow, copyToSelected, dailyUsageText, removeWindow, scheduleProblem, setDailyCap, toggleDay, agentUseReasonText, setAllDay, setWeeklyCap, dayWindowsText, dayReadingHint, weekReadingHint } from './agentScheduleView'

const base: AgentSchedule = { enabled: true, days: { mon: { windows: [{ from: '09:00', to: '12:00' }], maxDailyPct: 20 } } }

describe('agent schedule draft edits', () => {
  test('selecting a day copies the template day; unselecting removes it', () => {
    const s = toggleDay(base, 'tue', 'mon')
    expect(s.days.tue).toEqual({ windows: [{ from: '09:00', to: '12:00' }], maxDailyPct: 20 })
    expect(toggleDay(s, 'tue').days.tue).toBeUndefined()
    expect(toggleDay(base, 'wed').days.wed).toEqual({ windows: [{ from: '09:00', to: '18:00' }] })
  })
  test('add/remove a window and set the ceiling', () => {
    const s = addWindow(base, 'mon')
    expect(s.days.mon!.windows).toEqual([{ from: '09:00', to: '12:00' }, { from: '12:00', to: '23:00' }])
    expect(removeWindow(s, 'mon', 0).days.mon!.windows).toEqual([{ from: '12:00', to: '23:00' }])
    expect(setDailyCap(base, 'mon', undefined).days.mon).toEqual({ windows: [{ from: '09:00', to: '12:00' }] })
  })
  test('copy to the selected days only', () => {
    const s = copyToSelected({ ...base, days: { ...base.days, fri: { windows: [] } } }, 'mon')
    expect(s.days.fri).toEqual(base.days.mon)
    expect(s.days.tue).toBeUndefined()
  })
  test('problems are said in words', () => {
    expect(scheduleProblem(base, 'pt')).toBeNull()
    expect(scheduleProblem({ enabled: true, days: { mon: { windows: [{ from: '10:00', to: '10:00' }] } } }, 'pt')).toContain('seg')
    expect(scheduleProblem({ enabled: true, days: { mon: { windows: [], maxDailyPct: 0 } } }, 'en')).toContain('ceiling')
  })
  test('daily usage line', () => {
    expect(dailyUsageText({ reason: 'in-window', on: true, dayUsedPct: 12.34, maxDailyPct: 20 }, 'pt')).toBe('hoje: 12.3% de 20% permitido')
    expect(dailyUsageText({ reason: 'in-window', on: true, dayUsedPct: 3 }, 'pt')).toBeNull()
    expect(agentUseReasonText('outside-window', 'en')).toContain('off for agents')
  })
})

describe('all day and weekly ceiling (view)', () => {
  test('allDay on keeps the windows; off restores them (09:00–18:00 when none)', () => {
    const on = setAllDay(base, 'mon', true)
    expect(on.days.mon).toEqual({ windows: [{ from: '09:00', to: '12:00' }], maxDailyPct: 20, allDay: true })
    expect(setAllDay(on, 'mon', false).days.mon).toEqual(base.days.mon)
    const empty: AgentSchedule = { enabled: true, days: { mon: { windows: [], allDay: true } } }
    expect(setAllDay(empty, 'mon', false).days.mon!.windows).toEqual([{ from: '09:00', to: '18:00' }])
  })
  test('copy and day-select carry the all-day state', () => {
    const s = toggleDay(toggleDay(setAllDay(base, 'mon', true), 'tue', 'mon'), 'wed', 'mon')
    expect(s.days.tue!.allDay).toBe(true)
    expect(copyToSelected(setAllDay(toggleDay(base, 'tue', 'mon'), 'mon', true), 'mon').days.tue!.allDay).toBe(true)
  })
  test('incomplete times do not block an all-day day', () => {
    const s: AgentSchedule = { enabled: true, days: { mon: { windows: [{ from: '', to: '' }], allDay: true } } }
    expect(scheduleProblem(s, 'en')).toBeNull()
  })
  test('summary says "dia inteiro", not 00:00–24:00', () => {
    expect(dayWindowsText({ windows: [], allDay: true }, 'pt')).toBe('dia inteiro')
    expect(dayWindowsText({ windows: [{ from: '09:00', to: '18:00' }] }, 'en')).toBe('09:00–18:00')
  })
  test('weekly cap edit, hints and reason', () => {
    expect(setWeeklyCap(base, 70).maxWeeklyPct).toBe(70)
    expect('maxWeeklyPct' in setWeeklyCap(setWeeklyCap(base, 70), undefined)).toBe(false)
    expect(scheduleProblem({ ...base, maxWeeklyPct: 120 }, 'en')).toContain('Weekly')
    const v = { reason: 'weekly-cap' as const, on: false, dayUsedPct: 4, weekUsedPct: 30, maxWeeklyPct: 30 }
    expect(dayReadingHint(v, 'pt')).toBe('hoje já foram 4% · semana em 30%')
    expect(weekReadingHint({ ...v, weekUsedPct: null }, 'pt')).toContain('sem leitura')
    expect(agentUseReasonText('weekly-cap', 'pt')).toBe('Teto da semana atingido — desligada para agentes')
  })
})
