import { test, expect } from 'bun:test'
import {
  createGroupCandidates, groupMembers, groupOf, isGroupMember, isGroupSubtask, joinGroupCandidates,
} from './subtaskGroups'
import type { Subtask } from '../../lib/tasks'

function sub(over: Partial<Subtask> & { id: string }): Subtask {
  return {
    taskId: 't1', title: over.id, done: false, status: 'todo',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

// --- isGroupSubtask / isGroupMember --------------------------------------------------------

test('isGroupSubtask: true only when isGroup is exactly true', () => {
  expect(isGroupSubtask(sub({ id: 'g1', isGroup: true }))).toBe(true)
  expect(isGroupSubtask(sub({ id: 's1' }))).toBe(false)
  expect(isGroupSubtask(sub({ id: 's1', isGroup: false as unknown as undefined }))).toBe(false)
})

test('isGroupMember: true only when parentGroupId is a non-empty string', () => {
  expect(isGroupMember(sub({ id: 'm1', parentGroupId: 'g1' }))).toBe(true)
  expect(isGroupMember(sub({ id: 's1' }))).toBe(false)
})

// --- groupMembers ---------------------------------------------------------------------------

test('groupMembers: every subtask whose parentGroupId names this group, in list order', () => {
  const subtasks = [
    sub({ id: 'g1', isGroup: true }),
    sub({ id: 'm1', parentGroupId: 'g1' }),
    sub({ id: 's1' }),
    sub({ id: 'm2', parentGroupId: 'g1' }),
  ]
  expect(groupMembers('g1', subtasks).map(s => s.id)).toEqual(['m1', 'm2'])
})

test('groupMembers: empty when nothing points at this id', () => {
  expect(groupMembers('g1', [sub({ id: 's1' })])).toEqual([])
})

// --- groupOf ---------------------------------------------------------------------------------

test('groupOf: resolves a member to its group record', () => {
  const g = sub({ id: 'g1', isGroup: true, title: 'Umbrella' })
  const m = sub({ id: 'm1', parentGroupId: 'g1' })
  expect(groupOf(m, [g, m])).toBe(g)
})

test('groupOf: undefined for a loose subtask (no parentGroupId at all)', () => {
  expect(groupOf(sub({ id: 's1' }), [sub({ id: 's1' })])).toBeUndefined()
})

test('groupOf: undefined when the referenced group no longer exists — a stale reference, not a crash', () => {
  const m = sub({ id: 'm1', parentGroupId: 'gone' })
  expect(groupOf(m, [m])).toBeUndefined()
})

// --- createGroupCandidates -------------------------------------------------------------------

test('createGroupCandidates: offers loose siblings only — excludes self, groups, and members', () => {
  const subtasks = [
    sub({ id: 's1' }),
    sub({ id: 's2' }),
    sub({ id: 'g1', isGroup: true }),
    sub({ id: 'm1', parentGroupId: 'g1' }),
  ]
  expect(createGroupCandidates('s1', subtasks).map(s => s.id)).toEqual(['s2'])
})

test('createGroupCandidates: empty when nothing else is loose', () => {
  const subtasks = [sub({ id: 's1' }), sub({ id: 'g1', isGroup: true })]
  expect(createGroupCandidates('s1', subtasks)).toEqual([])
})

// --- joinGroupCandidates ----------------------------------------------------------------------

test('joinGroupCandidates: every group of the delivery, nothing else', () => {
  const subtasks = [
    sub({ id: 's1' }),
    sub({ id: 'g1', isGroup: true }),
    sub({ id: 'g2', isGroup: true }),
    sub({ id: 'm1', parentGroupId: 'g1' }),
  ]
  expect(joinGroupCandidates(subtasks).map(s => s.id)).toEqual(['g1', 'g2'])
})

test('joinGroupCandidates: empty when the delivery has no groups yet', () => {
  expect(joinGroupCandidates([sub({ id: 's1' }), sub({ id: 's2' })])).toEqual([])
})
