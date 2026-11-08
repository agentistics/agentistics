import { describe, expect, test } from 'bun:test'
import { closedStatusesLast, planPartial, rowsForPlan } from './partialPlan'
import type { TaskListRow } from '../../lib/tasks'

const ORDER = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'abandoned']
const base = { partial: true, view: 'table', groupBy: 'status', lanes: 'none', statusOrder: ORDER }
const row = (id: string, status: string) => ({ task: { id, status } }) as unknown as TaskListRow

describe('planPartial', () => {
  test('a complete list is drawn as is, in every view', () => {
    for (const view of ['table', 'board', 'overview', 'live']) expect(planPartial({ ...base, view, partial: false })).toBe('full')
  })
  test('the table grouped by status trims the closed rows (closed bands last)', () => {
    expect(planPartial(base)).toBe('trim-closed')
  })
  test('the table grouped by TYPE is held: closed rows would interleave into every band', () => {
    expect(planPartial({ ...base, groupBy: 'type' })).toBe('hold')
  })
  test('a status order with a closed band before an open one is held', () => {
    expect(planPartial({ ...base, statusOrder: ['todo', 'done', 'in_progress'] })).toBe('hold')
  })
  test('the kanban trims without lanes and is held with them', () => {
    expect(planPartial({ ...base, view: 'board' })).toBe('trim-closed')
    expect(planPartial({ ...base, view: 'board', lanes: 'priority' })).toBe('hold')
  })
  test('overview and live read no rows from the list', () => {
    expect(planPartial({ ...base, view: 'overview' })).toBe('full')
    expect(planPartial({ ...base, view: 'live' })).toBe('full')
  })
})

describe('closedStatusesLast / rowsForPlan', () => {
  test('closedStatusesLast', () => {
    expect(closedStatusesLast(ORDER)).toBe(true)
    expect(closedStatusesLast(['done', 'todo'])).toBe(false)
  })
  const rows = [row('a', 'todo'), row('b', 'done'), row('c', 'abandoned'), row('d', 'in_progress')]
  test('trim-closed drops done/abandoned only; hold yields null; full is identity', () => {
    expect(rowsForPlan(rows, 'trim-closed')!.map(r => r.task.id)).toEqual(['a', 'd'])
    expect(rowsForPlan(rows, 'hold')).toBeNull()
    expect(rowsForPlan(rows, 'full')).toBe(rows)
    expect(rowsForPlan(null, 'trim-closed')).toBeNull()
  })
})
