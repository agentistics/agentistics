import { describe, expect, test } from 'bun:test'
import {
  planGroupOp, resolveGroupRef, resolveSessionForGroup, sessionIdentityKey,
  type SessionUserGroupsValue,
} from './sessionGroups'

const G = (groups: { id: string; name: string; sessionKeys?: string[] }[]): SessionUserGroupsValue =>
  ({ groups: groups.map(g => ({ id: g.id, name: g.name, sessionKeys: g.sessionKeys ?? [] })) })

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
})
