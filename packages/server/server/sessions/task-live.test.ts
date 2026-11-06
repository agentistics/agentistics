import { describe, expect, test } from 'bun:test'
import { buildLive, estimateEta, stageOfStatus, type Sample } from './task-live'
import type { TaskDetail } from './task-report'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

describe('stageOfStatus', () => {
  test('protected ids map to their stage', () => {
    expect(stageOfStatus('todo')).toBe('queue')
    expect(stageOfStatus('in_progress')).toBe('running')
    expect(stageOfStatus('blocked')).toBe('adjust')
    expect(stageOfStatus('in_review')).toBe('leader')
    expect(stageOfStatus('done')).toBe('published')
  })
  test('invented statuses are read by words; unknown ones by none', () => {
    expect(stageOfStatus('qa_gate', 'Em QA')).toBe('qa')
    expect(stageOfStatus('s1', 'PR / merge')).toBe('merge')
    expect(stageOfStatus('s2', 'Revisão')).toBe('leader')
    expect(stageOfStatus('weird', 'Zebra')).toBeNull()
  })
})

describe('estimateEta', () => {
  const sample = (d: number, model = 'opus', harness = 'claude'): Sample => ({ harness, model, durationMs: d * H })
  const five = [1, 2, 3, 4, 5].map(d => sample(d))
  test('no history under three similar samples', () => {
    expect(estimateEta({ nowMs: NOW, startedAtMs: NOW - H, harness: 'claude', model: 'opus', samples: [sample(1), sample(2)] }))
      .toEqual({ kind: 'none', reason: 'no-history' })
  })
  test('not started: no ETA', () => {
    expect(estimateEta({ nowMs: NOW, startedAtMs: null, harness: 'claude', model: 'opus', samples: five }))
      .toEqual({ kind: 'none', reason: 'not-started' })
  })
  test('median, ± half the IQR, and the basis travels with it', () => {
    const e = estimateEta({ nowMs: NOW, startedAtMs: NOW - H, harness: 'claude', model: 'opus', samples: five })
    expect(e.kind).toBe('estimate')
    if (e.kind !== 'estimate') return
    expect(e.atMs).toBe(NOW - H + 3 * H)
    expect(e.plusMinusMs).toBe(1 * H)
    expect(e.basis).toMatchObject({ n: 5, scope: 'harness-model', medianMs: 3 * H })
    expect(e.confidence).toBe('medium')
  })
  test('falls back to harness-only when the model has too few samples', () => {
    const e = estimateEta({ nowMs: NOW, startedAtMs: NOW - H, harness: 'claude', model: 'sonnet', samples: five })
    expect(e.kind === 'estimate' && e.basis.scope).toBe('harness')
  })
  test('past the typical range there is no number, not a stale one', () => {
    expect(estimateEta({ nowMs: NOW, startedAtMs: NOW - 9 * H, harness: 'claude', model: 'opus', samples: five }))
      .toEqual({ kind: 'none', reason: 'beyond-range' })
  })
})

function detail(over: Partial<TaskDetail> & { subtasks: TaskDetail['subtasks']; sessions: TaskDetail['sessions'] }): TaskDetail {
  return {
    task: { id: 't1', title: 'Task one', status: 'in_progress', createdAt: iso(NOW - 99 * H), updatedAt: iso(NOW - H) },
    attempts: [], rollup: {} as never, stats: {} as never, comments: [], commentThreads: [], threads: [], files: [],
    subtaskRollups: [], times: { startedAt: null, completedAt: null, durationMs: null, activeMinutes: null, source: null },
    ...over,
  } as TaskDetail
}
const sub = (id: string, status: string, extra: object = {}) => ({
  id, taskId: 't1', title: `Sub ${id}`, done: status === 'done', status, createdAt: iso(NOW - 50 * H), updatedAt: iso(NOW - 2 * H), ...extra,
})
const sess = (id: string, subtaskId: string | null, extra: object = {}) => ({
  id, harness: 'claude', cwd: '/x', attemptId: null, subtaskId, createdAt: iso(NOW - 3 * H), model: 'opus',
  tokens: null, costUSD: null, rounds: null, ...extra,
})

