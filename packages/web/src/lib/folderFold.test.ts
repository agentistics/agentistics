import { describe, expect, test } from 'bun:test'
import { folderFold } from './folderFold'

const base = { storedFolded: false, openedDimmed: false, narrowing: false, searching: false, shownCount: 3 }

describe('folderFold', () => {
  test('an all-inactive folder under "only active" is dimmed and starts folded', () => {
    const f = folderFold({ ...base, narrowing: true, shownCount: 0 })
    expect(f).toEqual({ folded: true, dimmed: true, showAll: false, toggles: 'dimmed' })
  })

  test('clicking a dimmed folder opens it, onto its whole contents', () => {
    const f = folderFold({ ...base, narrowing: true, shownCount: 0, openedDimmed: true })
    expect(f.folded).toBe(false)
    expect(f.dimmed).toBe(true)
    expect(f.showAll).toBe(true)
  })

  test('a dimmed folder ignores the stored fold, so its click is never a no-op', () => {
    const closed = folderFold({ ...base, narrowing: true, shownCount: 0, storedFolded: true })
    const open = folderFold({ ...base, narrowing: true, shownCount: 0, storedFolded: true, openedDimmed: true })
    expect(closed.folded).not.toBe(open.folded)
  })

  test('a folder with matches follows the stored fold', () => {
    expect(folderFold({ ...base, narrowing: true, storedFolded: true })).toEqual(
      { folded: true, dimmed: false, showAll: false, toggles: 'stored' })
    expect(folderFold({ ...base, storedFolded: false }).folded).toBe(false)
  })

  test('a search opens a folder holding results without touching the stored fold', () => {
    expect(folderFold({ ...base, narrowing: true, searching: true, storedFolded: true }).folded).toBe(false)
  })

  test('an empty folder with no narrowing is not dimmed', () => {
    expect(folderFold({ ...base, shownCount: 0 }).dimmed).toBe(false)
  })
})
