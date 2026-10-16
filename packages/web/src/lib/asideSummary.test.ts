import { describe, expect, test } from 'bun:test'
import { applySummaryFilter, capacityText, summaryCounts, summaryParts, toggleSummaryPart } from './asideSummary'

const rows = [
  { id: 'a', state: 'working' }, { id: 'b', state: 'working' },
  { id: 'c', state: 'waiting' }, { id: 'd', state: 'waiting-approval' },
  { id: 'e', state: 'lost' }, { id: 'f', state: 'exited' },
]

describe('asideSummary', () => {
  test('4 waiting + 4 working + 89 lost counts exactly 8 active sessions', () => {
    expect(summaryCounts([
      ...Array.from({ length: 4 }, () => ({ state: 'waiting' })),
      ...Array.from({ length: 4 }, () => ({ state: 'working' })),
      ...Array.from({ length: 89 }, () => ({ state: 'lost' })),
      ...['exited', 'closed', 'orphan'].map(state => ({ state })),
    ])).toEqual({ active: 8, working: 4, needs: 4 })
  })
  test('counts', () => {
    const c = summaryCounts(rows)
    expect(c.working).toBe(2)
    expect(c.needs).toBe(2)
    expect(c.active).toBeGreaterThanOrEqual(c.working + c.needs)
    expect(c.active).toBeLessThan(rows.length)
  })
  test('each part filters the list, and null leaves it whole', () => {
    expect(applySummaryFilter(rows, 'working').map(r => r.id)).toEqual(['a', 'b'])
    expect(applySummaryFilter(rows, 'needs').map(r => r.id)).toEqual(['c', 'd'])
    expect(applySummaryFilter(rows, null)).toHaveLength(rows.length)
  })
  test('pressing a part again clears it', () => {
    expect(toggleSummaryPart(null, 'needs')).toBe('needs')
    expect(toggleSummaryPart('needs', 'needs')).toBeNull()
    expect(toggleSummaryPart('needs', 'working')).toBe('working')
  })
  test('PT / EN wording and singulars', () => {
    expect(summaryParts({ active: 1, working: 1, needs: 1 }, true).map(p => p.text)).toEqual(['1 ativa', '1 trabalhando', '1 precisa de você'])
    expect(summaryParts({ active: 3, working: 2, needs: 0 }, true).map(p => p.text)).toEqual(['3 ativas', '2 trabalhando', '0 precisam de você'])
    expect(summaryParts({ active: 3, working: 2, needs: 1 }, false).map(p => p.text)).toEqual(['3 active', '2 working', '1 needs you'])
  })
  test('capacity is empty until provided', () => {
    expect(capacityText(null, true)).toBe('')
    expect(capacityText({ used: 3, max: 4 }, true)).toBe('1/4 vagas')
  })
})
