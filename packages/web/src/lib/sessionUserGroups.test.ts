import { describe, expect, it, test } from 'bun:test'
import { folderCountLabel, folderSessionCount, listNarrowed } from './sessionUserGroups'
import {
  type SessionUserGroupsValue,
  canNestGroup, groupOfSession, planAddToGroup, planCreateGroup, planDeleteGroup, planMoveToGroup,
  planNestGroup, planRemoveFromGroup, planReorderGroups, planReorderInGroup, planRenameGroup,
  planStepGroup, resolveGroupRows,
} from './sessionUserGroups'

const empty: SessionUserGroupsValue = { groups: [] }
const withOne: SessionUserGroupsValue = {
  groups: [{ id: 'g1', name: 'Saved to later', sessionKeys: ['a', 'b'] }],
}

describe('planCreateGroup', () => {
  it('creates a group with the trimmed name, empty', () => {
    const { next, id } = planCreateGroup(empty, '  Saved to later  ')
    expect(id).not.toBeNull()
    expect(next.groups).toEqual([{ id: id!, name: 'Saved to later', sessionKeys: [] }])
  })

  it('refuses a blank name (empty or whitespace-only), leaving the value unchanged', () => {
    expect(planCreateGroup(empty, '')).toEqual({ next: empty, id: null })
    expect(planCreateGroup(empty, '   ')).toEqual({ next: empty, id: null })
  })

  it('appends after existing groups', () => {
    const { next } = planCreateGroup(withOne, 'Second')
    expect(next.groups.map(g => g.name)).toEqual(['Saved to later', 'Second'])
  })

  it('allows a duplicate name — groups are addressed by id, never by name', () => {
    const { next, id } = planCreateGroup(withOne, 'Saved to later')
    expect(id).not.toBeNull()
    expect(next.groups.filter(g => g.name === 'Saved to later')).toHaveLength(2)
  })

  it('two creations mint distinct ids', () => {
    const a = planCreateGroup(empty, 'A')
    const b = planCreateGroup(a.next, 'B')
    expect(a.id).not.toBe(b.id)
  })
})

describe('planRenameGroup', () => {
  it('renames, trimmed', () => {
    expect(planRenameGroup(withOne, 'g1', '  Later  ').groups[0]!.name).toBe('Later')
  })

  it('refuses a blank name', () => {
    expect(planRenameGroup(withOne, 'g1', '   ')).toEqual(withOne)
  })

  it('a missing id is a no-op', () => {
    expect(planRenameGroup(withOne, 'ghost', 'X')).toEqual(withOne)
  })

  it('never touches sessionKeys', () => {
    expect(planRenameGroup(withOne, 'g1', 'Later').groups[0]!.sessionKeys).toEqual(['a', 'b'])
  })
})

describe('planDeleteGroup', () => {
  it('removes the group and nothing else', () => {
    const two: SessionUserGroupsValue = {
      groups: [...withOne.groups, { id: 'g2', name: 'Other', sessionKeys: ['c'] }],
    }
    expect(planDeleteGroup(two, 'g1')).toEqual({ groups: [{ id: 'g2', name: 'Other', sessionKeys: ['c'] }] })
  })

  it('a missing id is a no-op', () => {
    expect(planDeleteGroup(withOne, 'ghost')).toEqual(withOne)
  })

  it('promotes a child of the deleted group to the top level, sessions untouched', () => {
    const nested: SessionUserGroupsValue = {
      groups: [{ id: 'a', name: 'Parent', sessionKeys: [] }, { id: 'b', name: 'Child', sessionKeys: ['k'], parentId: 'a' }],
    }
    expect(planDeleteGroup(nested, 'a')).toEqual({ groups: [{ id: 'b', name: 'Child', sessionKeys: ['k'] }] })
  })
})

