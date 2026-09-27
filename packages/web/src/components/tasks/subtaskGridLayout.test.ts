import { describe, expect, it } from 'bun:test'
import { SUBTASK_GRID_MIN_COLS, subtaskGridLayout } from './subtaskGridLayout'

// The main row always carries `cols.length + 2` cells (a leading cell, the title, then one per
// shown column). The subtask rows draw 9 fixed cells of their own (see the module's doc comment)
// plus a filler that must close the row out to the same width — this is the invariant the whole
// bug was about, so it is pinned for every `colsCount` a reader could ever pick, not just a sample.
describe('subtaskGridLayout', () => {
  it('keeps the inline row exactly as wide as the main row, for every possible column count', () => {
    for (let colsCount = 0; colsCount <= 20; colsCount++) {
      const layout = subtaskGridLayout(colsCount)
      if (layout.mode !== 'inline') continue
      // 9 fixed cells (leading + title + status + started + completed + duration + sessions + cost
      // + tokens) plus the filler must equal the main row's own `colsCount + 2`.
      const inlineWidth = 9 + layout.filler
      expect(inlineWidth).toBe(colsCount + 2)
    }
  })

  it('chooses nested below the threshold and inline at or above it', () => {
    for (let colsCount = 0; colsCount <= 20; colsCount++) {
      const layout = subtaskGridLayout(colsCount)
      expect(layout.mode).toBe(colsCount >= SUBTASK_GRID_MIN_COLS ? 'inline' : 'nested')
    }
  })

  it('never gives the nested mode a filler — its own table is sized to need none', () => {
    for (let colsCount = 0; colsCount < SUBTASK_GRID_MIN_COLS; colsCount++) {
      expect(subtaskGridLayout(colsCount).filler).toBe(0)
    }
  })

  it('gives the inline mode a zero filler exactly at the threshold', () => {
    expect(subtaskGridLayout(SUBTASK_GRID_MIN_COLS)).toEqual({ mode: 'inline', filler: 0 })
  })

  it('never returns a negative filler', () => {
    for (let colsCount = 0; colsCount <= 20; colsCount++) {
      expect(subtaskGridLayout(colsCount).filler).toBeGreaterThanOrEqual(0)
    }
  })
})
