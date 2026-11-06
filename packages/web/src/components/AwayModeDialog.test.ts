import { describe, expect, it } from 'bun:test'
import { defaultAgentSchedule } from '@agentistics/core'
import { awayDialogProblem, awayRequestOf } from './AwayModeDialog'

const sched = { ...defaultAgentSchedule(), enabled: true }

describe('autonomous-mode dialog request', () => {
  it('off sends only {on:false}', () => {
    expect(awayRequestOf(false, 'scheduled', sched, 'x')).toEqual({ on: false })
  })
  it('"until I turn it off" sends no schedule, no until and none of the removed settings', () => {
    expect(awayRequestOf(true, 'indefinite', sched, '')).toEqual({ on: true })
  })
  it('"scheduled" sends the schedule enabled; the note only when typed', () => {
    expect(awayRequestOf(true, 'scheduled', { ...sched, enabled: false }, ' focus ')).toEqual({ on: true, schedule: { ...sched, enabled: true }, note: ' focus ' })
  })
})

describe('autonomous-mode dialog problem', () => {
  it('only a scheduled, on dialog can be wrong', () => {
    expect(awayDialogProblem(true, 'indefinite', { enabled: true, days: {} }, 'en')).toBeNull()
    expect(awayDialogProblem(false, 'scheduled', { enabled: true, days: {} }, 'en')).toBeNull()
  })
  it('a schedule with no day, or a window that starts and ends together, is refused in words', () => {
    expect(awayDialogProblem(true, 'scheduled', { enabled: true, days: {} }, 'pt')).toContain('Marque')
    expect(awayDialogProblem(true, 'scheduled', { enabled: true, days: { mon: { windows: [{ from: '09:00', to: '09:00' }] } } }, 'en')).toContain('same time')
    expect(awayDialogProblem(true, 'scheduled', sched, 'en')).toBeNull()
  })
})
