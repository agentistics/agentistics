import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CREATE_STATUS, planCreate, TITLE_MAX } from './createPlan'

const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8')
const draft = { title: 'Fix login', type: '', status: '', detail: '' }

describe('planCreate — what the form submits', () => {
  test('a title is required: blank is refused', () => {
    expect(planCreate({ ...draft, title: '   ' })).toEqual({ ok: false, reason: 'title' })
    expect(planCreate({ ...draft, title: '' })).toEqual({ ok: false, reason: 'title' })
  })
  test('title is trimmed, collapsed and bounded', () => {
    expect(planCreate({ ...draft, title: '  Fix   login ' })).toMatchObject({ ok: true, title: 'Fix login' })
    const p = planCreate({ ...draft, title: 'x'.repeat(TITLE_MAX + 20) })
    expect(p.ok && p.title.length).toBe(TITLE_MAX)
  })
  test('status defaults to To do; type and description are optional and omitted when empty', () => {
    const p = planCreate(draft)
    expect(p).toEqual({ ok: true, title: 'Fix login', status: DEFAULT_CREATE_STATUS })
    expect(DEFAULT_CREATE_STATUS).toBe('todo')
  })
  test('a chosen type, status and a markdown description are all carried, the description as markdown text', () => {
    const md = '# Goal\n\n- one\n- two\n\n**done** when `x`'
    expect(planCreate({ title: 'T', type: 'core', status: 'doing', detail: `  ${md}\n\n` })).toEqual({
      ok: true, title: 'T', type: 'core', status: 'doing', detail: md,
    })
  })
  test('a description of only whitespace is not stored', () => {
    expect(planCreate({ ...draft, detail: ' \n  \n' })).toEqual({ ok: true, title: 'Fix login', status: 'todo' })
  })
})

describe('the create form is what "+ Add" opens', () => {
  test('the dialog asks Title (required), Type, Status and Description, in both languages', () => {
    const d = src('CreateTaskDialog.tsx')
    for (const w of ['Title', 'Título', 'Type (optional)', 'Tipo (opcional)', 'Status', 'Description (recommended)', 'Descrição (recomendado)']) expect(d).toContain(w)
    expect(d).toContain('aria-required="true"')
    expect(d).toContain('planCreate')
  })
  test('the editor is lazy and stores markdown (TipTap + its Markdown extension, onChange hands back getMarkdown)', () => {
    expect(src('CreateTaskDialog.tsx')).toMatch(/lazy\(\(\) => import\('\.\/MarkdownEditor'\)/)
    const e = src('MarkdownEditor.tsx')
    expect(e).toContain("from '@tiptap/markdown'")
    expect(e).toContain("contentType: 'markdown'")
    expect(e).toContain('getMarkdown()')
  })
  test('the board\'s + Add opens the dialog with the column\'s status and type, and the page creates then moves it into that status', () => {
    expect(src('TaskTable.tsx')).toMatch(/onRequestCreate\(\{ status: g\.createStatus/)
    const page = readFileSync(join(import.meta.dir, '..', '..', 'pages', 'TasksPage.tsx'), 'utf8')
    expect(page).toContain('<CreateTaskDialog')
    expect(page).toMatch(/createTask\(plan\.title, plan\.detail, plan\.type\)/)
    expect(page).toMatch(/plan\.status !== 'todo'/)
  })
})
