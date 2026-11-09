import { describe, expect, test } from 'bun:test'
import { buildCalendar } from '@agentistics/core'
import { answerCalendar, calendarFiltersOf } from './calendar'

describe('calendarFiltersOf', () => {
  test('no query = the default: tasks being worked on', () => {
    expect(calendarFiltersOf(new URLSearchParams(''))).toEqual({ tasks: 'active' })
  })
  test('lists, flags and BRT days', () => {
    const f = calendarFiltersOf(new URLSearchParams('task=Esteira&version=2.202.0,2.203.0&stage=qa,nonsense&priority=high&harness=codex&all=1&confirmed=1&from=2026-11-07&to=2026-11-07'))
    expect(f).toMatchObject({ tasks: 'all', task: 'Esteira', versions: ['2.202.0', '2.203.0'], stages: ['qa'], priorities: ['high'], harnesses: ['codex'], confirmedOnly: true })
    // 00:00 BRT = 03:00Z; the end of the day is the last millisecond before the next 00:00 BRT.
    expect(f.fromMs).toBe(Date.parse('2026-11-07T03:00:00.000Z'))
    expect(f.toMs).toBe(Date.parse('2026-11-08T02:59:59.999Z'))
  })
  test('an unparseable instant is dropped, not turned into NaN', () => {
    const f = calendarFiltersOf(new URLSearchParams('from=banana'))
    expect('fromMs' in f).toBe(false)
  })
})

describe('answerCalendar', () => {
  const NOW = Date.parse('2026-11-07T18:00:00.000Z')
  const reply = buildCalendar({
    nowMs: NOW,
    lives: [{
      key: 't/s', taskId: 't', taskTitle: 'Esteira', subtaskId: 's', title: 'Barra', stage: 'qa', startedAtMs: NOW - 3600_000, stageSinceMs: NOW - 1800_000,
      harnesses: ['claude'], models: ['opus'], eta: { kind: 'none' }, stageEta: { kind: 'none' }, publishEta: { kind: 'none', reason: 'no-history' }, deliveredAtMs: null,
    }],
    records: [{ subtaskId: 's', taskId: 't', phase: 'qa', versionTarget: '2.202.0' }],
    tasks: [{ id: 't', title: 'Esteira', status: 'in_progress', priority: 'high' }], subtasks: [], resets: [],
  })
  test('carries the counts and the filters it applied; a piece with no estimate keeps `kind: none`', () => {
    const a = answerCalendar(reply, { tasks: 'active' })
    expect(a.counts).toEqual({ pieces: 1, versions: 1, marks: 0 })
    expect(a.pieces[0]!.publishEta.kind).toBe('none')
    expect(a.versions[0]).toMatchObject({ version: '2.202.0', basis: 'none', atMs: null })
  })
})

describe('a leader working alone reaches the Calendar (LIVE.EM-ANDAMENTO-E-LIDER)', () => {
  test('the leader piece (task-level, running, on the leader session\'s clock) is a piece of the calendar', () => {
    const NOW = Date.parse('2026-11-09T15:00:00.000Z')
    const reply = buildCalendar({
      nowMs: NOW,
      lives: [{
        key: 't', taskId: 't', taskTitle: 'Engine', subtaskId: null, title: 'Engine', stage: 'running', startedAtMs: NOW - 600_000, stageSinceMs: NOW - 600_000,
        harnesses: ['claude'], models: ['opus'], eta: { kind: 'none' }, stageEta: { kind: 'none' }, publishEta: { kind: 'none', reason: 'no-history' }, deliveredAtMs: null,
      }],
      records: [], tasks: [{ id: 't', title: 'Engine', status: 'in_progress' }], subtasks: [], resets: [],
    })
    const a = answerCalendar(reply, { tasks: 'active' })
    expect(a.pieces.map(p => p.title)).toEqual(['Engine'])
    expect(a.pieces[0]!.publishEta.kind).toBe('none')
  })
})