describe('canNestGroup / planNestGroup', () => {
  const twoTop: SessionUserGroupsValue = {
    groups: [{ id: 'a', name: 'A', sessionKeys: [] }, { id: 'b', name: 'B', sessionKeys: [] }],
  }

  it('nests one top-level group under another', () => {
    expect(canNestGroup(twoTop, 'b', 'a')).toEqual({ ok: true })
    const planned = planNestGroup(twoTop, 'b', 'a')
    expect(planned.ok && planned.next.groups.find(g => g.id === 'b')).toMatchObject({ parentId: 'a' })
  })

  it('refuses one level deeper, in both directions', () => {
    const nested: SessionUserGroupsValue = {
      groups: [{ id: 'a', name: 'A', sessionKeys: [] }, { id: 'b', name: 'B', sessionKeys: [], parentId: 'a' }, { id: 'c', name: 'C', sessionKeys: [] }],
    }
    // b already has a parent — it cannot also become one (c under b would be a grandchild of a).
    expect(canNestGroup(nested, 'c', 'b')).toEqual({ ok: false, code: 'target_is_nested' })
    // a already has a child (b) — a cannot itself be tucked under c.
    expect(canNestGroup(nested, 'a', 'c')).toEqual({ ok: false, code: 'source_has_children' })
  })

  it('`parentId: null` always un-nests, a no-op when already top-level', () => {
    const nested: SessionUserGroupsValue = {
      groups: [{ id: 'a', name: 'A', sessionKeys: [] }, { id: 'b', name: 'B', sessionKeys: [], parentId: 'a' }],
    }
    const unnested = planNestGroup(nested, 'b', null)
    expect(unnested.ok && unnested.next.groups.find(g => g.id === 'b')!.parentId).toBeUndefined()
    const alreadyTop = planNestGroup(twoTop, 'a', null)
    expect(alreadyTop.ok && alreadyTop.next).toEqual(twoTop)
  })
})

describe('groupOfSession', () => {
  it('finds the group holding a key', () => {
    expect(groupOfSession(withOne, 'a')?.id).toBe('g1')
  })

  it('is undefined for a key in no group', () => {
    expect(groupOfSession(withOne, 'z')).toBeUndefined()
  })
})

describe('planAddToGroup', () => {
  it('appends a new key to the target group', () => {
    expect(planAddToGroup(withOne, 'g1', 'c').groups[0]!.sessionKeys).toEqual(['a', 'b', 'c'])
  })

  it('MOVES a key already in another group — membership is exclusive', () => {
    const two: SessionUserGroupsValue = {
      groups: [...withOne.groups, { id: 'g2', name: 'Other', sessionKeys: ['c'] }],
    }
    const next = planAddToGroup(two, 'g1', 'c')
    expect(next.groups.find(g => g.id === 'g1')!.sessionKeys).toEqual(['a', 'b', 'c'])
    expect(next.groups.find(g => g.id === 'g2')!.sessionKeys).toEqual([])
  })

  it('dropping a key already in the target group is a no-op (position unchanged)', () => {
    expect(planAddToGroup(withOne, 'g1', 'a')).toEqual(withOne)
  })

  it('an unknown target group id is a no-op', () => {
    expect(planAddToGroup(withOne, 'ghost', 'z')).toEqual(withOne)
  })
})

describe('planRemoveFromGroup', () => {
  it('removes the key from whichever group holds it', () => {
    expect(planRemoveFromGroup(withOne, 'a').groups[0]!.sessionKeys).toEqual(['b'])
  })

  it('a key in no group is a no-op', () => {
    expect(planRemoveFromGroup(withOne, 'z')).toEqual(withOne)
  })
})

describe('planReorderInGroup', () => {
  it('reorders by key within the named group', () => {
    const three: SessionUserGroupsValue = { groups: [{ id: 'g1', name: 'X', sessionKeys: ['a', 'b', 'c'] }] }
    expect(planReorderInGroup(three, 'g1', 'a', 'c').groups[0]!.sessionKeys).toEqual(['b', 'a', 'c'])
  })

  it('never touches a different group', () => {
    const two: SessionUserGroupsValue = {
      groups: [{ id: 'g1', name: 'X', sessionKeys: ['a', 'b'] }, { id: 'g2', name: 'Y', sessionKeys: ['c', 'd'] }],
    }
    const next = planReorderInGroup(two, 'g1', 'a', 'b')
    expect(next.groups.find(g => g.id === 'g2')!.sessionKeys).toEqual(['c', 'd'])
  })
})

