import { describe, expect, it } from 'bun:test'
import {
  ariaSortOf, canReorderBy, compareBy, cycleSort, DEFAULT_SORT, nextSort, PRIORITY_ORDER, sortRows, sortRowsBy,
  type SortableRow,
} from './taskSort'

const row = (over: Partial<SortableRow['task']> & { id: string }, rest: Partial<SortableRow> = {}): SortableRow => ({
  task: {
    title: 't', status: 'todo', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  },
  ...rest,
})

describe('sortRows', () => {
  it('puts an unmeasurable row LAST in both directions', () => {
    // A task nobody could price is not the cheapest task.
    const rows = [
      row({ id: 'none' }, { rollup: { costUSD: null, tokens: null, rounds: null, sessionsUsed: 0 } }),
      row({ id: 'cheap' }, { rollup: { costUSD: 1, tokens: 1, rounds: 1, sessionsUsed: 1 } }),
      row({ id: 'dear' }, { rollup: { costUSD: 9, tokens: 9, rounds: 9, sessionsUsed: 1 } }),
    ]
    expect(sortRows(rows, { key: 'cost', dir: 'asc' }).map(r => r.task.id)).toEqual(['cheap', 'dear', 'none'])
    expect(sortRows(rows, { key: 'cost', dir: 'desc' }).map(r => r.task.id)).toEqual(['dear', 'cheap', 'none'])
  })

  it('orders priority most-urgent-first when ascending', () => {
    const rows = [row({ id: 'l', priority: 'low' }), row({ id: 'u', priority: 'urgent' }), row({ id: 'n' })]
    expect(sortRows(rows, { key: 'priority', dir: 'asc' }).map(r => r.task.id)).toEqual(['u', 'l', 'n'])
  })

  it('is TOTAL: equal values fall back to rank, then creation, then id', () => {
    const rows = [
      row({ id: 'b', createdAt: '2026-01-02T00:00:00.000Z' }),
      row({ id: 'a', createdAt: '2026-01-02T00:00:00.000Z' }),
      row({ id: 'c', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const once = sortRows(rows, { key: 'status', dir: 'asc' }).map(r => r.task.id)
    const twice = sortRows([...rows].reverse(), { key: 'status', dir: 'asc' }).map(r => r.task.id)
    expect(once).toEqual(['c', 'a', 'b'])
    // Same answer whatever order the input arrived in — a board that reshuffles on a re-render is
    // one people stop trusting to have shown them everything.
    expect(twice).toEqual(once)
  })

  it('manual order is the rank, and an unranked card follows the ranked ones', () => {
    const rows = [
      row({ id: 'no-rank', createdAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'second', rank: 'b' }),
      row({ id: 'first', rank: 'a' }),
    ]
    expect(sortRows(rows, DEFAULT_SORT).map(r => r.task.id)).toEqual(['first', 'second', 'no-rank'])
  })

  it('sorts titles case-insensitively', () => {
    const rows = [row({ id: 'b', title: 'beta' }), row({ id: 'a', title: 'Alpha' })]
    expect(sortRows(rows, { key: 'title', dir: 'asc' }).map(r => r.task.id)).toEqual(['a', 'b'])
  })

  it('never mutates its input', () => {
    const rows = [row({ id: 'b', title: 'b' }), row({ id: 'a', title: 'a' })]
    sortRows(rows, { key: 'title', dir: 'asc' })
    expect(rows.map(r => r.task.id)).toEqual(['b', 'a'])
  })
})

describe('compareBy', () => {
  it('reads a zero as a real value, not as absent', () => {
    const zero = row({ id: 'z' }, { rollup: { costUSD: 0, tokens: 0, rounds: 0, sessionsUsed: 0 } })
    const none = row({ id: 'n' }, { rollup: { costUSD: null, tokens: null, rounds: null, sessionsUsed: 0 } })
    expect(compareBy({ key: 'cost', dir: 'asc' }, zero, none)).toBeLessThan(0)
  })
})

describe('nextSort', () => {
  it('cycles a column none → asc → desc → the board’s own order', () => {
    const a = nextSort(DEFAULT_SORT, 'cost')
    expect(a).toEqual({ key: 'cost', dir: 'asc' })
    const b = nextSort(a, 'cost')
    expect(b).toEqual({ key: 'cost', dir: 'desc' })
    expect(nextSort(b, 'cost')).toEqual(DEFAULT_SORT)
  })

  it('starts a NEW column ascending rather than inheriting the last direction', () => {
    expect(nextSort({ key: 'cost', dir: 'desc' }, 'title')).toEqual({ key: 'title', dir: 'asc' })
  })
})

describe('status order', () => {
  const ORDER = ['todo', 'in_progress', 'done']
  const rows = [
    row({ id: 'd', status: 'done' }),
    row({ id: 'x', status: 'gone_status' }),
    row({ id: 't', status: 'todo' }),
    row({ id: 'p', status: 'in_progress' }),
  ]
  it('follows the pipeline, not the alphabet, when it is given one', () => {
    expect(sortRows(rows, { key: 'status', dir: 'asc' }, { statusOrder: ORDER }).map(r => r.task.id))
      .toEqual(['t', 'p', 'd', 'x'])
    expect(sortRows(rows, { key: 'status', dir: 'desc' }, { statusOrder: ORDER }).map(r => r.task.id))
      .toEqual(['x', 'd', 'p', 't'])
  })
  it('falls back to the raw ids without one — the old behaviour', () => {
    expect(sortRows(rows, { key: 'status', dir: 'asc' }).map(r => r.task.id))
      .toEqual(['d', 'x', 'p', 't'])
  })
})

describe('progress and delivered', () => {
  it('orders progress by the fraction closed and puts a task with no subtasks LAST both ways', () => {
    const c = (subtasks: number, subtasksDone: number) => ({ comments: 0, files: 0, subtasks, subtasksDone })
    const rows = [
      row({ id: 'none' }, { counts: c(0, 0) }),
      row({ id: 'nine' }, { counts: c(9, 1) }),
      row({ id: 'two' }, { counts: c(2, 2) }),
    ]
    expect(sortRows(rows, { key: 'progress', dir: 'asc' }).map(r => r.task.id)).toEqual(['nine', 'two', 'none'])
    expect(sortRows(rows, { key: 'progress', dir: 'desc' }).map(r => r.task.id)).toEqual(['two', 'nine', 'none'])
  })
  it('sorts by delivery date with an undelivered task last in both directions', () => {
    const rows = [
      row({ id: 'open' }),
      row({ id: 'late', deliveredAt: '2026-03-01T00:00:00.000Z' }),
      row({ id: 'early', deliveredAt: '2026-01-05T00:00:00.000Z' }),
    ]
    expect(sortRows(rows, { key: 'delivered', dir: 'asc' }).map(r => r.task.id)).toEqual(['early', 'late', 'open'])
    expect(sortRows(rows, { key: 'delivered', dir: 'desc' }).map(r => r.task.id)).toEqual(['late', 'early', 'open'])
  })
})

describe('sortRowsBy', () => {
  it('orders by the projected number and hands back the ORIGINAL rows', () => {
    const src = [
      { id: 'a', linked: 5, used: 1 },
      { id: 'b', linked: 1, used: 9 },
    ]
    const project = (r: typeof src[number]): SortableRow => ({
      task: { id: r.id, title: r.id, status: 'todo', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      rollup: { costUSD: null, tokens: null, rounds: null, sessionsUsed: r.linked },
    })
    const out = sortRowsBy(src, { key: 'sessions', dir: 'asc' }, project)
    expect(out.map(r => r.id)).toEqual(['b', 'a'])
    expect(out[0]).toBe(src[1])
  })
})

describe('cycleSort / ariaSortOf / canReorderBy', () => {
  it('cycles none → ascending → descending → none, and a different key restarts', () => {
    const a = cycleSort<'x' | 'y'>(null, 'x')
    expect(a).toEqual({ key: 'x', dir: 'asc' })
    const d = cycleSort(a, 'x')
    expect(d).toEqual({ key: 'x', dir: 'desc' })
    expect(cycleSort(d, 'x')).toBeNull()
    expect(cycleSort(d, 'y')).toEqual({ key: 'y', dir: 'asc' })
  })
  it('reports aria-sort on the one column in force and none elsewhere', () => {
    const cur = { key: 'cost' as const, dir: 'desc' as const }
    expect(ariaSortOf(cur, 'cost')).toBe('descending')
    expect(ariaSortOf({ key: 'cost', dir: 'asc' }, 'cost')).toBe('ascending')
    expect(ariaSortOf(cur, 'title' as 'cost')).toBe('none')
    expect(ariaSortOf<'cost'>(null, 'cost')).toBe('none')
  })
  it('lets a card be repositioned only under ascending hand order', () => {
    expect(canReorderBy(DEFAULT_SORT)).toBe(true)
    expect(canReorderBy({ key: 'manual', dir: 'desc' })).toBe(false)
    expect(canReorderBy({ key: 'cost', dir: 'asc' })).toBe(false)
  })
})

describe('priority sort has no unset level', () => {
  const row = (id: string, priority?: string) => ({
    task: { id, title: id, status: 'todo', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...(priority ? { priority } : {}) },
  })
  it('orders urgent > high > medium > low, with absent and legacy none ranking as low', () => {
    const out = sortRows(
      [row('a', 'low'), row('b'), row('c', 'urgent'), row('d', 'none'), row('e', 'medium'), row('f', 'high')],
      { key: 'priority', dir: 'asc' },
    ).map(r => r.task.id)
    expect(out.slice(0, 3)).toEqual(['c', 'f', 'e'])
    expect(new Set(out.slice(3))).toEqual(new Set(['a', 'b', 'd']))
  })
  it('offers exactly four choices', () => {
    expect(PRIORITY_ORDER).toEqual(['urgent', 'high', 'medium', 'low'])
  })
})
