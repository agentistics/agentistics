import { describe, expect, test } from 'bun:test'
import { buildLive } from './task-live'
import type { TaskDetail } from './task-report'
import { cardPercent, timeRow } from '../../../web/src/components/tasks/liveCardModel'
import { joinLive } from '../../../web/src/components/tasks/liveDeliveryModel'
import { describeLive } from './task-live-view'

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
  test('round 2 pairs 0% with its own 3 minutes, not the old 1h57 status clock', () => {
    const d = detail('in_review', [
      sess('old', NOW - 117 * 60_000, { endedAt: iso(NOW - 60 * 60_000) }),
      sess('new', NOW - 3 * 60_000),
    ])
    d.subtasks[0]!.updatedAt = iso(NOW - 117 * 60_000)
    const reply = buildLive({ nowMs: NOW, events: [], details: [d] })
    const piece = reply.deliveries[0]!
    expect(cardPercent(piece, true)?.pct).toBe(0)
    expect(piece.round).toEqual({ number: 2, startedAtMs: NOW - 3 * 60_000 })
    const c = joinLive([piece], [])[0]!
    expect(timeRow(c, NOW, true).inStage).toBe('rodada 2 · tempo da rodada 3 min')
    expect(timeRow(c, NOW, false).inStage).toBe('round 2 · time in this round 3 min')
    expect(timeRow(c, NOW, true).title).toContain('1h57')
    const mcp = describeLive({ reply, rows: [], leaderIds: new Set(), nowMs: NOW }).deliveries[0]!
    expect(mcp.round).toEqual(piece.round)
    expect(timeRow(joinLive([JSON.parse(JSON.stringify(mcp))], [])[0]!, NOW, true)).toEqual(timeRow(c, NOW, true))
  })
  test('a previous author commit does not advance the new session percentage', () => {
    const d = detail('in_review', [
      sess('old', NOW - 3 * H, { endedAt: iso(NOW - 2 * H), activity: { edits: 4, tests: 3, commits: 1, browser: false } }),
      sess('new', NOW - 3 * 60_000),
    ])
    const piece = buildLive({ nowMs: NOW, events: [], details: [d] }).deliveries[0]!
    expect(cardPercent(piece, true)?.pct).toBe(0)
  })
  test('QA gets its current QA session, not the author or previous QA activity', () => {
    const d = detail('in_review', [
      sess('author', NOW - 4 * H, { endedAt: iso(NOW - 2 * H) }),
      sess('qa-old', NOW - 3 * H, { label: 'QA first', endedAt: iso(NOW - 2 * H), activity: { browser: true, tests: 5 } }),
      sess('qa-new', NOW - 3 * 60_000, { label: 'QA second' }),
    ])
    const piece = buildLive({ nowMs: NOW, events: [], details: [d] }).deliveries[0]!
    expect(piece.stage).toBe('qa')
    expect(piece.round).toEqual({ number: 2, startedAtMs: NOW - 3 * 60_000 })
    expect(cardPercent(piece, true)?.pct).toBe(0)
  })
  test('an old reported step and handback do not advance a new round', () => {
    const d = detail('in_review', [sess('s1', NOW - 3 * 60_000)])
    d.comments = [{ subtaskId: 'a', kind: 'handback', createdAt: iso(NOW - 30 * 60_000) }] as never
    const piece = buildLive({ nowMs: NOW, details: [d], events: [
      { id: 'step', taskId: 't1', subtaskId: 'a', actor: 'old', kind: 'step', to: '5', at: iso(NOW - 30 * 60_000) },
    ] }).deliveries[0]!
    expect(cardPercent(piece, true)?.pct).toBe(0)
  })
  test('an unknown session start remains unknown, not the old status clock', () => {
    const d = detail('in_progress', [sess('s1', NOW, { createdAt: 'unknown' })])
    const piece = buildLive({ nowMs: NOW, events: [], details: [d] }).deliveries[0]!
    expect(piece.round?.startedAtMs).toBeNull()
    expect(cardPercent(piece, true)?.pct).toBe(0)
    expect(timeRow(joinLive([piece], [])[0]!, NOW, true).inStage).toBe('tempo da rodada —')
  })
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
  test('a session the reboot left lost (no endedAt, stale heartbeat) does not hold the card', () => {
    // Real registry shape: no endedAt, `lastSeenMs` frozen at the last heartbeat before the machine went down.
    const lost = sess('s1', REVIEW_AT + 10 * 60_000, { lastSeenMs: REVIEW_AT + 20 * 60_000 })
    expect(stageOf(detail('in_review', [lost]))).toBe('leader')
  })
  test('a session with a fresh heartbeat still moves the card', () => {
    expect(stageOf(detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000, { lastSeenMs: NOW - 30_000 })]))).toBe('running')
  })
  test('a worker named Leaderboard UI is a round, not the leader', () => {
    expect(stageOf(detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000, { label: 'Leaderboard UI' })]))).toBe('running')
  })
  test('the English leader label also holds', () => {
    expect(stageOf(detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000, { label: '[ LEADER ] - Engine' })]))).toBe('leader')
  })
  test('a piece with a delivery record at revisao_lider stays leader', () => {
    const deliveries = new Map([['a', { phase: 'revisao_lider' }]]) as never
    expect(stageOf(detail('in_review', [sess('s1', REVIEW_AT + 10 * 60_000)]), deliveries)).toBe('leader')
  })
})
