import { describe, expect, test } from 'bun:test'
import {
  isNayCwd, planNayFiling, planNayPlacement, ensureNayFolders,
  NAY_GROUP_NAME, NAY_ACTIVE_FOLDER, NAY_INACTIVE_FOLDER,
} from './nay'
import { groupOfSession, type SessionUserGroupsValue } from './sessionGroups'

describe('isNayCwd', () => {
  test('Nay\'s own directory, with or without a trailing slash or Windows separators', () => {
    expect(isNayCwd('/home/u/.agentistics/nay-chat')).toBe(true)
    expect(isNayCwd('/home/u/.agentistics/nay-chat/')).toBe(true)
    expect(isNayCwd('C:\\Users\\u\\.agentistics\\nay-chat')).toBe(true)
  })
  test('anything else is not Nay, including a folder that merely contains the name', () => {
    expect(isNayCwd('/home/u/projects/nay-chat')).toBe(false)
    expect(isNayCwd('/home/u/.agentistics/nay-chat/sub')).toBe(false)
    expect(isNayCwd('')).toBe(false)
    expect(isNayCwd(undefined)).toBe(false)
  })
})

const named = (v: SessionUserGroupsValue, key: string) => {
  const g = groupOfSession(v, key)
  const parent = g?.parentId ? v.groups.find(x => x.id === g.parentId) : undefined
  return g ? `${parent ? parent.name + '/' : ''}${g.name}` : null
}

describe('ensureNayFolders', () => {
  test('creates Nay with Ativas and Inativas nested inside, Ativas first', () => {
    const f = ensureNayFolders({ groups: [] })
    const [parent, ...kids] = f.groups.groups
    expect(parent!.name).toBe(NAY_GROUP_NAME)
    expect(parent!.parentId).toBeUndefined()
    expect(kids.map(k => [k.name, k.parentId])).toEqual([[NAY_ACTIVE_FOLDER, parent!.id], [NAY_INACTIVE_FOLDER, parent!.id]])
  })
  test('is idempotent: a second run returns the very same value', () => {
    const f = ensureNayFolders({ groups: [] })
    expect(ensureNayFolders(f.groups).groups).toBe(f.groups)
  })
  test('adopts an existing top-level "Nay" and only adds the missing child', () => {
    const v: SessionUserGroupsValue = { groups: [{ id: 'n', name: 'nay', sessionKeys: ['old'] }, { id: 'a', name: 'Ativas', sessionKeys: [], parentId: 'n' }] }
    const f = ensureNayFolders(v)
    expect(f.parentId).toBe('n')
    expect(f.activeId).toBe('a')
    expect(f.groups.groups.filter(g => g.parentId === 'n').map(g => g.name).sort()).toEqual(['Ativas', 'Inativas'])
  })
  test('an "Ativas" folder under another parent is not Nay\'s', () => {
    const v: SessionUserGroupsValue = { groups: [{ id: 'x', name: 'Work', sessionKeys: [] }, { id: 'a', name: 'Ativas', sessionKeys: [], parentId: 'x' }] }
    expect(ensureNayFolders(v).activeId).not.toBe('a')
  })
})

describe('planNayPlacement', () => {
  test('a running conversation goes to Ativas, an ended one to Inativas', () => {
    const p = planNayPlacement({ groups: [] }, [], [{ key: 'on', running: true }, { key: 'off', running: false }])
    expect(named(p.groups, 'on')).toBe('Nay/Ativas')
    expect(named(p.groups, 'off')).toBe('Nay/Inativas')
    expect(p.changed).toBe(true)
  })
  test('ending MOVES it: it leaves Ativas, and is never in two folders', () => {
    const first = planNayPlacement({ groups: [] }, [], [{ key: 'c', running: true }])
    const ended = planNayPlacement(first.groups, first.pins, [{ key: 'c', running: false }])
    expect(named(ended.groups, 'c')).toBe('Nay/Inativas')
    expect(ended.groups.groups.filter(g => g.sessionKeys.includes('c'))).toHaveLength(1)
  })
  test('nothing to do is reported as unchanged, with the same value back', () => {
    const first = planNayPlacement({ groups: [] }, [], [{ key: 'c', running: true }])
    const again = planNayPlacement(first.groups, first.pins, [{ key: 'c', running: true }])
    expect(again.changed).toBe(false)
    expect(again.groups).toBe(first.groups)
  })
  test('migrates a conversation filed directly under the old flat "Nay" group, and unpins it', () => {
    const v: SessionUserGroupsValue = { groups: [{ id: 'n', name: 'Nay', sessionKeys: ['c1', 'c2'] }] }
    const p = planNayPlacement(v, ['c2'], [{ key: 'c1', running: true }, { key: 'c2', running: false }])
    expect(named(p.groups, 'c1')).toBe('Nay/Ativas')
    expect(named(p.groups, 'c2')).toBe('Nay/Inativas')
    expect(p.groups.groups.find(g => g.id === 'n')!.sessionKeys).toEqual([])
    expect(p.pins).toEqual([])
  })
  test('never touches a session that is not a Nay row', () => {
    const v: SessionUserGroupsValue = { groups: [{ id: 'w', name: 'Work', sessionKeys: ['other'] }] }
    const p = planNayPlacement(v, [], [{ key: 'c', running: true }])
    expect(named(p.groups, 'other')).toBe('Work')
  })
})

describe('planNayFiling', () => {
  test('files a new session under Nay/Ativas, creating the folders the first time', () => {
    const plan = planNayFiling({ groups: [] }, [], 'conv-1')
    if (!plan.ok) throw new Error('refused')
    expect(named(plan.groups, 'conv-1')).toBe('Nay/Ativas')
  })
  test('a second session joins the same folder, never a second tree', () => {
    const first = planNayFiling({ groups: [] }, [], 'conv-1')
    if (!first.ok) throw new Error('first')
    const second = planNayFiling(first.groups, first.pins, 'conv-2')
    if (!second.ok) throw new Error('second')
    expect(second.groups.groups).toHaveLength(3)
    expect(named(second.groups, 'conv-2')).toBe('Nay/Ativas')
  })
})
