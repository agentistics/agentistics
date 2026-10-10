import { describe, expect, test } from 'bun:test'
import { groupOp, groupStatus, listGroups, type FleetRowForGroups, type GroupsDeps } from './session-groups-web'
import type { Preferences, PreferencesMutator } from '../preferences'

const ROWS: FleetRowForGroups[] = [
  { id: 'agentop-aaa111', conversationId: 'conv-1', title: 'Fix login', state: 'working', harness: 'claude' },
  { id: 'agentop-bbb222', title: 'Refactor', state: 'waiting', harness: 'codex' },
]

/** An in-memory preferences store that applies a mutator exactly the way the real chain does. */
function fakeDeps(initial: Preferences = {}, rows: readonly FleetRowForGroups[] = ROWS) {
  let prefs: Preferences = initial
  const deps: GroupsDeps = {
    rows: async () => rows,
    read: async () => prefs,
    update: async (mutate: PreferencesMutator) => {
      const patch = mutate(prefs)
      if (patch !== undefined) prefs = { ...prefs, ...patch }
      return prefs
    },
  }
  return { deps, get: () => prefs }
}

describe('groupOp — create and file', () => {
  test('creates a group and files sessions given by title, id prefix or conversation id', async () => {
    const { deps, get } = fakeDeps()
    const out = await groupOp({ op: 'create', name: 'Later', sessions: ['fix login', 'agentop-bbb'] }, deps)
    expect(out.ok).toBe(true)
    // The identity key is the conversation when there is one, the managed id otherwise.
    expect(get().sessionGroups!.groups[0]!.sessionKeys).toEqual(['conv-1', 'agentop-bbb222'])
    if (out.ok) expect(out.group!.sessions.map(s => s.title)).toEqual(['Fix login', 'Refactor'])
  })

  test('a session that resolves to nothing refuses the whole create and writes nothing', async () => {
    const { deps, get } = fakeDeps()
    const out = await groupOp({ op: 'create', name: 'Later', sessions: ['fix login', 'nope'] }, deps)
    expect(out).toMatchObject({ ok: false, code: 'no_such_session' })
    expect(get().sessionGroups).toBeUndefined()
  })

  test('adding to a group by NAME moves the session out of its other group and unpins it', async () => {
    const { deps, get } = fakeDeps({
      sessionGroups: { groups: [{ id: 'a', name: 'A', sessionKeys: ['conv-1'] }, { id: 'b', name: 'Bee', sessionKeys: [] }] },
      pinnedSessions: ['conv-1', 'other'],
    })
    const out = await groupOp({ op: 'add', group: 'bee', session: 'agentop-aaa111' }, deps)
    expect(out.ok).toBe(true)
    expect(get().sessionGroups!.groups.find(g => g.id === 'a')!.sessionKeys).toEqual([])
    expect(get().sessionGroups!.groups.find(g => g.id === 'b')!.sessionKeys).toEqual(['conv-1'])
    expect(get().pinnedSessions).toEqual(['other'])
  })
})

describe('groupOp — refusals are specific and write nothing', () => {
  test('blank name, unknown group, ambiguous group', async () => {
    const { deps, get } = fakeDeps({ sessionGroups: { groups: [{ id: 'a', name: 'X', sessionKeys: [] }, { id: 'b', name: 'x', sessionKeys: [] }] } })
    expect(await groupOp({ op: 'create', name: '  ' }, deps)).toMatchObject({ ok: false, code: 'blank_name' })
    expect(await groupOp({ op: 'add', group: 'zzz', session: 'refactor' }, deps)).toMatchObject({ ok: false, code: 'no_such_group' })
    expect(await groupOp({ op: 'delete', group: 'x' }, deps)).toMatchObject({ ok: false, code: 'ambiguous_group', matches: ['a', 'b'] })
    expect(get().sessionGroups!.groups).toHaveLength(2)
  })

  test('missing arguments are named as such', async () => {
    const { deps } = fakeDeps()
    expect(await groupOp({ op: 'add', group: 'A' }, deps)).toMatchObject({ ok: false, code: 'missing_argument' })
    expect(await groupOp({ op: 'delete' }, deps)).toMatchObject({ ok: false, code: 'missing_argument' })
  })

  test('the HTTP status says what kind of refusal it was', () => {
    expect(groupStatus({ ok: true, message: '' })).toBe(200)
    expect(groupStatus({ ok: false, code: 'no_such_group', message: '' })).toBe(404)
    expect(groupStatus({ ok: false, code: 'no_such_session', message: '' })).toBe(404)
    expect(groupStatus({ ok: false, code: 'ambiguous_session', message: '' })).toBe(409)
    expect(groupStatus({ ok: false, code: 'blank_name', message: '' })).toBe(400)
  })
})

