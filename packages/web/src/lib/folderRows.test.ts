import { describe, expect, test } from 'bun:test'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { splitFolderRows } from './folderRows'

const s = (id: string, title: string, state: string, startedAt: number) =>
  ({ id, title, state, startedAt, project: 'p', projectGroup: 'p' }) as unknown as ControlSession
const live = (x: ControlSession) => x.state === 'working'

describe('splitFolderRows', () => {
  const rows = [s('1', 'b', 'exited', 1), s('2', 'a', 'working', 2), s('3', 'c', 'exited', 3), s('4', 'z', 'working', 4)]
  test('live first block, ended second', () => {
    const r = splitFolderRows(rows, live, { by: 'name', dir: 'desc' })
    expect(r.live.map(x => x.id)).toEqual(['2', '4'])
    expect(r.ended.map(x => x.id)).toEqual(['1', '3'])
  })
  test('sort applies inside both blocks and reverses', () => {
    const r = splitFolderRows(rows, live, { by: 'name', dir: 'asc' })
    expect(r.live.map(x => x.id)).toEqual(['4', '2'])
    expect(r.ended.map(x => x.id)).toEqual(['3', '1'])
  })
  test('start date sort', () => {
    const r = splitFolderRows(rows, live, { by: 'started', dir: 'desc' })
    expect(r.ended.map(x => x.id)).toEqual(['3', '1'])
  })
  test('without an explicit sort the folder keeps its drag order', () => {
    const r = splitFolderRows(rows, live, { by: 'name', dir: 'asc' }, false)
    expect(r.live.map(x => x.id)).toEqual(['2', '4'])
    expect(r.ended.map(x => x.id)).toEqual(['1', '3'])
  })
})

import { endedAutoOpen } from './folderRows'
describe('endedAutoOpen', () => {
  const e1 = s('1', 'a', 'exited', 1), e2 = s('2', 'b', 'exited', 2)
  test('no search never auto-opens', () => expect(endedAutoOpen(false, [e1], [e1])).toBe(false))
  test('search with a matching ended row opens', () => expect(endedAutoOpen(true, [e1, e2], [e2])).toBe(true))
  test('search where no ended row matches (dimmed folder opened) stays closed', () => expect(endedAutoOpen(true, [e1, e2], [])).toBe(false))
})

import { activeFolderIds, isFolderSessionActive } from './folderRows'

describe('folder activity before filters', () => {
  const folder = (id: string, state?: ControlSession['state'], parentId?: string, hidden = false) => ({
    group: { id, ...(parentId ? { parentId } : {}), hidden }, rows: state ? [{ state }] : [],
  })
  test.each(['working', 'waiting', 'waiting-approval'] as const)('%s keeps the folder and its parent visible', state => {
    const entries = [folder('parent'), folder('live-child', state, 'parent'), folder('ended-child', 'exited', 'parent')]
    expect([...activeFolderIds(entries)].sort()).toEqual(['live-child', 'parent'])
  })
  test('ended, lost, unknown and empty folders have no activity', () => {
    for (const state of ['exited', 'closed', 'lost', 'unknown'] as const) {
      expect(isFolderSessionActive({ state })).toBe(false)
      expect(activeFolderIds([folder('parent'), folder('child', state, 'parent')]).size).toBe(0)
    }
    expect(activeFolderIds([folder('empty')]).size).toBe(0)
  })
  test('a hidden subtree cannot keep an empty visible parent active', () => {
    expect(activeFolderIds([folder('parent'), folder('child', 'working', 'parent', true)]).size).toBe(0)
    expect(activeFolderIds([folder('parent', undefined, undefined, true), folder('child', 'working', 'parent')]).size).toBe(0)
  })
  test('a live update brings the complete folder path back without changing membership or order', () => {
    const entries = [folder('idle', 'exited'), folder('parent'), folder('child', 'closed', 'parent'), folder('other', 'working')]
    expect(entries.filter(e => activeFolderIds(entries).has(e.group.id)).map(e => e.group.id)).toEqual(['other'])
    const resumed = entries.map(e => e.group.id === 'child' ? { ...e, rows: [{ state: 'waiting' as const }] } : e)
    expect(resumed.filter(e => activeFolderIds(resumed).has(e.group.id)).map(e => e.group.id)).toEqual(['parent', 'child', 'other'])
    expect(entries[2]!.group.parentId).toBe('parent')
  })
  test('an invalid parent cycle terminates without dropping active content', () => {
    expect([...activeFolderIds([folder('a', 'working', 'b'), folder('b', undefined, 'a')])].sort()).toEqual(['a', 'b'])
  })
})
