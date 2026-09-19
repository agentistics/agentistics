import { describe, expect, it } from 'bun:test'
import {
  TASK_STATUSES, groupMembers, isClosed, isGroupMember, isGroupSubtask, legacyTaskId,
  migrateLegacyTasks, migrateStatus, newAttemptId, newTaskId, statusAfterAttach,
} from './task-model'
import type { Subtask } from './task-model'

describe('legacyTaskId', () => {
  it('is stable for the same name, so migrating twice yields one task', () => {
    expect(legacyTaskId('ship the parser')).toBe(legacyTaskId('ship the parser'))
  })

  it('separates names that differ only by case or padding, because the user typed them apart', () => {
    // A task name is a label a person chose. Folding case here would silently merge two boards.
    expect(legacyTaskId('Parser')).not.toBe(legacyTaskId('parser'))
    expect(legacyTaskId(' parser')).not.toBe(legacyTaskId('parser'))
  })

  it('is safe as a file key and as a CLI argument', () => {
    expect(legacyTaskId('a/b:c d')).toMatch(/^legacy-[0-9a-f]{10}$/)
  })
})

describe('migrateLegacyTasks', () => {
  const now = '2026-09-05T12:00:00.000Z'

  it('turns every named string into a task, and marks the finished ones delivered', () => {
    const tasks = migrateLegacyTasks({ names: ['ship the parser', 'AIPE'], finished: ['AIPE'], now })
    expect(tasks.map(t => t.title)).toEqual(['ship the parser', 'AIPE'])
    expect(tasks.map(t => t.status)).toEqual(['todo', 'done'])
    expect(tasks[1]!.deliveredAt).toBe(now)
  })

  it('is idempotent: the same input twice yields identical records', () => {
    const a = migrateLegacyTasks({ names: ['x'], finished: [], now })
    const b = migrateLegacyTasks({ names: ['x'], finished: [], now })
    expect(a).toEqual(b)
  })

  it('carries a finished name that no session still references', () => {
    // `finishedTasks` outlives the sessions it was about. A delivery that happened is not erased by
    // its rows being cleaned up.
    const tasks = migrateLegacyTasks({ names: [], finished: ['gone'], now })
    expect(tasks.map(t => [t.title, t.status])).toEqual([['gone', 'done']])
  })

  it('dedupes a name that appears on many sessions', () => {
    const tasks = migrateLegacyTasks({ names: ['x', 'x', 'x'], finished: [], now })
    expect(tasks).toHaveLength(1)
  })
})

describe('id minting', () => {
  it('mints distinct ids that are safe as CLI arguments', () => {
    expect(newTaskId()).not.toBe(newTaskId())
    expect(newTaskId()).toMatch(/^t-[0-9a-f]{10}$/)
    expect(newAttemptId()).toMatch(/^a-[0-9a-f]{10}$/)
  })
})

describe('migrateStatus', () => {
  it('keeps the two words the board used before it had seven', () => {
    // `open` written by an older build must keep meaning what it meant, and `delivered` IS `done` —
    // the metric that closes on it may not shift because the vocabulary grew.
    expect(migrateStatus('open')).toBe('todo')
    expect(migrateStatus('delivered')).toBe('done')
  })

  it('passes every current status through', () => {
    for (const s of TASK_STATUSES) expect(migrateStatus(s)).toBe(s)
  })

  it('refuses a word that is not a status rather than inventing one', () => {
    expect(migrateStatus('frobnicated')).toBeNull()
    expect(migrateStatus(7)).toBeNull()
    expect(migrateStatus(undefined)).toBeNull()
  })
})

describe('isClosed', () => {
  it('is true only for the two that mean the work stopped', () => {
    expect(TASK_STATUSES.filter(isClosed)).toEqual(['done', 'abandoned'])
  })
})

describe('statusAfterAttach', () => {
  it('advances the two "nothing started" statuses to in_progress', () => {
    expect(statusAfterAttach('backlog')).toBe('in_progress')
    expect(statusAfterAttach('todo')).toBe('in_progress')
  })

  it('never overwrites a status that already means something more specific', () => {
    for (const s of ['in_progress', 'blocked', 'in_review', 'done', 'abandoned'] as const) {
      expect(statusAfterAttach(s)).toBeNull()
    }
  })
})

const subtask = (over: Partial<Subtask> = {}): Subtask => ({
  id: 's1', taskId: 't1', title: 'a piece of work', done: false, status: 'todo',
  createdAt: '2026-09-17T10:00:00.000Z', updatedAt: '2026-09-17T10:00:00.000Z',
  ...over,
})

describe('isGroupSubtask / isGroupMember (§F.1)', () => {
  it('reads `isGroup` and `parentGroupId` as booleans, absent included', () => {
    expect(isGroupSubtask(subtask({ isGroup: true }))).toBe(true)
    expect(isGroupSubtask(subtask())).toBe(false)
    expect(isGroupMember(subtask({ parentGroupId: 'g1' }))).toBe(true)
    expect(isGroupMember(subtask())).toBe(false)
  })
})

describe('groupMembers', () => {
  it('returns every subtask naming this group, and nothing else', () => {
    const subs = [
      subtask({ id: 'g1', isGroup: true }),
      subtask({ id: 'm1', parentGroupId: 'g1' }),
      subtask({ id: 'm2', parentGroupId: 'g1' }),
      subtask({ id: 's1' }), // loose — not a member
      subtask({ id: 'm9', parentGroupId: 'g2' }), // a DIFFERENT group
    ]
    expect(groupMembers('g1', subs).map(s => s.id)).toEqual(['m1', 'm2'])
  })

  it('answers empty for a group with no members yet', () => {
    expect(groupMembers('g1', [subtask({ id: 'g1', isGroup: true })])).toEqual([])
  })
})
