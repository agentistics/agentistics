import { expect, test } from 'bun:test'
import { buildCalendar } from './deliveryCalendar'

// LIVE.STATUS-IGNORADO: the calendar counts a delivery record's phase only while the board still agrees with it.
const NOW = Date.parse('2026-11-13T15:00:00.000Z')
const base = (subStatus: string | undefined, phase = 'revisao_lider') => ({
  nowMs: NOW, resets: [], lives: [],
  tasks: [{ id: 't1', title: 'Parent', status: 'in_progress' }],
  subtasks: [{ id: 'a', taskId: 't1', title: 'A', dueDate: '2026-11-01', ...(subStatus ? { status: subStatus } : {}) }],
  records: [{ subtaskId: 'a', taskId: 't1', phase, firstAt: '2026-11-01T10:00:00.000Z', lastAt: '2026-11-02T10:00:00.000Z' }],
})

test('abandoned subtask with a leader-phase record is not a piece at all (never late)', () => {
  const r = buildCalendar(base('abandoned') as never)
  expect(r.pieces.find(p => p.subtaskId === 'a')).toBeUndefined()
})

test('a done subtask with an unpublished leader-phase record is not an open or late piece', () => {
  const r = buildCalendar(base('done') as never)
  expect(r.pieces.filter(p => p.subtaskId === 'a' && (p.active || p.late))).toHaveLength(0)
})

test('an in_progress rework is not a leader-review piece from a stale record', () => {
  const r = buildCalendar(base('in_progress') as never)
  expect(r.pieces.find(p => p.subtaskId === 'a' && p.stage === 'leader')).toBeUndefined()
})

test('control: a real in_review subtask keeps its leader-review piece', () => {
  const r = buildCalendar(base('in_review') as never)
  expect(r.pieces.find(p => p.subtaskId === 'a')?.stage).toBe('leader')
})

test('a live piece in the completed stage is neither active nor late', () => {
  const r = buildCalendar({
    ...base('done'), records: [],
    lives: [{ key: 't1/a', taskId: 't1', taskTitle: 'Parent', subtaskId: 'a', title: 'A', stage: 'completed', startedAtMs: NOW - 9e8, stageSinceMs: NOW - 8e8,
      harnesses: [], models: [], eta: { kind: 'none', reason: 'final' }, stageEta: { kind: 'none', reason: 'final' }, publishEta: { kind: 'none', reason: 'final' }, deliveredAtMs: null }],
  } as never)
  expect(r.pieces[0]).toMatchObject({ active: false, late: false })
})
