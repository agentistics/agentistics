import { describe, expect, test } from 'bun:test'
import { buildLive } from './task-live'
import type { TaskDetail } from './task-report'

// LIVE.EM-ANDAMENTO-E-LIDER r2: the stored role of a session wins over its name. A leader (or worker) whose folder or
// label happens to contain "qa" is not the QA's; the name stays the fallback when nobody stored a role.

const NOW = Date.parse('2026-11-09T12:00:00Z')
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

function detail(sessions: object[]): TaskDetail {
  return {
    task: { id: 't1', title: 'T', status: 'in_progress', createdAt: iso(NOW - 50 * H), updatedAt: iso(NOW - H), startedAt: iso(NOW - 50 * H) },
    subtasks: [], sessions, attempts: [], rollup: {}, stats: {}, comments: [], commentThreads: [], threads: [], files: [],
    subtaskRollups: [], times: { startedAt: iso(NOW - 50 * H), completedAt: null, durationMs: null, activeMinutes: null, source: 'status' },
  } as unknown as TaskDetail
}
const sess = (id: string, extra: object = {}) => ({
  id, harness: 'claude', cwd: '/x', attemptId: null, subtaskId: null, createdAt: iso(NOW - 10 * 60_000), model: 'opus',
  tokens: null, costUSD: null, rounds: null, ...extra,
})
const stageOf = (d: TaskDetail, roleOf?: (s: { id: string; conversationId?: string }) => string | undefined) =>
  buildLive({ nowMs: NOW, events: [], details: [d], ...(roleOf ? { roleOf } : {}) }).deliveries[0]?.stage

describe('the stored role wins over the name', () => {
  const d = () => detail([sess('L', { label: 'qa-engine lider' })])
  test('no stored role: the name is the fallback, so a "qa" label still reads as QA', () => {
    expect(stageOf(d())).toBe('qa')
    expect(stageOf(d(), () => undefined)).toBe('qa')
  })
  test('stored role leader: never QA, whatever the label says', () => {
    expect(stageOf(d(), s => (s.id === 'L' ? 'leader' : undefined))).toBe('running')
  })
  test('stored role worker: never QA either', () => {
    expect(stageOf(d(), () => 'worker')).toBe('running')
  })
  test('the role is looked up by the conversation too', () => {
    const withConv = detail([sess('L', { label: 'qa-engine', conversationId: 'conv-1' })])
    expect(stageOf(withConv, s => (s.conversationId === 'conv-1' ? 'leader' : undefined))).toBe('running')
  })
})
