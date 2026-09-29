import { describe, expect, test } from 'bun:test'
import {
  distinctHarnesses, distinctModels, EMPTY_SUBTASK_FILTER, filterSubtaskRows, subtaskFilterActive,
} from './subtaskFilter'
import type { Subtask, TaskSessionRow } from '../../lib/tasks'

function subtask(o: Partial<Subtask> & Pick<Subtask, 'id' | 'status'>): Subtask {
  return {
    taskId: 't1', title: o.id, done: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...o,
  }
}

function session(o: Partial<TaskSessionRow> & Pick<TaskSessionRow, 'id' | 'subtaskId'>): TaskSessionRow {
  return {
    harness: 'claude', cwd: '/x', attemptId: null, createdAt: '2026-01-01T00:00:00Z',
    model: null, tokens: null, costUSD: null, rounds: null,
    ...o,
  }
}

describe('subtaskFilterActive', () => {
  test('false when every field is null', () => {
    expect(subtaskFilterActive(EMPTY_SUBTASK_FILTER)).toBe(false)
  })
  test('true when any field is set', () => {
    expect(subtaskFilterActive({ ...EMPTY_SUBTASK_FILTER, status: 'todo' })).toBe(true)
    expect(subtaskFilterActive({ ...EMPTY_SUBTASK_FILTER, harness: 'codex' })).toBe(true)
    expect(subtaskFilterActive({ ...EMPTY_SUBTASK_FILTER, model: 'claude-opus-5' })).toBe(true)
  })
})

describe('filterSubtaskRows', () => {
  const s1 = subtask({ id: 's1', status: 'todo' })
  const s2 = subtask({ id: 's2', status: 'done' })
  const sessions: TaskSessionRow[] = [
    session({ id: 'sess1', subtaskId: 's1', harness: 'claude', model: 'claude-opus-5' }),
    session({ id: 'sess2', subtaskId: 's2', harness: 'codex', model: 'gpt-5-codex' }),
  ]

  test('an inactive filter returns every row', () => {
    expect(filterSubtaskRows([s1, s2], sessions, EMPTY_SUBTASK_FILTER)).toEqual([s1, s2])
  })

  test('filters by status', () => {
    const out = filterSubtaskRows([s1, s2], sessions, { ...EMPTY_SUBTASK_FILTER, status: 'todo' })
    expect(out.map(t => t.id)).toEqual(['s1'])
  })

  test('filters by harness, over the subtask\'s own filed sessions', () => {
    const out = filterSubtaskRows([s1, s2], sessions, { ...EMPTY_SUBTASK_FILTER, harness: 'codex' })
    expect(out.map(t => t.id)).toEqual(['s2'])
  })

  test('filters by model', () => {
    const out = filterSubtaskRows([s1, s2], sessions, { ...EMPTY_SUBTASK_FILTER, model: 'gpt-5-codex' })
    expect(out.map(t => t.id)).toEqual(['s2'])
  })

  test('a subtask with no filed sessions never matches a harness/model filter', () => {
    const bare = subtask({ id: 's3', status: 'todo' })
    const out = filterSubtaskRows([bare], sessions, { ...EMPTY_SUBTASK_FILTER, harness: 'claude' })
    expect(out).toEqual([])
  })

  test('keeps a GROUP header whose own sessions do not match when a MEMBER does', () => {
    const group = subtask({ id: 'g1', status: 'todo', isGroup: true })
    const member = subtask({ id: 'm1', status: 'todo', parentGroupId: 'g1' })
    const memberSessions: TaskSessionRow[] = [
      session({ id: 'sess3', subtaskId: 'm1', harness: 'codex', model: 'gpt-5-codex' }),
    ]
    const out = filterSubtaskRows([group, member], memberSessions, { ...EMPTY_SUBTASK_FILTER, harness: 'codex' })
    expect(out.map(t => t.id).sort()).toEqual(['g1', 'm1'])
  })

  test('keeps a MEMBER whose own sessions do not match when its GROUP does', () => {
    const group = subtask({ id: 'g1', status: 'todo', isGroup: true })
    const member = subtask({ id: 'm1', status: 'todo', parentGroupId: 'g1' })
    const groupSessions: TaskSessionRow[] = [
      session({ id: 'sess4', subtaskId: 'g1', harness: 'codex', model: 'gpt-5-codex' }),
    ]
    const out = filterSubtaskRows([group, member], groupSessions, { ...EMPTY_SUBTASK_FILTER, harness: 'codex' })
    expect(out.map(t => t.id).sort()).toEqual(['g1', 'm1'])
  })

  test('drops a group and its members entirely when neither matches', () => {
    const group = subtask({ id: 'g1', status: 'todo', isGroup: true })
    const member = subtask({ id: 'm1', status: 'todo', parentGroupId: 'g1' })
    const out = filterSubtaskRows([group, member], [], { ...EMPTY_SUBTASK_FILTER, harness: 'codex' })
    expect(out).toEqual([])
  })
})

describe('distinctHarnesses / distinctModels', () => {
  test('first-seen order, no duplicates, nulls dropped', () => {
    const sessions: TaskSessionRow[] = [
      session({ id: 'a', subtaskId: 's1', harness: 'claude', model: 'claude-opus-5' }),
      session({ id: 'b', subtaskId: 's1', harness: 'codex', model: null }),
      session({ id: 'c', subtaskId: 's1', harness: 'claude', model: 'claude-opus-5' }),
    ]
    expect(distinctHarnesses(sessions)).toEqual(['claude', 'codex'])
    expect(distinctModels(sessions)).toEqual(['claude-opus-5'])
  })
})
