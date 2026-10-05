import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dropEmpty, emptyColumns } from './emptyGroups'
import { DEFAULT_PREFS, parseBoardPrefs } from './boardPrefs'
import { boardCopy } from './copy'

const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8')

describe('dropEmpty — a view choice, never a destructive one', () => {
  const groups = [{ k: 'todo', n: 3 }, { k: 'doing', n: 0 }, { k: 'done', n: 1 }]
  test('"show all" keeps every group, in order', () => expect(dropEmpty(groups, g => g.n, false).map(g => g.k)).toEqual(['todo', 'doing', 'done']))
  test('"hide empty" drops only the groups with nothing, keeping the order of the rest', () => expect(dropEmpty(groups, g => g.n, true).map(g => g.k)).toEqual(['todo', 'done']))
  test('it returns a new list and never touches the one it was given', () => {
    const before = [...groups]
    dropEmpty(groups, g => g.n, true)
    expect(groups).toEqual(before)
  })
})

describe('emptyColumns on the board', () => {
  const lanes = [
    { columns: [{ status: 'todo', rows: [1] }, { status: 'doing', rows: [] }, { status: 'done', rows: [] }] },
    { columns: [{ status: 'todo', rows: [] }, { status: 'doing', rows: [] }, { status: 'done', rows: [2] }] },
  ]
  test('a column is empty only when EVERY swimlane is empty in it', () => {
    expect([...emptyColumns(lanes, ['todo', 'doing', 'done'])]).toEqual(['doing'])
  })
})

describe('the setting', () => {
  test('defaults to showing everything and survives a round trip; anything else reads as off', () => {
    expect(DEFAULT_PREFS.hideEmpty).toBe(false)
    expect(parseBoardPrefs({ hideEmpty: true }).hideEmpty).toBe(true)
    expect(parseBoardPrefs({ hideEmpty: 'yes' }).hideEmpty).toBe(false)
    expect(parseBoardPrefs({}).hideEmpty).toBe(false)
  })
  test('both languages say Show all / Hide empty groups', () => {
    expect(boardCopy('en').viewBar.showAll).toBe('Show all')
    expect(boardCopy('en').viewBar.hideEmpty).toBe('Hide empty groups')
    expect(boardCopy('pt').viewBar.hideEmpty).toBe('Ocultar grupos vazios')
  })
  test('it is offered in the board\'s view settings and the table\'s, and applied by both', () => {
    expect(src('BoardArrange.tsx')).toContain('<EmptyGroupsMenu')
    expect(src('TaskTable.tsx')).toContain('<EmptyGroupsMenu')
    expect(src('TaskTable.tsx')).toMatch(/dropEmpty\(/)
    expect(src('TaskBoard.tsx')).toContain('hiddenCols.has(col.status)')
    expect(readFileSync(join(import.meta.dir, '..', '..', 'pages', 'TasksPage.tsx'), 'utf8')).toContain('hideEmpty={hideEmpty}')
  })
})
