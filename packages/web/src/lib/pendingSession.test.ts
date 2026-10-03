import { describe, expect, test } from 'bun:test'
import {
  addPendingSession, dismissFailedPendingSession, emptyPendingSessions,
  PENDING_SESSION_WAIT_MS, reconcilePendingSessions,
} from './pendingSession'

describe('addPendingSession', () => {
  test('adds a fresh entry stamped with now', () => {
    const state = addPendingSession(emptyPendingSessions(), { id: 'a', harness: 'claude', label: 'Fix bug' }, 1000)
    expect(state.pending).toEqual([{ id: 'a', harness: 'claude', label: 'Fix bug', since: 1000 }])
    expect(state.failed).toEqual([])
  })

  test('replaces an earlier entry of the same id rather than duplicating it', () => {
    let state = addPendingSession(emptyPendingSessions(), { id: 'a' }, 1000)
    state = addPendingSession(state, { id: 'a', label: 'renamed' }, 2000)
    expect(state.pending).toEqual([{ id: 'a', label: 'renamed', since: 2000 }])
  })

  test('a session started again after being marked failed gets a fresh placeholder', () => {
    let state = addPendingSession(emptyPendingSessions(), { id: 'a' }, 0)
    state = reconcilePendingSessions(state, new Set(), PENDING_SESSION_WAIT_MS)
    expect(state.failed.map(f => f.id)).toEqual(['a'])
    state = addPendingSession(state, { id: 'a' }, PENDING_SESSION_WAIT_MS + 1)
    expect(state.pending.map(p => p.id)).toEqual(['a'])
    expect(state.failed).toEqual([])
  })
})

describe('reconcilePendingSessions', () => {
  test('an id that now appears in the fleet is resolved silently — dropped, never reported', () => {
    const state = addPendingSession(emptyPendingSessions(), { id: 'a' }, 1000)
    const next = reconcilePendingSessions(state, new Set(['a']), 1500)
    expect(next.pending).toEqual([])
    expect(next.failed).toEqual([])
  })

  test('an id still missing within the budget stays pending', () => {
    const state = addPendingSession(emptyPendingSessions(), { id: 'a' }, 1000)
    const next = reconcilePendingSessions(state, new Set(), 1000 + PENDING_SESSION_WAIT_MS - 1)
    expect(next.pending.map(p => p.id)).toEqual(['a'])
    expect(next.failed).toEqual([])
  })

  test('an id still missing once the budget runs out moves to failed, never silently vanishes', () => {
    const state = addPendingSession(emptyPendingSessions(), { id: 'a' }, 1000)
    const next = reconcilePendingSessions(state, new Set(), 1000 + PENDING_SESSION_WAIT_MS)
    expect(next.pending).toEqual([])
    expect(next.failed.map(f => f.id)).toEqual(['a'])
  })

  test('matches on the conversation id too, the same double key the rest of the workspace uses', () => {
    const state = addPendingSession(emptyPendingSessions(), { id: 'tmux-a' }, 1000)
    const next = reconcilePendingSessions(state, new Set(['conv-b', 'tmux-a']), 1500)
    expect(next.pending).toEqual([])
  })

  test('returns the same reference when there is nothing to change', () => {
    const state = emptyPendingSessions()
    expect(reconcilePendingSessions(state, new Set(), 1000)).toBe(state)

    const withOne = addPendingSession(emptyPendingSessions(), { id: 'a' }, 1000)
    expect(reconcilePendingSessions(withOne, new Set(), 1500)).toBe(withOne)
  })

  test('several pending ids resolve and expire independently', () => {
    let state = addPendingSession(emptyPendingSessions(), { id: 'a' }, 0)
    state = addPendingSession(state, { id: 'b' }, 0)
    const next = reconcilePendingSessions(state, new Set(['a']), PENDING_SESSION_WAIT_MS)
    expect(next.pending).toEqual([])
    expect(next.failed.map(f => f.id)).toEqual(['b'])
  })
})

describe('dismissFailedPendingSession', () => {
  test('drops one failed entry by id', () => {
    let state = addPendingSession(emptyPendingSessions(), { id: 'a' }, 0)
    state = reconcilePendingSessions(state, new Set(), PENDING_SESSION_WAIT_MS)
    const next = dismissFailedPendingSession(state, 'a')
    expect(next.failed).toEqual([])
  })

  test('returns the same reference when the id is not among the failed', () => {
    const state = emptyPendingSessions()
    expect(dismissFailedPendingSession(state, 'a')).toBe(state)
  })
})

describe('markSessionPending — a native session is never a pending fleet row (UI.2)', () => {
  test('a native id leaves no placeholder; a fleet id still does', async () => {
    const { markSessionPending, getPendingSessionsSnapshot } = await import('./pendingSessionStore')
    const before = JSON.stringify(getPendingSessionsSnapshot())
    markSessionPending({ id: `ses_${'c3'.repeat(16)}`, harness: 'agentistics', label: 'native' })
    expect(JSON.stringify(getPendingSessionsSnapshot())).toBe(before)
    markSessionPending({ id: 'ag-claude-xyz', harness: 'claude', label: 'fleet' })
    expect(JSON.stringify(getPendingSessionsSnapshot())).not.toBe(before)
  })
})
