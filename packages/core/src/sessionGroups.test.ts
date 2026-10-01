import { describe, expect, test } from 'bun:test'
import {
  canNestGroup, planDeleteGroup, planGroupOp, planNestGroup, resolveGroupRef, resolveSessionForGroup,
  sessionIdentityKey, type SessionUserGroupsValue,
} from './sessionGroups'

const G = (groups: { id: string; name: string; sessionKeys?: string[]; parentId?: string }[]): SessionUserGroupsValue =>
  ({
    groups: groups.map(g => ({
      id: g.id, name: g.name, sessionKeys: g.sessionKeys ?? [],
      ...(g.parentId !== undefined ? { parentId: g.parentId } : {}),
    })),
  })

describe('sessionIdentityKey', () => {
  test('the conversation when there is one, the managed id otherwise', () => {
    expect(sessionIdentityKey({ id: 'agentop-1', conversationId: 'conv-1' })).toBe('conv-1')
    expect(sessionIdentityKey({ id: 'agentop-1' })).toBe('agentop-1')
  })
})

describe('resolveGroupRef', () => {
  const groups = G([{ id: 'g1', name: 'Later' }, { id: 'g2', name: 'Pelvie' }, { id: 'g3', name: 'pelvie' }])
  test('an id wins', () => expect(resolveGroupRef(groups, 'g1')).toMatchObject({ ok: true, group: { id: 'g1' } }))
  test('a name matches case-insensitively and trimmed', () =>
    expect(resolveGroupRef(groups, '  LATER ')).toMatchObject({ ok: true, group: { id: 'g1' } }))
  test('a name shared by two groups is refused, not guessed', () =>
    expect(resolveGroupRef(groups, 'pelvie')).toEqual({ ok: false, code: 'ambiguous_group', matches: ['g2', 'g3'] }))
  test('unknown and blank are no_such_group', () => {
    expect(resolveGroupRef(groups, 'nope')).toMatchObject({ ok: false, code: 'no_such_group' })
    expect(resolveGroupRef(groups, '   ')).toMatchObject({ ok: false, code: 'no_such_group' })
  })
})

describe('resolveSessionForGroup', () => {
  const rows = [
    { id: 'agentop-aaa111', conversationId: 'c-1111', title: 'Fix login' },
    { id: 'agentop-aaa222', conversationId: 'c-2222', title: 'Refactor' },
    { id: 'agentop-bbb333', title: 'Fix login' },
  ]
  test('exact managed id, then exact conversation id', () => {
    expect(resolveSessionForGroup(rows, 'agentop-aaa111')).toMatchObject({ ok: true, session: { id: 'agentop-aaa111' } })
    expect(resolveSessionForGroup(rows, 'c-2222')).toMatchObject({ ok: true, session: { id: 'agentop-aaa222' } })
  })
  test('a title shared by two sessions is ambiguous', () =>
    expect(resolveSessionForGroup(rows, 'fix login')).toEqual({ ok: false, code: 'ambiguous_session', matches: ['agentop-aaa111', 'agentop-bbb333'] }))
  test('a unique title or a unique id prefix resolves', () => {
    expect(resolveSessionForGroup(rows, 'refactor')).toMatchObject({ ok: true, session: { id: 'agentop-aaa222' } })
    expect(resolveSessionForGroup(rows, 'agentop-bbb')).toMatchObject({ ok: true, session: { id: 'agentop-bbb333' } })
  })
  test('an ambiguous prefix and an unknown ref are refused', () => {
    expect(resolveSessionForGroup(rows, 'agentop-aaa')).toMatchObject({ ok: false, code: 'ambiguous_session' })
    expect(resolveSessionForGroup(rows, 'zzz')).toEqual({ ok: false, code: 'no_such_session', matches: [] })
    expect(resolveSessionForGroup(rows, '')).toMatchObject({ ok: false, code: 'no_such_session' })
  })
})

