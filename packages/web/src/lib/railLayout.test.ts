import { describe, expect, test } from 'bun:test'
import { railFolderCounts, railLayout } from './railLayout'

const row = (id: string, state = 'working') => ({ id, state })
const keyOf = (r: { id: string }) => r.id

describe('railLayout — the collapsed rail keeps pins and folders', () => {
  const all = [row('a'), row('b', 'waiting'), row('c', 'closed'), row('d'), row('e', 'exited')]
  const groups = [
    { id: 'top', name: 'Harness', sessionKeys: ['c'] },
    { id: 'sub', name: 'Ativas', sessionKeys: ['b'], parentId: 'top' },
    { id: 'empty', name: 'Vazia', sessionKeys: [] },
  ]

  test('pinned first, then folders, then the loose rows — the aside order', () => {
    const items = railLayout({ rows: [row('a'), row('d')], allRows: all, pinnedKeys: ['d'], groups, keyOf })
    expect(items.map(i => i.kind === 'session' ? `${i.row.id}${i.pinned ? '*' : ''}` : `[${i.id}]`))
      .toEqual(['d*', '[top]', 'a'])
  })

  test('a folder folds its nested folders into sections, and counts what it contains', () => {
    const items = railLayout({ rows: [], allRows: all, pinnedKeys: [], groups, keyOf })
    const f = items.find(i => i.kind === 'folder')!
    if (f.kind !== 'folder') throw new Error('expected a folder')
    expect(f.sections.map(s => [s.name, s.rows.map(r => r.id)])).toEqual([['Harness', ['c']], ['Ativas', ['b']]])
    expect(f.counts).toEqual({ folders: 1, waiting: 1, active: 0, ended: 1 })
  })

  test('pins and folders survive the filter — they resolve against the whole fleet', () => {
    // `rows` is empty (everything filtered out) and the pinned and grouped sessions still draw.
    const items = railLayout({ rows: [], allRows: all, pinnedKeys: ['e'], groups, keyOf })
    expect(items.map(i => i.kind === 'session' ? i.row.id : i.id)).toEqual(['e', 'top'])
  })

  test('a pinned session in a folder shows once, pinned', () => {
    const items = railLayout({ rows: [], allRows: all, pinnedKeys: ['b'], groups, keyOf })
    const f = items.find(i => i.kind === 'folder')
    expect(f && f.kind === 'folder' ? f.sections.flatMap(s => s.rows.map(r => r.id)) : []).toEqual(['c'])
  })

  test('an empty folder draws nothing', () => {
    const items = railLayout({ rows: [], allRows: all, pinnedKeys: [], groups, keyOf })
    expect(items.some(i => i.kind === 'folder' && i.id === 'empty')).toBe(false)
  })
})

describe('railFolderCounts', () => {
  test('waiting, active and ended are three different facts', () => {
    expect(railFolderCounts([row('1', 'waiting-approval'), row('2', 'working'), row('3', 'unknown'), row('4', 'lost')], 2))
      .toEqual({ folders: 2, waiting: 1, active: 2, ended: 1 })
  })
})
