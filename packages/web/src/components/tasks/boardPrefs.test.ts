import { describe, expect, it } from 'bun:test'
import { DEFAULT_PREFS, parseBoardPrefs, readBoardPrefs, writeBoardPrefs } from './boardPrefs'

// What a stored document is READ AS is the pure `parseBoardPrefs`; where it is stored (server,
// per person, with the browser copy as first paint) is `sharedPref.ts`, tested there.

describe('parseBoardPrefs', () => {
  it('junk yields the defaults instead of throwing', () => {
    expect(parseBoardPrefs(undefined)).toEqual(DEFAULT_PREFS)
    expect(parseBoardPrefs(null)).toEqual(DEFAULT_PREFS)
    expect(parseBoardPrefs('table')).toEqual(DEFAULT_PREFS)
    expect(parseBoardPrefs(['table'])).toEqual(DEFAULT_PREFS)
  })

  it('drops columnSort entries that are not a sort, and tolerates a non-object', () => {
    expect(parseBoardPrefs({
      columnSort: { ok: { key: 'title', dir: 'asc' }, junk: 'x', empty: null, nokey: { dir: 'asc' } },
    }).columnSort).toEqual({ ok: { key: 'title', dir: 'asc' } })
    expect(parseBoardPrefs({ columnSort: ['a'] }).columnSort).toEqual({})
    expect(parseBoardPrefs({ columnSort: 'no' }).columnSort).toEqual({})
  })

  it('subtaskColumns: null unless an array; an empty array is a real choice', () => {
    expect(parseBoardPrefs({}).subtaskColumns).toBeNull()
    expect(parseBoardPrefs({ subtaskColumns: 'model' }).subtaskColumns).toBeNull()
    expect(parseBoardPrefs({ subtaskColumns: [] }).subtaskColumns).toEqual([])
    expect(parseBoardPrefs({ subtaskColumns: ['model', 'status'] }).subtaskColumns).toEqual(['model', 'status'])
  })

  it('keeps the delivery table\'s columns apart from the subtask grid\'s', () => {
    const p = parseBoardPrefs({ columns: ['status', 'cost'], subtaskColumns: ['model'] })
    expect(p.columns).toEqual(['status', 'cost'])
    expect(p.subtaskColumns).toEqual(['model'])
  })

  it('drops a WIP limit that is not a positive number and a rail entry that is not a boolean', () => {
    const p = parseBoardPrefs({ wip: { todo: 3, doing: 0, x: 'y' }, rail: { a: true, b: 'open' } })
    expect(p.wip).toEqual({ todo: 3 })
    expect(p.rail).toEqual({ a: true })
  })

  it('an unknown view or lane falls back', () => {
    const p = parseBoardPrefs({ view: 'gantt', lanes: 'team' })
    expect(p.view).toBe('overview')
    expect(p.lanes).toBe('none')
  })
})

describe('readBoardPrefs / writeBoardPrefs', () => {
  it('a write is a PATCH: one field changes, the rest of the arrangement stays', () => {
    writeBoardPrefs({ columns: ['status', 'cost'], subtaskColumns: ['model', 'status'] })
    writeBoardPrefs({ subtaskColumns: ['status'] })
    const p = readBoardPrefs()
    expect(p.subtaskColumns).toEqual(['status'])
    expect(p.columns).toEqual(['status', 'cost'])
  })

  it('does not throw without a usable localStorage', () => {
    expect(() => writeBoardPrefs({ columnSort: {} })).not.toThrow()
  })
})
