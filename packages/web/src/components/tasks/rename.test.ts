import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import { planRename, renameKey, TITLE_MAX } from './renameTitle'
import { RenameInput } from './RenameInput'
import { boardCopy } from './copy'

const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8')

describe('planRename — what a rename may write', () => {
  test('trims and collapses whitespace', () => { expect(planRename('Old', '  New   name ')).toBe('New name') })
  test('blank and unchanged titles write nothing', () => {
    expect(planRename('Old', '   ')).toBeNull()
    expect(planRename('Old', '')).toBeNull()
    expect(planRename('Old', ' Old ')).toBeNull()
  })
  test('is bounded', () => { expect(planRename('a', 'x'.repeat(TITLE_MAX + 50))).toHaveLength(TITLE_MAX) })
  test('Enter saves, Escape cancels, other keys are ignored', () => {
    expect(renameKey('Enter')).toBe('save')
    expect(renameKey('Escape')).toBe('cancel')
    expect(renameKey('a')).toBeNull()
  })
})

describe('the inline editor', () => {
  test('opens on the current title, labelled', () => {
    const html = renderToStaticMarkup(h(RenameInput, { value: 'Fix login', ariaLabel: 'Rename', onSave: () => {}, onCancel: () => {} }))
    expect(html).toContain('value="Fix login"')
    expect(html).toContain('aria-label="Rename"')
    expect(html).toContain('data-rename-input')
  })
})

describe('rename is reachable from both places the owner looks', () => {
  test('the words exist in both languages', () => {
    expect(boardCopy('en').header.renameTask).toBe('Rename')
    expect(boardCopy('pt').header.renameTask).toBe('Renomear')
  })
  test('task page: the heading has a pencil and a double-click, and the ⋯ menu has a Rename row, all writing {title}', () => {
    const hero = src('TaskHero.tsx')
    expect(hero).toContain('data-rename-button')
    expect(hero).toContain('onDoubleClick')
    expect(hero).toMatch(/editTask\(task\.id, \{ title/)
    expect(hero).toContain('onRename={() => setRenaming(true)}')
    expect(src('TaskChips.tsx')).toMatch(/onRename\(\)[\s\S]{0,200}renameTask/)
  })
  test('table row: a pencil and a double-click on the name, wired to the page\'s editTask({title})', () => {
    const table = src('TaskTable.tsx')
    expect(table).toContain('data-rename-button')
    expect(table).toContain('setRenamingId(row.task.id)')
    expect(readFileSync(join(import.meta.dir, '..', '..', 'pages', 'TasksPage.tsx'), 'utf8')).toMatch(/onRename=\{async \(ref, title\) => \{ await editTask\(ref, \{ title/)
  })
})
