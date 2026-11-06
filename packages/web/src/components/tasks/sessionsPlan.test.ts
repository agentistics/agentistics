import { describe, expect, test } from 'bun:test'
import type { TaskSessionRow } from '../../lib/tasks'
import { dotRows, planGroups, summarize, toPlanRows } from './sessionsPlan'

const R = (id: string, subtaskId: string | null, over: Partial<TaskSessionRow> = {}): TaskSessionRow => ({
  id, harness: 'claude', cwd: '/x/y', attemptId: null, subtaskId, createdAt: `2026-11-0${id.length}T00:00:00Z`,
  model: null, tokens: null, costUSD: 1, rounds: 1, ...over,
})
const states: Record<string, string> = { a: 'working', b: 'waiting-approval', l: 'working' }
const rows = toPlanRows(
  [R('a', 's1'), R('b', 's1'), R('c', 's1', { costUSD: null }), R('l', null), R('old', null)],
  id => states[id],
  r => r.id === 'l',
)
const titles = { leaders: 'Leaders', none: 'No subtask' }

describe('sessionsPlan', () => {
  test('alive comes from the fleet only; unknown rows are not alive', () => {
    expect(rows.map(r => r.alive)).toEqual([true, true, false, true, false])
  })
  test('groups: leaders, subtask, and the legacy "no subtask" group (kept, not dropped)', () => {
    const g = planGroups({ rows, subtasks: [{ id: 's1', title: 'S1' }], filter: 'all', query: '', titles })
    expect(g.map(x => x.key)).toEqual(['leaders', 's1', 'none'])
    expect(g[2]!.rows.map(r => r.row.id)).toEqual(['old'])
  })
  test('filter alive hides ended and drops empty groups; ended shows the rest', () => {
    const alive = planGroups({ rows, subtasks: [{ id: 's1', title: 'S1' }], filter: 'alive', query: '', titles })
    expect(alive.map(x => x.key)).toEqual(['leaders', 's1'])
    expect(alive[1]!.rows.map(r => r.row.id)).toEqual(['a', 'b'])
    const ended = planGroups({ rows, subtasks: [{ id: 's1', title: 'S1' }], filter: 'ended', query: '', titles })
    expect(ended.map(x => x.key)).toEqual(['s1', 'none'])
  })
  test('summary counts the whole group even when the filter hides rows; cost null when unpriced', () => {
    const g = planGroups({ rows, subtasks: [{ id: 's1', title: 'S1' }], filter: 'alive', query: '', titles })
    expect(g[1]!.summary).toEqual({ alive: 2, ended: 1, costUSD: 2 })
    expect(summarize(toPlanRows([R('z', null, { costUSD: null })], () => undefined, () => false)).costUSD).toBeNull()
  })
  test('search matches label, id, harness', () => {
    const g = planGroups({ rows, subtasks: [{ id: 's1', title: 'S1' }], filter: 'all', query: 'OLD', titles })
    expect(g.map(x => x.rows.map(r => r.row.id))).toEqual([['old']])
  })
  test('dots cap', () => {
    const many = toPlanRows(Array.from({ length: 7 }, (_, i) => R(`m${i}`, 's')), () => 'working', () => false)
    expect(dotRows(many)).toMatchObject({ more: 3 })
  })
})