describe('planGroupOp', () => {
  test('create makes a group, optionally with sessions already in it', () => {
    const out = planGroupOp(G([]), [], { type: 'create', name: '  Ideas ', keys: ['k1', 'k2'] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.groups.groups).toHaveLength(1)
    expect(out.groups.groups[0]).toMatchObject({ name: 'Ideas', sessionKeys: ['k1', 'k2'] })
    expect(out.id).toBe(out.groups.groups[0]!.id)
  })

  test('a blank name is refused, everywhere it can appear', () => {
    expect(planGroupOp(G([]), [], { type: 'create', name: '  ' })).toEqual({ ok: false, code: 'blank_name' })
    expect(planGroupOp(G([{ id: 'g', name: 'A' }]), [], { type: 'rename', group: 'g', name: '' })).toEqual({ ok: false, code: 'blank_name' })
  })

  test('add MOVES a session out of its other group and UNPINS it', () => {
    const groups = G([{ id: 'a', name: 'A', sessionKeys: ['k'] }, { id: 'b', name: 'B' }])
    const out = planGroupOp(groups, ['k', 'other'], { type: 'add', group: 'B', key: 'k' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.groups.groups.find(g => g.id === 'a')!.sessionKeys).toEqual([])
    expect(out.groups.groups.find(g => g.id === 'b')!.sessionKeys).toEqual(['k'])
    expect(out.pins).toEqual(['other'])
  })

  test('remove takes a session out of whichever group holds it and leaves the pins alone', () => {
    const groups = G([{ id: 'a', name: 'A', sessionKeys: ['k'] }])
    const out = planGroupOp(groups, ['p'], { type: 'remove', key: 'k' })
    expect(out.ok && out.groups.groups[0]!.sessionKeys).toEqual([])
    expect(out.ok && out.pins).toEqual(['p'])
  })

  test('delete drops the group and keeps the sessions (they only leave it)', () => {
    const out = planGroupOp(G([{ id: 'a', name: 'A', sessionKeys: ['k'] }]), [], { type: 'delete', group: 'a' })
    expect(out.ok && out.groups.groups).toEqual([])
  })

  test('an unknown or ambiguous group is a refusal that names the matches', () => {
    expect(planGroupOp(G([]), [], { type: 'add', group: 'nope', key: 'k' })).toMatchObject({ ok: false, code: 'no_such_group' })
    const dup = G([{ id: 'a', name: 'X' }, { id: 'b', name: 'x' }])
    expect(planGroupOp(dup, [], { type: 'delete', group: 'x' })).toEqual({ ok: false, code: 'ambiguous_group', matches: ['a', 'b'] })
  })

  test('nest moves a top-level group under another, resolved by name on both sides', () => {
    const out = planGroupOp(G([{ id: 'a', name: 'Work' }, { id: 'b', name: 'Sub' }]), [], { type: 'nest', group: 'sub', parent: 'work' })
    expect(out.ok).toBe(true)
    expect(out.ok && out.groups.groups.find(g => g.id === 'b')).toMatchObject({ parentId: 'a' })
  })

  test('nest with parent: null un-nests, always, even for an already top-level group', () => {
    const nested = G([{ id: 'a', name: 'Work' }, { id: 'b', name: 'Sub', parentId: 'a' }])
    const out = planGroupOp(nested, [], { type: 'nest', group: 'b', parent: null })
    expect(out.ok && out.groups.groups.find(g => g.id === 'b')!.parentId).toBeUndefined()
  })

  test('nest refuses an unknown group or parent by name, same as every other op', () => {
    expect(planGroupOp(G([{ id: 'a', name: 'Work' }]), [], { type: 'nest', group: 'nope', parent: 'work' }))
      .toMatchObject({ ok: false, code: 'no_such_group' })
    expect(planGroupOp(G([{ id: 'a', name: 'Work' }]), [], { type: 'nest', group: 'work', parent: 'nope' }))
      .toMatchObject({ ok: false, code: 'no_such_group' })
  })
})

describe('canNestGroup / planNestGroup — one level, never guessed away', () => {
  test('a plain top-level group can become a child of another top-level group', () => {
    const g = G([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
    expect(canNestGroup(g, 'b', 'a')).toEqual({ ok: true })
    const planned = planNestGroup(g, 'b', 'a')
    expect(planned.ok && planned.next.groups.find(x => x.id === 'b')).toMatchObject({ parentId: 'a' })
    // The parent itself is untouched — only the child record carries the relationship.
    expect(planned.ok && planned.next.groups.find(x => x.id === 'a')!.parentId).toBeUndefined()
  })

  test('a newly nested folder becomes the FIRST child of its new parent, ahead of existing siblings', () => {
    const g = G([
      { id: 'a', name: 'Parent' },
      { id: 'x', name: 'Other' },
      { id: 'b', name: 'Sibling 1', parentId: 'a' },
      { id: 'c', name: 'Sibling 2', parentId: 'a' },
    ])
    const planned = planNestGroup(g, 'x', 'a')
    expect(planned.ok && planned.next.groups.map(gr => gr.id)).toEqual(['a', 'x', 'b', 'c'])
  })

  test('the first-ever child of a parent lands right after it, not at the array tail', () => {
    const g = G([{ id: 'a', name: 'Parent' }, { id: 'x', name: 'Other' }, { id: 'y', name: 'Third' }])
    const planned = planNestGroup(g, 'y', 'a')
    expect(planned.ok && planned.next.groups.map(gr => gr.id)).toEqual(['a', 'y', 'x'])
  })

  test('a folder cannot be moved into itself', () => {
    const g = G([{ id: 'a', name: 'A' }])
    expect(canNestGroup(g, 'a', 'a')).toEqual({ ok: false, code: 'self' })
  })

  test('a group that already has a child cannot be tucked inside another (the source has children)', () => {
    const g = G([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C', parentId: 'a' }])
    // a already parents c; nesting a under b would leave c two levels deep.
    expect(canNestGroup(g, 'a', 'b')).toEqual({ ok: false, code: 'source_has_children' })
    expect(planNestGroup(g, 'a', 'b')).toEqual({ ok: false, code: 'source_has_children' })
  })

  test('a folder that is itself nested cannot become a parent (the target is already nested)', () => {
    const g = G([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C' }])
    // b is already a's child; nesting c under b would make c a grandchild of a.
    expect(canNestGroup(g, 'c', 'b')).toEqual({ ok: false, code: 'target_is_nested' })
    expect(planNestGroup(g, 'c', 'b')).toEqual({ ok: false, code: 'target_is_nested' })
  })

  test('nesting under, or moving, an id that does not exist is refused, never invented', () => {
    const g = G([{ id: 'a', name: 'A' }])
    expect(canNestGroup(g, 'a', 'ghost')).toEqual({ ok: false, code: 'no_such_group' })
    expect(canNestGroup(g, 'ghost', 'a')).toEqual({ ok: false, code: 'no_such_group' })
  })

  test('parentId: null always moves a group back to the top level, and is a no-op if it already is', () => {
    const g = G([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }])
    const planned = planNestGroup(g, 'b', null)
    expect(planned.ok && planned.next.groups.find(x => x.id === 'b')!.parentId).toBeUndefined()
    const alreadyTop = planNestGroup(g, 'a', null)
    expect(alreadyTop.ok && alreadyTop.next.groups.find(x => x.id === 'a')!.parentId).toBeUndefined()
  })
})

describe('planDeleteGroup — a deleted parent promotes its children, never deletes them', () => {
  test('a child of the deleted group moves to the top level, its sessions untouched', () => {
    const g = G([
      { id: 'a', name: 'Parent' },
      { id: 'b', name: 'Child', parentId: 'a', sessionKeys: ['k1'] },
      { id: 'c', name: 'Unrelated' },
    ])
    const next = planDeleteGroup(g, 'a')
    expect(next.groups.map(x => x.id)).toEqual(['b', 'c'])
    const child = next.groups.find(x => x.id === 'b')!
    expect(child.parentId).toBeUndefined()
    expect(child.sessionKeys).toEqual(['k1'])
  })

  test('deleting a group with no children behaves exactly as before', () => {
    const g = G([{ id: 'a', name: 'A', sessionKeys: ['k'] }])
    expect(planDeleteGroup(g, 'a')).toEqual({ groups: [] })
  })
})

import { groupConcealed, hiddenGroups, planSetGroupHidden, planDeleteGroup as planDeleteGroupH, planRenameGroup as planRenameGroupH } from './sessionGroups'

describe('hiding a folder', () => {
  const base = {
    groups: [
      { id: 'nay', name: 'Nay', sessionKeys: [] },
      { id: 'nay-a', name: 'Ativas', sessionKeys: ['k1'], parentId: 'nay' },
      { id: 'x', name: 'X', sessionKeys: ['k2'] },
    ],
  }
  test('hides any folder, the Nay folder included, and keeps its sessions', () => {
    const next = planSetGroupHidden(base, 'nay', true)
    expect(next.groups[0]!.hidden).toBe(true)
    expect(next.groups[1]!.sessionKeys).toEqual(['k1'])
    expect(hiddenGroups(next).map(g => g.id)).toEqual(['nay'])
  })
  test('a child is concealed with its hidden parent; a sibling is not', () => {
    const next = planSetGroupHidden(base, 'nay', true)
    expect(groupConcealed(next, 'nay-a')).toBe(true)
    expect(groupConcealed(next, 'x')).toBe(false)
  })
  test('showing removes the key, so a shown folder reads like one never hidden', () => {
    const shown = planSetGroupHidden(planSetGroupHidden(base, 'x', true), 'x', false)
    expect('hidden' in shown.groups[2]!).toBe(false)
  })
  test('no-ops return the same value (no write)', () => {
    expect(planSetGroupHidden(base, 'x', false)).toBe(base)
    expect(planSetGroupHidden(base, 'missing', true)).toBe(base)
  })
  test('the flag survives other edits to the folder', () => {
    const hidden = planSetGroupHidden(base, 'x', true)
    expect(planRenameGroupH(hidden, 'x', 'Y').groups[2]!.hidden).toBe(true)
    expect(planDeleteGroupH(hidden, 'nay').groups.find(g => g.id === 'x')!.hidden).toBe(true)
  })
})