describe('planReorderGroups', () => {
  const three: SessionUserGroupsValue = {
    groups: [
      { id: 'g1', name: 'One', sessionKeys: ['a'] },
      { id: 'g2', name: 'Two', sessionKeys: ['b'] },
      { id: 'g3', name: 'Three', sessionKeys: ['c'] },
    ],
  }

  it('drags a group by id onto another, by id — never by index', () => {
    const next = planReorderGroups(three, 'g3', 'g1')
    expect(next.groups.map(g => g.id)).toEqual(['g3', 'g1', 'g2'])
  })

  it('never touches a group\'s own sessionKeys', () => {
    const next = planReorderGroups(three, 'g3', 'g1')
    expect(next.groups.find(g => g.id === 'g3')!.sessionKeys).toEqual(['c'])
  })

  it('dropping onto itself is a no-op', () => {
    expect(planReorderGroups(three, 'g2', 'g2').groups.map(g => g.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it('an unknown dropId is refused unchanged', () => {
    expect(planReorderGroups(three, 'g1', 'ghost').groups.map(g => g.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it('an unknown dragId is refused unchanged', () => {
    expect(planReorderGroups(three, 'ghost', 'g1').groups.map(g => g.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it('reorders a NESTED folder among its own siblings, leaving an interleaved unrelated top-level folder untouched', () => {
    // p is a top-level folder sitting BETWEEN two of P's own children in the raw array — exactly the
    // shape a real document reaches once folders have been nested and created over time. Dragging
    // child c2 before c1 must move only the two children, never p.
    const nested: SessionUserGroupsValue = {
      groups: [
        { id: 'P', name: 'Parent', sessionKeys: [] },
        { id: 'c1', name: 'Child 1', sessionKeys: [], parentId: 'P' },
        { id: 'p', name: 'Unrelated top-level', sessionKeys: [] },
        { id: 'c2', name: 'Child 2', sessionKeys: [], parentId: 'P' },
      ],
    }
    const next = planReorderGroups(nested, 'c2', 'c1')
    // c1 and c2 swap relative order (c2 now first); 'p' stays exactly where it was — the operation
    // never touched an id outside the sibling subset it was scoped to.
    expect(next.groups.map(g => g.id)).toEqual(['P', 'c2', 'p', 'c1'])
  })

  it('a drag between folders of DIFFERENT parents is refused unchanged, in both directions', () => {
    const nested: SessionUserGroupsValue = {
      groups: [
        { id: 'P', name: 'Parent', sessionKeys: [] },
        { id: 'child', name: 'Child', sessionKeys: [], parentId: 'P' },
        { id: 'other', name: 'Other top-level', sessionKeys: [] },
      ],
    }
    expect(planReorderGroups(nested, 'other', 'child')).toEqual(nested)
    expect(planReorderGroups(nested, 'child', 'other')).toEqual(nested)
  })
})

describe('planStepGroup', () => {
  const three: SessionUserGroupsValue = {
    groups: [
      { id: 'g1', name: 'One', sessionKeys: [] },
      { id: 'g2', name: 'Two', sessionKeys: [] },
      { id: 'g3', name: 'Three', sessionKeys: [] },
    ],
  }

  it('moves a group one place later', () => {
    expect(planStepGroup(three, 'g1', 1).groups.map(g => g.id)).toEqual(['g2', 'g1', 'g3'])
  })

  it('moves a group one place earlier', () => {
    expect(planStepGroup(three, 'g3', -1).groups.map(g => g.id)).toEqual(['g1', 'g3', 'g2'])
  })

  it('stepping the first group up (past the start) is a no-op', () => {
    expect(planStepGroup(three, 'g1', -1).groups.map(g => g.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it('stepping the last group down (past the end) is a no-op', () => {
    expect(planStepGroup(three, 'g3', 1).groups.map(g => g.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it('steps a NESTED folder among its own siblings only, past an interleaved unrelated top-level one', () => {
    const nested: SessionUserGroupsValue = {
      groups: [
        { id: 'P', name: 'Parent', sessionKeys: [] },
        { id: 'c1', name: 'Child 1', sessionKeys: [], parentId: 'P' },
        { id: 'p', name: 'Unrelated top-level', sessionKeys: [] },
        { id: 'c2', name: 'Child 2', sessionKeys: [], parentId: 'P' },
      ],
    }
    expect(planStepGroup(nested, 'c1', 1).groups.map(g => g.id)).toEqual(['P', 'c2', 'p', 'c1'])
  })

  it('a top-level folder\'s own step is scoped to top-level siblings, unaffected by a nested folder\'s child count', () => {
    const nested: SessionUserGroupsValue = {
      groups: [
        { id: 'P', name: 'Parent', sessionKeys: [] },
        { id: 'child', name: 'Child', sessionKeys: [], parentId: 'P' },
        { id: 'other', name: 'Other', sessionKeys: [] },
      ],
    }
    expect(planStepGroup(nested, 'P', 1).groups.map(g => g.id)).toEqual(['other', 'child', 'P'])
  })
})

describe('planMoveToGroup', () => {
  it('a PINNED session dropped into a group is added to it AND unpinned', () => {
    const { pins, groups } = planMoveToGroup(['a', 'z'], withOne, 'a', 'g1')
    expect(pins).toEqual(['z'])
    expect(groups.groups[0]!.sessionKeys).toEqual(['a', 'b'])
  })

  it('a NON-pinned session dropped into a group is added to it, pins untouched', () => {
    const { pins, groups } = planMoveToGroup(['z'], withOne, 'c', 'g1')
    expect(pins).toEqual(['z'])
    expect(groups.groups[0]!.sessionKeys).toEqual(['a', 'b', 'c'])
  })

  it('moving a session already in another group leaves pins unchanged and the membership exclusive', () => {
    const two: SessionUserGroupsValue = {
      groups: [...withOne.groups, { id: 'g2', name: 'Other', sessionKeys: ['c'] }],
    }
    const { pins, groups } = planMoveToGroup([], two, 'c', 'g1')
    expect(pins).toEqual([])
    expect(groups.groups.find(g => g.id === 'g1')!.sessionKeys).toEqual(['a', 'b', 'c'])
    expect(groups.groups.find(g => g.id === 'g2')!.sessionKeys).toEqual([])
  })

  it('a key not pinned at all is a no-op on the pinned list, order preserved', () => {
    const { pins } = planMoveToGroup(['x', 'y'], withOne, 'c', 'g1')
    expect(pins).toEqual(['x', 'y'])
  })
})

interface Row { id: string; state: string }
const keyOf = (r: Row) => r.id

describe('resolveGroupRows', () => {
  it('resolves regardless of state — a group is never filtered by what the session is doing', () => {
    const group = { id: 'g1', name: 'X', sessionKeys: ['a', 'b'] }
    const rows: Row[] = [{ id: 'a', state: 'working' }, { id: 'b', state: 'exited' }]
    expect(resolveGroupRows(group, rows, keyOf)).toEqual(rows)
  })

  it('keeps the group order, not row order', () => {
    const group = { id: 'g1', name: 'X', sessionKeys: ['b', 'a'] }
    const rows: Row[] = [{ id: 'a', state: 'working' }, { id: 'b', state: 'working' }]
    expect(resolveGroupRows(group, rows, keyOf).map(r => r.id)).toEqual(['b', 'a'])
  })

  it('hides an unresolvable key rather than inventing a row, and keeps every resolvable one', () => {
    const group = { id: 'g1', name: 'X', sessionKeys: ['a', 'gone'] }
    const rows: Row[] = [{ id: 'a', state: 'working' }]
    expect(resolveGroupRows(group, rows, keyOf).map(r => r.id)).toEqual(['a'])
  })

  it('is empty for an empty group or no rows', () => {
    expect(resolveGroupRows({ id: 'g1', name: 'X', sessionKeys: [] }, [{ id: 'a', state: 'working' }], keyOf)).toEqual([])
    expect(resolveGroupRows({ id: 'g1', name: 'X', sessionKeys: ['a'] }, [], keyOf)).toEqual([])
  })
})

describe('folderSessionCount — a container counts what it contains', () => {
  const resolved = [
    { group: { id: 'top' }, rows: [] },
    { group: { id: 'a', parentId: 'top' }, rows: [1, 2, 3, 4] },
    { group: { id: 'b', parentId: 'top' }, rows: [1, 2] },
    { group: { id: 'other' }, rows: [1] },
  ]
  test('a parent holding only subfolders counts their sessions (was 0)', () => {
    expect(folderSessionCount('top', resolved)).toBe(6)
  })
  test('a nested folder counts its own sessions', () => {
    expect(folderSessionCount('a', resolved)).toBe(4)
  })
  test('an unrelated folder is never counted', () => {
    expect(folderSessionCount('other', resolved)).toBe(1)
  })
})

describe('folders follow the list\'s filters', () => {
  test('narrowed, the header says how much of the folder matches', () => {
    expect(folderCountLabel(3, 61, true)).toBe('3/61')
    expect(folderCountLabel(0, 61, true)).toBe('0/61')
  })
  test('not narrowed, just the total', () => {
    expect(folderCountLabel(61, 61, false)).toBe('61')
  })
  test('active-only, a search or a value filter all narrow', () => {
    expect(listNarrowed({ activeOnly: true, query: '', valueFiltered: 10, total: 10 })).toBe(true)
    expect(listNarrowed({ activeOnly: false, query: 'líder', valueFiltered: 10, total: 10 })).toBe(true)
    expect(listNarrowed({ activeOnly: false, query: '  ', valueFiltered: 4, total: 10 })).toBe(true)
    expect(listNarrowed({ activeOnly: false, query: '', valueFiltered: 10, total: 10 })).toBe(false)
  })
})
