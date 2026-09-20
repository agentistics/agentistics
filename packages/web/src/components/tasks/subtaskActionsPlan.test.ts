import { test, expect } from 'bun:test'
import { planSubtaskActions } from './subtaskActionsPlan'
import type { Subtask } from '../../lib/tasks'

function sub(over: Partial<Subtask> & { id: string }): Subtask {
  return {
    taskId: 't1', title: over.id, done: false, status: 'todo',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

// --- staged ------------------------------------------------------------------------------------

test('staged: null when the surface has no staged-session wiring at all', () => {
  const plan = planSubtaskActions(sub({ id: 's1' }), [], { hasStagedDraft: false, stagedWired: false })
  expect(plan.staged).toBeNull()
})

test('staged: "compose" when wired, loose, and no draft exists yet', () => {
  const plan = planSubtaskActions(sub({ id: 's1' }), [], { hasStagedDraft: false, stagedWired: true })
  expect(plan.staged).toBe('compose')
})

test('staged: "fire-or-edit" once a draft exists — never offered alongside "compose"', () => {
  const plan = planSubtaskActions(sub({ id: 's1' }), [], { hasStagedDraft: true, stagedWired: true })
  expect(plan.staged).toBe('fire-or-edit')
})

test('staged: null on a group MEMBER even when wired and a draft exists — subtask_in_group', () => {
  const member = sub({ id: 'm1', parentGroupId: 'g1' })
  const plan = planSubtaskActions(member, [], { hasStagedDraft: true, stagedWired: true })
  expect(plan.staged).toBeNull()
})

test('staged: null on a group MEMBER with no draft too — never "compose" either', () => {
  const member = sub({ id: 'm1', parentGroupId: 'g1' })
  const plan = planSubtaskActions(member, [], { hasStagedDraft: false, stagedWired: true })
  expect(plan.staged).toBeNull()
})

test('staged: a GROUP itself (not a member) keeps its staged section, same as a loose subtask', () => {
  const group = sub({ id: 'g1', isGroup: true })
  const plan = planSubtaskActions(group, [], { hasStagedDraft: false, stagedWired: true })
  expect(plan.staged).toBe('compose')
})

// --- group ---------------------------------------------------------------------------------------

test('group: "loose" with nothing to create or join when no candidates exist', () => {
  const plan = planSubtaskActions(sub({ id: 's1' }), [sub({ id: 's1' })], { hasStagedDraft: false, stagedWired: false })
  expect(plan.group).toEqual({ kind: 'loose', canCreate: false, canJoin: false })
})

test('group: "loose" can create when another loose sibling exists', () => {
  const siblings = [sub({ id: 's1' }), sub({ id: 's2' })]
  const plan = planSubtaskActions(sub({ id: 's1' }), siblings, { hasStagedDraft: false, stagedWired: false })
  expect(plan.group).toEqual({ kind: 'loose', canCreate: true, canJoin: false })
})

test('group: "loose" can join when a group already exists on the delivery', () => {
  const siblings = [sub({ id: 's1' }), sub({ id: 'g1', isGroup: true })]
  const plan = planSubtaskActions(sub({ id: 's1' }), siblings, { hasStagedDraft: false, stagedWired: false })
  expect(plan.group).toEqual({ kind: 'loose', canCreate: false, canJoin: true })
})

test('group: "group" for a row that is itself a group, regardless of candidates', () => {
  const g = sub({ id: 'g1', isGroup: true })
  const plan = planSubtaskActions(g, [g, sub({ id: 's1' })], { hasStagedDraft: false, stagedWired: false })
  expect(plan.group).toEqual({ kind: 'group' })
})

test('group: "member" for a row that belongs to a group', () => {
  const m = sub({ id: 'm1', parentGroupId: 'g1' })
  const plan = planSubtaskActions(m, [sub({ id: 'g1', isGroup: true }), m], { hasStagedDraft: false, stagedWired: false })
  expect(plan.group).toEqual({ kind: 'member' })
})

// --- canRemove -------------------------------------------------------------------------------

test('canRemove: always true, in every state — a group member included', () => {
  expect(planSubtaskActions(sub({ id: 's1' }), [], { hasStagedDraft: false, stagedWired: false }).canRemove).toBe(true)
  const member = sub({ id: 'm1', parentGroupId: 'g1' })
  expect(planSubtaskActions(member, [], { hasStagedDraft: false, stagedWired: false }).canRemove).toBe(true)
})
