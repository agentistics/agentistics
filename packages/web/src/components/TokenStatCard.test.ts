import { describe, expect, it } from 'bun:test'
import { tokPartsColumns, TOK_PART_MIN } from './TokenStatCard'

/** How many columns CSS `repeat(auto-fit, minmax(max(<min>px, calc(<pct>% - <sub>px)), 1fr))` lays out in a
 *  container `width` wide with a `gap` between tracks — read off the template itself, so a template that
 *  stops being that shape fails here rather than being measured by an assumption. */
function columnsAt(template: string, width: number, gap: number): number {
  const m = /^repeat\(auto-fit, minmax\(max\((\d+)px, calc\((\d+)% - (\d+)px\)\), 1fr\)\)$/.exec(template)
  if (!m) throw new Error(`not an auto-fit capped template: ${template}`)
  const track = Math.max(Number(m[1]), width * Number(m[2]) / 100 - Number(m[3]))
  return Math.max(1, Math.floor((width + gap) / (track + gap)))
}

describe('tokPartsColumns — the TOKENS card never cuts a counter label', () => {
  const t = tokPartsColumns()
  it('fits columns to the card instead of forcing two', () => {
    expect(t).toContain('auto-fit')
    expect(t).not.toMatch(/^repeat\(2,/)
  })
  it('keeps a column at least as wide as a whole label', () => expect(t).toContain(`max(${TOK_PART_MIN}px`))
  it('stacks in a narrow KPI cell (one fifth of a 1440 row)', () => expect(columnsAt(t, 230, 18)).toBe(1))
  it('stacks on a 390px phone card', () => expect(columnsAt(t, 330, 12)).toBe(1))
  it('uses two columns where both labels fit whole', () => expect(columnsAt(t, 420, 18)).toBe(2))
  it('never more than two, however wide', () => {
    for (const w of [600, 900, 1400]) expect(columnsAt(t, w, 18)).toBe(2)
  })
})
