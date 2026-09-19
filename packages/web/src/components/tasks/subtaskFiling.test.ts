import { describe, expect, it } from 'bun:test'
import { classifyForFiling, isPickable } from './subtaskFiling'
import type { Subtask } from '../../lib/tasks'

function sub(over: Partial<Subtask> & { id: string; title: string }): Subtask {
  return {
    taskId: 't1', done: false, status: 'todo', createdAt: '', updatedAt: '',
    ...over,
  }
}

describe('classifyForFiling', () => {
  it('a loose subtask (no isGroup, no parentGroupId) classifies as "subtask"', () => {
    const s = sub({ id: 's1', title: 'Loose' })
    expect(classifyForFiling([s])).toEqual([{ kind: 'subtask', subtask: s }])
  })

  it('an isGroup subtask classifies as "group", regardless of members', () => {
    const g = sub({ id: 'g1', title: 'Group A', isGroup: true })
    expect(classifyForFiling([g])).toEqual([{ kind: 'group', subtask: g }])
  })

  it('a subtask with parentGroupId classifies as "member", carrying the group\'s title', () => {
    const g = sub({ id: 'g1', title: 'Group A', isGroup: true })
    const m = sub({ id: 'm1', title: 'Member one', parentGroupId: 'g1' })
    expect(classifyForFiling([g, m])).toEqual([
      { kind: 'group', subtask: g },
      { kind: 'member', subtask: m, groupTitle: 'Group A' },
    ])
  })

  it('a member whose group is not in the given list still classifies as "member", with an undefined title', () => {
    const m = sub({ id: 'm1', title: 'Orphaned member', parentGroupId: 'gone' })
    expect(classifyForFiling([m])).toEqual([{ kind: 'member', subtask: m, groupTitle: undefined }])
  })

  it('preserves input order and length — it labels rows, it never drops or reorders them', () => {
    const a = sub({ id: 'a', title: 'A' })
    const g = sub({ id: 'g', title: 'G', isGroup: true })
    const m = sub({ id: 'm', title: 'M', parentGroupId: 'g' })
    const rows = classifyForFiling([a, g, m])
    expect(rows.map(r => r.subtask.id)).toEqual(['a', 'g', 'm'])
  })

  it('an inconsistent record (both isGroup and parentGroupId set) reads as a group, never silently dropped', () => {
    const broken = sub({ id: 'x', title: 'Broken', isGroup: true, parentGroupId: 'g1' })
    expect(classifyForFiling([broken])).toEqual([{ kind: 'group', subtask: broken }])
  })

  it('an empty list yields an empty list', () => {
    expect(classifyForFiling([])).toEqual([])
  })
})

describe('isPickable', () => {
  it('a loose subtask is pickable', () => {
    expect(isPickable({ kind: 'subtask' })).toBe(true)
  })

  it('a group is pickable — a valid session target exactly like a loose subtask', () => {
    expect(isPickable({ kind: 'group' })).toBe(true)
  })

  it('a group member is never pickable — filing on it is always refused server-side', () => {
    expect(isPickable({ kind: 'member' })).toBe(false)
  })
})
