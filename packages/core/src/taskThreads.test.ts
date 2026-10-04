import { describe, expect, test } from 'bun:test'
import {
  canSessionOpenThread, deliverySummary, isCommentKind, looseComments, planQueuedFlush, planThreadFanout,
  rowForParticipant, threadDeliveryText, threadInbox, withParticipant,
  type FleetRowLike, type TaskThreadRecord, type ThreadCommentLike, type ThreadParticipant,
} from './taskThreads'

const P = (sessionId: string, conversationId?: string): ThreadParticipant =>
  ({ sessionId, ...(conversationId ? { conversationId } : {}), joinedAt: '2026-10-04T00:00:00Z' })
const R = (id: string, state: string, o: Partial<FleetRowLike> = {}): FleetRowLike =>
  ({ id, state, actionable: true, ...o })
const C = (o: Partial<ThreadCommentLike> & { createdAt: string }): ThreadCommentLike =>
  ({ id: o.createdAt, body: 'x', author: 'a', ...o })
const T = (o: Partial<TaskThreadRecord> = {}): TaskThreadRecord => ({
  id: 'th1', taskId: 't1', title: 'Release', kind: 'topic', openedBy: 'me',
  createdAt: '2026-10-04T00:00:00Z', participants: [], ...o,
})

describe('who may open a thread', () => {
  test('a session only for a handback or a block', () => {
    expect(canSessionOpenThread('handback')).toBe(true)
    expect(canSessionOpenThread('block')).toBe(true)
    expect(canSessionOpenThread('topic')).toBe(false)
  })
})

describe('rowForParticipant', () => {
  test('matches a reopened row by conversation, preferring the running one', () => {
    const rows = [R('old', 'exited', { conversationId: 'c1' }), R('new', 'waiting', { conversationId: 'c1' })]
    expect(rowForParticipant(P('old', 'c1'), rows)?.id).toBe('new')
  })
  test('without a conversation link only the own id matches', () => {
    expect(rowForParticipant(P('x'), [R('y', 'waiting', { conversationId: 'c' })])).toBeUndefined()
  })
})

describe('planThreadFanout — the explicit send to N sessions', () => {
  const rows = [
    R('a', 'working'),
    R('b', 'waiting'),
    R('c', 'waiting-approval'),
    R('d', 'exited', { conversationId: 'cd' }),
    R('e', 'working', { actionable: false }),
  ]
  const plan = planThreadFanout([P('a'), P('b'), P('c'), P('d', 'cd'), P('e'), P('gone', 'cg'), P('nolink'), P('m')], rows, ['m'])
  const by = Object.fromEntries(plan.map(s => [s.sessionId, s]))
  test('a running hosted session receives it now, working or waiting — a thread never waits for it', () => {
    expect(by.a).toMatchObject({ action: 'send', rowId: 'a' })
    expect(by.b).toMatchObject({ action: 'send', rowId: 'b' })
  })
  test('a session on a permission dialog is queued, never typed into', () => {
    expect(by.c).toMatchObject({ action: 'queue', reason: 'dialog-open' })
  })
  test('a finished session is queued for its reopen, never reopened for it', () => {
    expect(by.d).toMatchObject({ action: 'queue', reason: 'not-running' })
    expect(by.gone).toMatchObject({ action: 'queue', reason: 'not-running' })
  })
  test('an external assistant and an unresolvable participant are said, never silently skipped', () => {
    expect(by.e).toMatchObject({ action: 'skip', state: 'undeliverable', reason: 'external' })
    expect(by.nolink).toMatchObject({ action: 'skip', state: 'undeliverable', reason: 'unknown-session' })
  })
  test('a muted participant is skipped as muted', () => {
    expect(by.m).toMatchObject({ action: 'skip', state: 'muted' })
  })
  test('a participant listed twice receives it once', () => {
    expect(planThreadFanout([P('a'), P('a')], rows)).toHaveLength(1)
  })
})

describe('planQueuedFlush', () => {
  test('goes once the conversation runs again and is not on a dialog', () => {
    const rows = [R('n1', 'waiting', { conversationId: 'c1' }), R('n2', 'waiting-approval', { conversationId: 'c2' })]
    expect(planQueuedFlush([{ sessionId: 'old1', conversationId: 'c1' }, { sessionId: 'old2', conversationId: 'c2' }, { sessionId: 'z' }], rows))
      .toEqual([{ sessionId: 'old1', rowId: 'n1' }])
  })
})

describe('inbox, loose comments, summary, header', () => {
  test('open then resolved, newest activity first — and nothing ever "awaits" an answer', () => {
    const threads = [T({ id: 'a' }), T({ id: 'b' }), T({ id: 'c', resolvedAt: 'x' })]
    const cs = [
      C({ createdAt: '2026-10-04T01:00:00Z', threadId: 'a', role: 'session', sessionId: 's' }),
      C({ createdAt: '2026-10-04T03:00:00Z', threadId: 'b', role: 'owner' }),
      C({ createdAt: '2026-10-04T02:00:00Z' }),
    ]
    const inbox = threadInbox(threads, cs)
    expect(Object.keys(inbox)).toEqual(['open', 'resolved'])
    expect(inbox.open.map(s => s.thread.id)).toEqual(['b', 'a'])
    expect(inbox.resolved.map(s => s.thread.id)).toEqual(['c'])
    expect(looseComments(cs)).toHaveLength(1)
  })
  test('comment kinds', () => {
    expect(isCommentKind('decision')).toBe(true)
    expect(isCommentKind('handback')).toBe(true)
    expect(isCommentKind('question')).toBe(false)
  })
  test('deliverySummary counts each state', () => {
    const s = deliverySummary([
      { sessionId: 'a', state: 'delivered', at: '' }, { sessionId: 'b', state: 'queued', at: '' },
      { sessionId: 'c', state: 'delivered', at: '' },
    ])
    expect(s).toMatchObject({ delivered: 2, queued: 1, total: 3 })
  })
  test('the delivered text names its origin on one line', () => {
    const t = threadDeliveryText({ taskTitle: 'Runtime', threadTitle: 'Release', body: 'Pode.' })
    expect(t.split('\n')[0]).toBe('[Agentask · Runtime · thread "Release" · sent by the owner]')
    expect(t.endsWith('\nPode.')).toBe(true)
  })
  test('withParticipant is idempotent and fills a missing conversation', () => {
    const one = withParticipant([], P('s'))
    expect(withParticipant(one, P('s'))).toHaveLength(1)
    expect(withParticipant(one, P('s', 'c'))[0]?.conversationId).toBe('c')
  })
})
