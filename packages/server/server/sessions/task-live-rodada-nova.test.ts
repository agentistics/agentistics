import { describe, expect, test } from 'bun:test'
import { buildLive } from './task-live'
import type { TaskDetail } from './task-report'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

// The piece entered review 2 h ago (updatedAt).
const REVIEW_AT = NOW - 2 * H

function detail(subStatus: string, sessions: object[]): TaskDetail {
  return {
    task: { id: 't1', title: 'T', status: 'in_progress', createdAt: iso(NOW - 50 * H), updatedAt: iso(NOW - H), startedAt: iso(NOW - 50 * H) },
    subtasks: [{ id: 'a', taskId: 't1', title: 'Sub a', done: false, status: subStatus, createdAt: iso(NOW - 50 * H), updatedAt: iso(REVIEW_AT) }],
    sessions, attempts: [], rollup: {}, stats: {}, comments: [], commentThreads: [], threads: [], files: [],
    subtaskRollups: [], times: { startedAt: iso(NOW - 50 * H), completedAt: null, durationMs: null, activeMinutes: null, source: 'status' },
  } as unknown as TaskDetail
}
const sess = (id: string, createdAt: number, extra: object = {}) => ({
  id, harness: 'claude', cwd: '/x', attemptId: null, subtaskId: 'a', createdAt: iso(createdAt), model: 'opus',
  tokens: null, costUSD: null, rounds: null, ...extra,
})
const stageOf = (d: TaskDetail, deliveries?: Parameters<typeof buildLive>[0]['deliveries']) =>
  buildLive({ nowMs: NOW, events: [], details: [d], ...(deliveries ? { deliveries } : {}) }).deliveries.find(x => x.subtaskId === 'a')?.stage

describe('a new round on a piece in review', () => {
  test('a live session created AFTER review entry puts the card in running', () => {
    expect(stageOf(detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000)]))).toBe('running')
  })
  test('a live QA session created after review entry puts the card in qa', () => {
    expect(stageOf(detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000, { label: 'QA do Codex' })]))).toBe('qa')
  })
  test('a worker that handed back and is still open (created BEFORE review) does not move the card', () => {
    expect(stageOf(detail('in_review', [sess('s1', REVIEW_AT - H)]))).toBe('leader')
  })
  test('the leader session does not move the card', () => {
    expect(stageOf(detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000, { label: '[ LÍDER ] - Motor' })]))).toBe('leader')
  })
  test('an exited session does not move the card', () => {
    expect(stageOf(detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000, { endedAt: iso(NOW - H / 2) })]))).toBe('leader')
  })
  test('when the new session ends the card returns to its review stage', () => {
    const live = detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000)])
    expect(stageOf(live)).toBe('running')
    const ended = detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000, { endedAt: iso(NOW - 60_000) })])
    expect(stageOf(ended)).toBe('leader')
  })
  test('a piece with a delivery record at revisao_lider stays leader', () => {
    const deliveries = new Map([['a', { phase: 'revisao_lider' }]]) as never
    expect(stageOf(detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000)]), deliveries)).toBe('leader')
  })
})
