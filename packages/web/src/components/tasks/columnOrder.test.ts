import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import { columnDragType, isColumnDrag, moveColumn } from './columnOrder'
import { SortTh } from './SortHeader'

describe('moveColumn — the array a header drag writes', () => {
  const shown = ['status', 'cost', 'sessions', 'duration'] as const
  test('the dragged column lands on the drop column\'s place, the rest keep their order', () => {
    expect(moveColumn(shown, 'duration', 'status')).toEqual(['duration', 'status', 'cost', 'sessions'])
    expect(moveColumn(shown, 'status', 'sessions')).toEqual(['cost', 'status', 'sessions', 'duration'])
  })
  test('is exactly what the dropdown stores: the same ids, the same length, nothing added or lost', () => {
    const next = moveColumn(shown, 'cost', 'duration')
    expect([...next].sort()).toEqual([...shown].sort())
    expect(next).toHaveLength(shown.length)
  })
  test('dropping on itself, or on a column that is not shown, changes nothing', () => {
    expect(moveColumn(shown, 'cost', 'cost')).toEqual([...shown])
    expect(moveColumn(shown, 'cost', 'hidden' as never)).toEqual([...shown])
    expect(moveColumn(shown, 'hidden' as never, 'cost')).toEqual([...shown])
  })
  test('never mutates what it was given', () => {
    const src = ['a', 'b', 'c']
    moveColumn(src, 'c', 'a')
    expect(src).toEqual(['a', 'b', 'c'])
  })
})

describe('a column drag is told apart by its table', () => {
  test('only a drag carrying this table\'s type is accepted', () => {
    expect(isColumnDrag([columnDragType('task-columns'), 'text/plain'], 'task-columns')).toBe(true)
    expect(isColumnDrag([columnDragType('subtask-columns')], 'task-columns')).toBe(false)
    expect(isColumnDrag(['text/plain', 'Files'], 'task-columns')).toBe(false)
  })
})

describe('SortTh', () => {
  const base = { label: 'Cost', current: null, onSort: () => {}, mobile: false }
  test('with `reorder` the header is draggable and marked', () => {
    const html = renderToStaticMarkup(h(SortTh, { ...base, reorder: { scope: 't', id: 'cost', onMove: () => {} } }))
    expect(html).toContain('draggable="true"')
    expect(html).toContain('data-col-draggable="cost"')
  })
  test('without it nothing is draggable, and a sortable header keeps its button (the keyboard fallback is the dropdown)', () => {
    const html = renderToStaticMarkup(h(SortTh, { ...base, sortKey: 'cost' }))
    expect(html).not.toContain('draggable')
    expect(html).toContain('<button')
  })
})
