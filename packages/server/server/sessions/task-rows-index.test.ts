import { describe, expect, test } from 'bun:test'
import { rowsOfTask } from './task-report'
import { conversationOwners } from './task-conversations'
import { legacyTaskId } from './task-model'

type Row = { id: string; taskId?: string; task?: string; conversationId?: string }
const naive = (task: { id: string }, rows: Row[], owners: ReadonlyMap<string, string>) => rows.filter(r =>
  (r.taskId === task.id || (r.task !== undefined && legacyTaskId(r.task) === task.id))
  && (!r.conversationId || owners.get(r.conversationId) === task.id))

describe('rowsOfTask over the bucketed registry', () => {
  test('matches the row-by-row scan for ids, legacy names, double naming and conversations', () => {
    const rows: Row[] = []
    for (let i = 0; i < 400; i++) {
      rows.push({
        id: `r${i}`,
        ...(i % 3 === 0 ? { taskId: `t${i % 7}` } : {}),
        ...(i % 4 === 0 ? { task: `name ${i % 5}` } : {}),
        ...(i % 5 === 0 ? { conversationId: `c${i % 11}` } : {}),
      })
    }
    const ids = [...Array(7).keys()].map(n => `t${n}`).concat([...Array(5).keys()].map(n => legacyTaskId(`name ${n}`)), ['none'])
    const owners = conversationOwners(rows as never)
    for (const id of ids) {
      expect(rowsOfTask({ id }, rows as never, owners).map(r => r.id)).toEqual(naive({ id }, rows, owners).map(r => r.id))
    }
  })
  test('an array that grew is re-bucketed', () => {
    const rows: Row[] = [{ id: 'a', taskId: 't1' }]
    expect(rowsOfTask({ id: 't1' }, rows as never, new Map()).length).toBe(1)
    rows.push({ id: 'b', taskId: 't1' })
    expect(rowsOfTask({ id: 't1' }, rows as never, new Map()).length).toBe(2)
  })
})
