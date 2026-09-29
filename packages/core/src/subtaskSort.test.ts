import { describe, expect, it } from 'bun:test'
import { sortSubtasks, type SortableSubtask, type SubtaskMeasure } from './subtaskSort'

const sub = (id: string, over: Partial<SortableSubtask> = {}): SortableSubtask => ({
  id, title: id, status: 'todo', ...over,
})
const ids = (l: readonly SortableSubtask[]) => l.map(s => s.id)

describe('sortSubtasks', () => {
  it('returns the list as it came for no sort, and never mutates its input', () => {
    const list = [sub('b', { title: 'b' }), sub('a', { title: 'a' })]
    expect(ids(sortSubtasks(list, null))).toEqual(['b', 'a'])
    sortSubtasks(list, { key: 'title', dir: 'asc' })
    expect(ids(list)).toEqual(['b', 'a'])
  })

  it('sorts titles case-insensitively in both directions', () => {
    const list = [sub('1', { title: 'beta' }), sub('2', { title: 'Alpha' }), sub('3', { title: 'gamma' })]
    expect(ids(sortSubtasks(list, { key: 'title', dir: 'asc' }))).toEqual(['2', '1', '3'])
    expect(ids(sortSubtasks(list, { key: 'title', dir: 'desc' }))).toEqual(['3', '1', '2'])
  })

  it('puts a subtask with no startedAt/deliveredAt LAST whichever way the arrow points', () => {
    const list = [
      sub('none'),
      sub('late', { deliveredAt: '2026-09-30', startedAt: '2026-09-20' }),
      sub('soon', { deliveredAt: '2026-09-01', startedAt: '2026-08-01' }),
    ]
    expect(ids(sortSubtasks(list, { key: 'completed', dir: 'asc' }))).toEqual(['soon', 'late', 'none'])
    expect(ids(sortSubtasks(list, { key: 'completed', dir: 'desc' }))).toEqual(['late', 'soon', 'none'])
    expect(ids(sortSubtasks(list, { key: 'started', dir: 'asc' }))).toEqual(['soon', 'late', 'none'])
    expect(ids(sortSubtasks(list, { key: 'started', dir: 'desc' }))).toEqual(['late', 'soon', 'none'])
  })

  it('follows the pipeline for status when given one, unknown statuses last', () => {
    const list = [sub('d', { status: 'done' }), sub('?', { status: 'weird' }), sub('t', { status: 'todo' })]
    const out = sortSubtasks(list, { key: 'status', dir: 'asc' }, { statusOrder: ['todo', 'done'] })
    expect(ids(out)).toEqual(['t', 'd', '?'])
  })

  it('orders by measured cost with the unmeasured LAST in both directions (in list order among themselves) — null is not zero', () => {
    const measures: Record<string, SubtaskMeasure | undefined> = {
      cheap: { sessions: 1, rounds: 2, costUSD: 1, tokens: 10 },
      dear: { sessions: 3, rounds: 7, costUSD: 9, tokens: 5 },
      unpriced: { sessions: 1, rounds: null, costUSD: null, tokens: null },
      // no entry at all: a group member, which can never hold a session
    }
    const list = [sub('member'), sub('unpriced'), sub('dear'), sub('cheap')]
    const ctx = { measureOf: (s: SortableSubtask) => measures[s.id] }
    expect(ids(sortSubtasks(list, { key: 'cost', dir: 'asc' }, ctx))).toEqual(['cheap', 'dear', 'member', 'unpriced'])
    expect(ids(sortSubtasks(list, { key: 'cost', dir: 'desc' }, ctx))).toEqual(['dear', 'cheap', 'member', 'unpriced'])
    expect(ids(sortSubtasks(list, { key: 'tokens', dir: 'asc' }, ctx))).toEqual(['dear', 'cheap', 'member', 'unpriced'])
    expect(ids(sortSubtasks(list, { key: 'sessions', dir: 'desc' }, ctx))).toEqual(['dear', 'unpriced', 'cheap', 'member'])
    // The subtask grids draw no "rounds" column of their own — this key is reached only through
    // inheritance from the main table's "Your prompts" column (`subtaskSortInherit.ts`) — but the
    // comparator itself works exactly like cost/tokens: null (unmeasured or a group member) last.
    expect(ids(sortSubtasks(list, { key: 'rounds', dir: 'asc' }, ctx))).toEqual(['cheap', 'dear', 'member', 'unpriced'])
  })

  it('orders by duration (deliveredAt − startedAt), null LAST in both directions', () => {
    const list = [
      sub('none'),
      sub('noStart', { deliveredAt: '2026-09-02T00:00:00Z' }),
      sub('noEnd', { startedAt: '2026-09-01T00:00:00Z' }),
      // Delivered before started: bad data, not a negative duration — reads as null too.
      sub('backwards', { startedAt: '2026-09-05T00:00:00Z', deliveredAt: '2026-09-01T00:00:00Z' }),
      sub('long', { startedAt: '2026-09-01T00:00:00Z', deliveredAt: '2026-09-05T00:00:00Z' }),
      sub('short', { startedAt: '2026-09-01T00:00:00Z', deliveredAt: '2026-09-01T01:00:00Z' }),
    ]
    const asc = sortSubtasks(list, { key: 'duration', dir: 'asc' })
    expect(ids(asc).slice(0, 2)).toEqual(['short', 'long'])
    expect(new Set(ids(asc).slice(2))).toEqual(new Set(['none', 'noStart', 'noEnd', 'backwards']))
    const desc = sortSubtasks(list, { key: 'duration', dir: 'desc' })
    expect(ids(desc).slice(0, 2)).toEqual(['long', 'short'])
    expect(new Set(ids(desc).slice(2))).toEqual(new Set(['none', 'noStart', 'noEnd', 'backwards']))
  })

  it('is TOTAL: equal values keep the order the list had, both directions', () => {
    const list = [sub('c', { startedAt: 'x' }), sub('a', { startedAt: 'x' }), sub('b', { startedAt: 'x' })]
    expect(ids(sortSubtasks(list, { key: 'started', dir: 'asc' }))).toEqual(['c', 'a', 'b'])
    expect(ids(sortSubtasks(list, { key: 'started', dir: 'desc' }))).toEqual(['c', 'a', 'b'])
  })
})
