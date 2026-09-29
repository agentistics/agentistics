import { describe, expect, it } from 'bun:test'
import { subtaskGridLayout } from './subtaskGridLayout'

// The main row always carries `colsCount + 2` cells (a leading cell, the title, then one per shown
// column). The subtask row draws a leading cell, a title cell, then one per shown SUBTASK column
// (`subtaskColsCount`) plus a filler that must close the row out to the same width — this is the
// invariant the whole bug was about, so it is pinned for every combination a reader could pick, not
// just a sample.
describe('subtaskGridLayout', () => {
  it('keeps the inline row exactly as wide as the main row, for every possible column count', () => {
    for (let subtaskColsCount = 1; subtaskColsCount <= 8; subtaskColsCount++) {
      for (let colsCount = 0; colsCount <= 20; colsCount++) {
        const layout = subtaskGridLayout(colsCount, subtaskColsCount)
        if (layout.mode !== 'inline') continue
        const inlineWidth = (2 + subtaskColsCount) + layout.filler
        expect(inlineWidth).toBe(colsCount + 2)
      }
    }
  })

  it('chooses nested below the threshold and inline at or above it', () => {
    const subtaskColsCount = 8
    for (let colsCount = 0; colsCount <= 20; colsCount++) {
      const layout = subtaskGridLayout(colsCount, subtaskColsCount)
      expect(layout.mode).toBe(colsCount >= subtaskColsCount ? 'inline' : 'nested')
    }
  })

  it('never gives the nested mode a filler — its own table is sized to need none', () => {
    const subtaskColsCount = 8
    for (let colsCount = 0; colsCount < subtaskColsCount; colsCount++) {
      expect(subtaskGridLayout(colsCount, subtaskColsCount).filler).toBe(0)
    }
  })

  it('gives the inline mode a zero filler exactly at the threshold', () => {
    expect(subtaskGridLayout(8, 8)).toEqual({ mode: 'inline', filler: 0 })
    expect(subtaskGridLayout(3, 3)).toEqual({ mode: 'inline', filler: 0 })
  })

  it('a narrower subtask column count lowers the threshold, exactly what hiding a column is for', () => {
    // 5 main columns did not fit the old fixed 7-column subtask grid (nested); with the subtask
    // grid narrowed to 5 of its own columns, the same 5 main columns fit inline again.
    expect(subtaskGridLayout(5, 7).mode).toBe('nested')
    expect(subtaskGridLayout(5, 5).mode).toBe('inline')
  })

  it('never returns a negative filler', () => {
    for (let subtaskColsCount = 1; subtaskColsCount <= 8; subtaskColsCount++) {
      for (let colsCount = 0; colsCount <= 20; colsCount++) {
        expect(subtaskGridLayout(colsCount, subtaskColsCount).filler).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
