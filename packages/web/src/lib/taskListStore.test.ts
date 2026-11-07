import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearTaskListStore, mergeEntry, mergeRows, peekTaskList, putTaskList, subscribeTaskList, type TaskListEntry,
} from './taskListStore'
import type { TaskListRow } from './tasks'

const row = (id: string, title = id, cost = 1) =>
  ({ task: { id, title, status: 'todo' }, cost }) as unknown as TaskListRow
const entry = (rows: TaskListRow[]): TaskListEntry => ({ rows, overview: null, excluded: 0, error: null })

beforeEach(() => clearTaskListStore())

describe('mergeRows', () => {
  test('returns the SAME array when nothing changed', () => {
    const prev = [row('a'), row('b')]
    expect(mergeRows(prev, [row('a'), row('b')])).toBe(prev)
  })
  test('keeps identity of unchanged rows, takes the changed one', () => {
    const prev = [row('a'), row('b')]
    const out = mergeRows(prev, [row('a'), row('b', 'renamed')])
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(prev[0]!)
    expect(out[1]!.task.title).toBe('renamed')
  })
  test('adds new and drops removed tasks', () => {
    const prev = [row('a'), row('b')]
    const out = mergeRows(prev, [row('b'), row('c')])
    expect(out.map(r => r.task.id)).toEqual(['b', 'c'])
    expect(out[0]).toBe(prev[1]!)
  })
})

describe('store', () => {
  test('a cache hit is readable synchronously (no loader needed)', () => {
    expect(peekTaskList('q')).toBeUndefined()
    putTaskList('q', entry([row('a')]))
    expect(peekTaskList('q')!.rows).toHaveLength(1)
  })
  test('a refresh with identical data does not notify', () => {
    putTaskList('q', entry([row('a')]))
    let n = 0
    subscribeTaskList('q', () => { n++ })
    putTaskList('q', entry([row('a')]))
    expect(n).toBe(0)
  })
  test('a refresh after a change notifies once and keeps untouched rows', () => {
    putTaskList('q', entry([row('a'), row('b')]))
    const before = peekTaskList('q')!.rows
    let n = 0
    subscribeTaskList('q', () => { n++ })
    putTaskList('q', entry([row('a'), row('b', 'x')]))
    expect(n).toBe(1)
    expect(peekTaskList('q')!.rows[0]).toBe(before[0]!)
  })
  test('lists are keyed by query', () => {
    putTaskList('q1', entry([row('a')]))
    expect(peekTaskList('q2')).toBeUndefined()
  })
  test('mergeEntry returns prev when everything is equal', () => {
    const p = entry([row('a')])
    expect(mergeEntry(p, entry([row('a')]))).toBe(p)
  })
})

describe('the split load (partial step one, then the rest)', () => {
  test('step two keeps the identity of every row step one already delivered, and clears partial', () => {
    const first = { ...entry([row('a'), row('c')]), partial: true }
    putTaskList('q', first)
    const kept = peekTaskList('q')!.rows
    expect(peekTaskList('q')!.partial).toBe(true)
    putTaskList('q', entry([row('a'), row('b'), row('c')]))
    const now = peekTaskList('q')!
    expect(now.partial).toBeUndefined()
    expect(now.rows.map(r => r.task.id)).toEqual(['a', 'b', 'c'])
    expect(now.rows[0]).toBe(kept[0]!)
    expect(now.rows[2]).toBe(kept[1]!)
  })
  test('a partial flag change alone is a change, an identical partial is not', () => {
    const p = { ...entry([row('a')]), partial: true }
    expect(mergeEntry(p, { ...entry([row('a')]), partial: true })).toBe(p)
    expect(mergeEntry(p, entry([row('a')]))).not.toBe(p)
  })
})
