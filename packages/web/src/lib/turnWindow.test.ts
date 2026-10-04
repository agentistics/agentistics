import { describe, expect, it } from 'bun:test'
import { INITIAL_TURNS, shownToInclude, windowStart } from './turnWindow'

describe('turnWindow', () => {
  it('renders only the end of a long conversation first', () => {
    expect(windowStart(400, INITIAL_TURNS)).toBe(340)
    expect(windowStart(20, INITIAL_TURNS)).toBe(0)
  })
  it('a jump to an older turn widens the window to include it, with context above', () => {
    const shown = shownToInclude(400, 100)
    expect(windowStart(400, shown)).toBe(90)
    expect(windowStart(400, shownToInclude(400, 3))).toBe(0)
  })
})