describe('buildLive', () => {
  test('a live session puts its subtask in running; QA by name puts it in qa; review is a gate', () => {
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail({
        subtasks: [sub('a', 'in_progress'), sub('b', 'in_progress'), sub('c', 'in_review')] as never,
        sessions: [sess('s1', 'a'), sess('s2', 'b', { label: 'QA do Codex' })] as never,
      })],
    })
    const by = Object.fromEntries(r.deliveries.map(d => [d.subtaskId, d.stage]))
    expect(by).toEqual({ a: 'running', b: 'qa', c: 'leader' })
    expect(r.deliveries.find(d => d.subtaskId === 'a')!.sessionIds).toEqual(['s1'])
  })
  test('in-progress with nothing alive is not on the line; a published piece leaves after 24 h', () => {
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail({
        subtasks: [
          sub('idle', 'in_progress'),
          sub('fresh', 'done', { deliveredAt: iso(NOW - 2 * H) }),
          sub('old', 'done', { deliveredAt: iso(NOW - 30 * H) }),
        ] as never,
        sessions: [],
      })],
    })
    expect(r.deliveries.map(d => d.subtaskId)).toEqual(['fresh'])
  })
  test('history feeds the ETA: five delivered pieces give a live piece a ranged estimate', () => {
    const done = [1, 2, 3, 4, 5].map(i => sub(`d${i}`, 'done', { deliveredAt: iso(NOW - 40 * H) }))
    const rollups = done.map((d, i) => ({ id: d.id, times: { startedAt: iso(NOW - 50 * H), completedAt: iso(NOW - 40 * H), durationMs: (i + 1) * H, activeMinutes: 1, source: 'sessions' } }))
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail({
        subtasks: [...done, sub('live', 'in_progress')] as never,
        sessions: [...done.map(d => sess(`x-${d.id}`, d.id, { endedAt: iso(NOW - 40 * H) })), sess('live-s', 'live')] as never,
        subtaskRollups: [...rollups, { id: 'live', times: { startedAt: iso(NOW - H), completedAt: null, durationMs: null, activeMinutes: 1, source: 'sessions' } }] as never,
      })],
    })
    expect(r.samples).toBe(5)
    const live = r.deliveries.find(d => d.subtaskId === 'live')!
    expect(live.eta.kind).toBe('estimate')
  })
  test('a task with no subtasks is its own piece', () => {
    const r = buildLive({ nowMs: NOW, events: [], details: [detail({ subtasks: [], sessions: [sess('s', null)] as never })] })
    expect(r.deliveries).toHaveLength(1)
    expect(r.deliveries[0]).toMatchObject({ key: 't1', subtaskId: null, stage: 'running' })
  })
  test('activity stays on its task or subtask card', () => {
    const r = buildLive({
      nowMs: NOW,
      details: [detail({
        subtasks: [sub('a', 'in_review'), sub('b', 'in_review')] as never,
        sessions: [sess('task-s', null)] as never,
      })],
      events: [
        { id: 'task', taskId: 't1', actor: 'owner', kind: 'comment', at: iso(NOW - 3 * H), detail: 'on the task' },
        { id: 'a', taskId: 't1', actor: 'owner', kind: 'comment', at: iso(NOW - 2 * H), detail: 'on subtask "Sub a"' },
        { id: 'b', taskId: 't1', actor: 'owner', kind: 'comment', at: iso(NOW - H), subtaskId: 'b', detail: 'explicit target' },
      ],
    })
    const by = new Map(r.deliveries.map(d => [d.subtaskId, d.lastAction?.text]))
    expect(by.get(null)).toBe('on the task')
    expect(by.get('a')).toBe('on subtask "Sub a"')
    expect(by.get('b')).toBe('explicit target')
  })
})
