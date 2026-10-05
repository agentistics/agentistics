import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import { COLUMNS, DEFAULT_COLUMNS } from './TaskTable'
import { DEFAULT_SUBTASK_COLUMNS, SUBTASK_COLUMNS } from './subtaskColumnDefs'
import { boardCopy } from './copy'
import { subtaskColumnCell } from './subtaskColumnCell'
import { IdCell } from './IdCell'

describe('the optional ID column', () => {
  test('both tables offer it in the Columns menu, but neither shows it by default', () => {
    expect(COLUMNS.some(c => c.id === 'id')).toBe(true)
    expect(DEFAULT_COLUMNS).not.toContain('id')
    expect(SUBTASK_COLUMNS.some(c => c.id === 'id')).toBe(true)
    expect(DEFAULT_SUBTASK_COLUMNS).not.toContain('id')
    // every other subtask column is still shown by default, in the same order
    expect(DEFAULT_SUBTASK_COLUMNS).toEqual(SUBTASK_COLUMNS.map(c => c.id).filter(id => id !== 'id'))
  })
  test('it has a label in both languages (the picker and the header read the same record)', () => {
    for (const lang of ['pt', 'en'] as const) {
      expect(boardCopy(lang).columns.id).toBe('ID')
      expect(boardCopy(lang).subtaskColumns.id).toBe('ID')
    }
  })
  test('the cell is the id in monospace, in a button that copies it', () => {
    const html = renderToStaticMarkup(h(IdCell, { id: 't-e1dea7cd6f', lang: 'en' }))
    expect(html).toContain('t-e1dea7cd6f')
    expect(html).toContain('<button')
    expect(html).toContain('monospace')
    expect(html).toContain('Copy t-e1dea7cd6f')
    expect(renderToStaticMarkup(h(IdCell, { id: 't-1', lang: 'pt' }))).toContain('Copiar t-1')
  })
  test('the subtask grid draws a subtask\'s id through the same cell', () => {
    const el = subtaskColumnCell('id', { subtask: { id: 's-b71b2e6f73', title: 'x' }, subtaskRollups: [], lang: 'en' } as never) as never
    expect(renderToStaticMarkup(el)).toContain('s-b71b2e6f73')
  })
})
