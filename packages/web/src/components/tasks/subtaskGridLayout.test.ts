import { describe, expect, test } from 'bun:test'
import { MAX_COL_WIDTH, MIN_COL_WIDTH } from './columnWidths'
import { SUBTASK_LEAD_WIDTH, SUBTASK_TITLE_ID, SUBTASK_TITLE_WIDTH, subtaskGridWidths } from './subtaskGridLayout'

describe('subtaskGridWidths', () => {
  test('defaults: title 280, each shown column at its own default, exact total', () => {
    const g = subtaskGridWidths(['status', 'sessions'], {})
    expect(g.title).toBe(SUBTASK_TITLE_WIDTH)
    expect(g.cols).toEqual({ status: 100, sessions: 190 })
    expect(g.total).toBe(SUBTASK_LEAD_WIDTH + 280 + 100 + 190)
  })

  test('the name column resizes like any other and is persisted under its own key', () => {
    const g = subtaskGridWidths(['status'], { [SUBTASK_TITLE_ID]: 420, status: 150 })
    expect(g.title).toBe(420)
    expect(g.cols.status).toBe(150)
    expect(g.total).toBe(SUBTASK_LEAD_WIDTH + 420 + 150)
  })

  test('depends on nothing but the subtask grid: delivery-table ids in the saved record are ignored', () => {
    const a = subtaskGridWidths(['status', 'cost'], {})
    const b = subtaskGridWidths(['status', 'cost'], { progress: 600, priority: 300, ghost: 9 })
    expect(b).toEqual(a)
  })

  test('a hidden column takes no width', () => {
    const g = subtaskGridWidths(['cost'], { status: 300 })
    expect(g.cols).toEqual({ cost: 88 })
    expect(g.total).toBe(SUBTASK_LEAD_WIDTH + 280 + 88)
  })

  test('the live drag lays over the saved width, including on the name column', () => {
    expect(subtaskGridWidths(['status'], { status: 150 }, { id: 'status', w: 210 }).cols.status).toBe(210)
    expect(subtaskGridWidths(['status'], {}, { id: SUBTASK_TITLE_ID, w: 333 }).title).toBe(333)
    // A drag on a column that is not shown changes nothing.
    expect(subtaskGridWidths(['status'], {}, { id: 'cost', w: 333 }).cols).toEqual({ status: 100 })
  })

  test('saved widths are clamped; a trailing column is counted', () => {
    const g = subtaskGridWidths(['status'], { [SUBTASK_TITLE_ID]: 5, status: 99999 }, null, { trailing: 88, lead: 8 })
    expect(g.title).toBe(MIN_COL_WIDTH)
    expect(g.cols.status).toBe(MAX_COL_WIDTH)
    expect(g.lead).toBe(8)
    expect(g.total).toBe(8 + MIN_COL_WIDTH + MAX_COL_WIDTH + 88)
  })
})
