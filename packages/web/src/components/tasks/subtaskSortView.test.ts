import { describe, expect, it } from 'bun:test'
import type { Subtask, SubtaskView, TaskSessionRow } from '../../lib/tasks'
import { measureOfSubtask, orderedSubtasks } from './subtaskSortView'

const sub = (id: string, over: Partial<Subtask> = {}): Subtask => ({
  id, taskId: 't', title: id, done: false, status: 'todo',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
})
const rollup = (o: { used: number; cost: number | null; tokens: number | null; credits?: boolean }) => ({
  sessionsUsed: o.used, sessionsLinked: o.used, costUSD: o.cost, tokens: o.tokens, rounds: 1,
  mixedCurrency: false,
  credits: o.credits ? { premiumRequests: 3 } : null,
}) as unknown as SubtaskView['rollup']
const view = (id: string, r: SubtaskView['rollup']): SubtaskView => ({ id, rollup: r }) as unknown as SubtaskView
const sess = (id: string, subtaskId: string | null): TaskSessionRow => ({
  id, harness: 'claude', cwd: '/', attemptId: null, subtaskId, createdAt: '2026-01-01',
  tokens: null, costUSD: null, rounds: null,
})

describe('measureOfSubtask', () => {
  const views = [
    view('cheap', rollup({ used: 1, cost: 1, tokens: 100 })),
    view('unpriced', rollup({ used: 1, cost: null, tokens: null })),
    view('nobody', rollup({ used: 0, cost: null, tokens: null })),
    view('credits', rollup({ used: 1, cost: null, tokens: 5, credits: true })),
  ]
  const sessions = [sess('s1', 'cheap'), sess('s2', 'cheap'), sess('s3', null)]

  it('counts sessions filed on the subtask, a real zero when there are none', () => {
    expect(measureOfSubtask(sub('cheap'), views, sessions)?.sessions).toBe(2)
    expect(measureOfSubtask(sub('nobody'), views, sessions)?.sessions).toBe(0)
  })

  it('reads cost and tokens the way the cells do: no session → nothing, unpriced → null', () => {
    expect(measureOfSubtask(sub('cheap'), views, sessions)).toEqual({ sessions: 2, rounds: 1, costUSD: 1, tokens: 100 })
    expect(measureOfSubtask(sub('nobody'), views, sessions)).toEqual({ sessions: 0, rounds: null, costUSD: null, tokens: null })
    // `rounds` follows the ROLLUP's own `sessionsUsed` (1 here, per the `rollup()` fixture above),
    // never the locally-filtered `sessions` count (0) — the same "untracked" gate cost/tokens use.
    expect(measureOfSubtask(sub('unpriced'), views, sessions)).toEqual({ sessions: 0, rounds: 1, costUSD: null, tokens: null })
  })

  it('rounds is null once the bucket says nothing is tracked, even if the rollup carries a stray value', () => {
    expect(measureOfSubtask(sub('nobody'), views, sessions)?.rounds).toBeNull()
  })

  it('a Copilot-credits cost is no dollar figure to compare', () => {
    expect(measureOfSubtask(sub('credits'), views, sessions)?.costUSD).toBeNull()
  })

  it('a group MEMBER has no measure at all', () => {
    expect(measureOfSubtask(sub('m', { parentGroupId: 'g' }), views, sessions)).toBeUndefined()
  })
})

describe('orderedSubtasks', () => {
  it('orders by cost with the unmeasured last, and by the pipeline for status', () => {
    const views = [
      view('a', rollup({ used: 1, cost: 9, tokens: 1 })),
      view('b', rollup({ used: 1, cost: 2, tokens: 1 })),
    ]
    const list = [sub('none', { status: 'done' }), sub('a', { status: 'todo' }), sub('b', { status: 'in_progress' })]
    const ctx = { views, sessions: [], statusOrder: ['todo', 'in_progress', 'done'] }
    expect(orderedSubtasks(list, { key: 'cost', dir: 'asc' }, ctx).map(s => s.id)).toEqual(['b', 'a', 'none'])
    expect(orderedSubtasks(list, { key: 'cost', dir: 'desc' }, ctx).map(s => s.id)).toEqual(['a', 'b', 'none'])
    expect(orderedSubtasks(list, { key: 'status', dir: 'asc' }, ctx).map(s => s.id)).toEqual(['a', 'b', 'none'])
    expect(orderedSubtasks(list, null, ctx).map(s => s.id)).toEqual(['none', 'a', 'b'])
  })
})
