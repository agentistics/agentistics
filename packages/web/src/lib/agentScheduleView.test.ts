import { describe, expect, test } from 'bun:test'
import type { AgentSchedule } from '@agentistics/core'
import { addWindow, copyToSelected, dailyUsageText, removeWindow, scheduleProblem, setDailyCap, toggleDay, agentUseReasonText } from './agentScheduleView'

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
