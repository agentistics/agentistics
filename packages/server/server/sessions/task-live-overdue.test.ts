import { describe, expect, test } from 'bun:test'
import { buildLive } from './task-live'
import type { TaskDetail } from './task-report'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

/** A piece working for `ageH` hours with no stage history at all (no events, no typicals, no samples). */
function detail(ageH: number): TaskDetail {
  const since = NOW - ageH * H
  return {
    task: { id: 't1', title: 'T', status: 'in_progress', createdAt: iso(since), updatedAt: iso(NOW - H), startedAt: iso(since) },
    subtasks: [{ id: 'a', taskId: 't1', title: 'Sub a', done: false, status: 'in_progress', createdAt: iso(since), updatedAt: iso(since) }],
    sessions: [{ id: 's1', harness: 'claude', cwd: '/x', attemptId: null, subtaskId: 'a', createdAt: iso(since), model: 'opus', tokens: null, costUSD: null, rounds: null }],
    attempts: [], rollup: {}, stats: {}, comments: [], commentThreads: [], threads: [], files: [],
    subtaskRollups: [], times: { startedAt: iso(since), completedAt: null, durationMs: null, activeMinutes: null, source: 'status' },
  } as unknown as TaskDetail
}
const pieceOf = (d: TaskDetail) => buildLive({ nowMs: NOW, events: [], details: [d] }).deliveries.find(x => x.subtaskId === 'a')

describe('buildLive derives overdueSinceMs from the stage ceiling when there is no history', () => {
  test('a running piece stuck past its ceiling (2 days) is overdue since the boundary, with no estimate in the past', () => {
    const p = pieceOf(detail(5 * 24))
    expect(p).toBeDefined()
    expect(p!.stage).toBe('running')
    expect(p!.overdueSinceMs).toBe(p!.stageSinceMs! + 2 * 24 * H)
    expect(p!.overdueSinceMs!).toBeLessThan(NOW)
    expect(p!.publishEta.kind).toBe('none')
  })

  test('a running piece inside its ceiling is not overdue and keeps a future estimate', () => {
    const p = pieceOf(detail(3))
    expect(p).toBeDefined()
    expect(p!.overdueSinceMs).toBeUndefined()
    const eta = p!.publishEta
    expect(eta.kind).toBe('estimate')
    expect((eta as { atMs: number }).atMs).toBeGreaterThan(NOW)
  })
})