describe('groupOp — rename, remove, delete', () => {
  test('rename, ungroup and delete', async () => {
    const { deps, get } = fakeDeps({ sessionGroups: { groups: [{ id: 'a', name: 'Old', sessionKeys: ['conv-1'] }] } })
    expect(await groupOp({ op: 'rename', group: 'old', name: 'New' }, deps)).toMatchObject({ ok: true })
    expect(get().sessionGroups!.groups[0]!.name).toBe('New')
    expect(await groupOp({ op: 'remove', session: 'fix login' }, deps)).toMatchObject({ ok: true })
    expect(get().sessionGroups!.groups[0]!.sessionKeys).toEqual([])
    expect(await groupOp({ op: 'delete', group: 'New' }, deps)).toMatchObject({ ok: true, deleted: true })
    expect(get().sessionGroups!.groups).toEqual([])
  })

  test('a session that is gone can still be taken out by its key', async () => {
    const { deps, get } = fakeDeps({ sessionGroups: { groups: [{ id: 'a', name: 'A', sessionKeys: ['gone-conv'] }] } })
    expect(await groupOp({ op: 'remove', session: 'gone-conv' }, deps)).toMatchObject({ ok: true })
    expect(get().sessionGroups!.groups[0]!.sessionKeys).toEqual([])
  })
})

describe('groupOp — nest (folder inside a folder, one level)', () => {
  test('nests a folder under another, resolved by name on both sides', async () => {
    const { deps, get } = fakeDeps({
      sessionGroups: { groups: [{ id: 'a', name: 'Work', sessionKeys: [] }, { id: 'b', name: 'Sub', sessionKeys: [] }] },
    })
    const out = await groupOp({ op: 'nest', group: 'sub', parent: 'work' }, deps)
    expect(out).toMatchObject({ ok: true, message: 'Folder nested.' })
    expect(get().sessionGroups!.groups.find(g => g.id === 'b')).toMatchObject({ parentId: 'a' })
  })

  test('parent: null moves a folder back to the top level', async () => {
    const { deps, get } = fakeDeps({
      sessionGroups: { groups: [{ id: 'a', name: 'Work', sessionKeys: [] }, { id: 'b', name: 'Sub', sessionKeys: [], parentId: 'a' }] },
    })
    const out = await groupOp({ op: 'nest', group: 'b', parent: null }, deps)
    expect(out).toMatchObject({ ok: true, message: 'Folder moved to the top level.' })
    expect(get().sessionGroups!.groups.find(g => g.id === 'b')!.parentId).toBeUndefined()
  })

  test('a folder that already has a child cannot be tucked inside another', async () => {
    const { deps, get } = fakeDeps({
      sessionGroups: {
        groups: [
          { id: 'a', name: 'Work', sessionKeys: [] },
          { id: 'b', name: 'Other', sessionKeys: [] },
          { id: 'c', name: 'Sub', sessionKeys: [], parentId: 'a' },
        ],
      },
    })
    const out = await groupOp({ op: 'nest', group: 'a', parent: 'b' }, deps)
    expect(out).toMatchObject({ ok: false, code: 'source_has_children' })
    expect(groupStatus(out)).toBe(400)
    // Refused writes nothing.
    expect(get().sessionGroups!.groups.find(g => g.id === 'a')!.parentId).toBeUndefined()
  })

  test('a folder already nested cannot become a parent', async () => {
    const { deps } = fakeDeps({
      sessionGroups: {
        groups: [
          { id: 'a', name: 'Work', sessionKeys: [] },
          { id: 'b', name: 'Sub', sessionKeys: [], parentId: 'a' },
          { id: 'c', name: 'Other', sessionKeys: [] },
        ],
      },
    })
    expect(await groupOp({ op: 'nest', group: 'c', parent: 'b' }, deps)).toMatchObject({ ok: false, code: 'target_is_nested' })
  })

  test('the parent key must be present, even as null — omitting it is a missing argument', async () => {
    const { deps } = fakeDeps({ sessionGroups: { groups: [{ id: 'a', name: 'Work', sessionKeys: [] }] } })
    expect(await groupOp({ op: 'nest', group: 'a' }, deps)).toMatchObject({ ok: false, code: 'missing_argument' })
  })

  test('deleting a parent promotes its child to the top level', async () => {
    const { deps, get } = fakeDeps({
      sessionGroups: {
        groups: [
          { id: 'a', name: 'Work', sessionKeys: [] },
          { id: 'b', name: 'Sub', sessionKeys: ['conv-1'], parentId: 'a' },
        ],
      },
    })
    expect(await groupOp({ op: 'delete', group: 'work' }, deps)).toMatchObject({ ok: true, deleted: true })
    expect(get().sessionGroups!.groups).toEqual([{ id: 'b', name: 'Sub', sessionKeys: ['conv-1'] }])
  })
})

describe('listGroups', () => {
  test('names the members that are on the fleet and leaves the ones that are gone as bare keys', async () => {
    const { deps } = fakeDeps({ sessionGroups: { groups: [{ id: 'a', name: 'A', sessionKeys: ['conv-1', 'gone'] }] } })
    const out = await listGroups(deps)
    expect(out.groups[0]!.sessions).toEqual([
      { key: 'conv-1', id: 'agentop-aaa111', title: 'Fix login', state: 'working', harness: 'claude' },
      { key: 'gone' },
    ])
  })
})

test('delete with cascade removes the sub-folders too', async () => {
  const { planGroupOp } = await import('@agentistics/core')
  const g = { groups: [{ id: 'p', name: 'P', keys: [] }, { id: 'c', name: 'C', keys: [], parentId: 'p' }] } as never
  const r = planGroupOp(g, [], { type: 'delete', group: 'P', cascade: true })
  expect(r.ok && r.groups.groups).toEqual([])
})
