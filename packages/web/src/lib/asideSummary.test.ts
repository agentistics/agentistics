import { describe, expect, test } from 'bun:test'
import { applySummaryFilter, capacityText, nativeSummaryState, summaryCounts, summaryParts, toggleSummaryPart } from './asideSummary'

const rows = [
  { id: 'a', state: 'working' }, { id: 'b', state: 'working' },
  { id: 'c', state: 'waiting' }, { id: 'd', state: 'waiting-approval' },
  { id: 'e', state: 'lost' }, { id: 'f', state: 'exited' },
]

describe('asideSummary', () => {
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

describe('asideSummary — native sessions (H17)', () => {
  const native = [
    { status: 'open', activity: 'working' }, { status: 'open', activity: 'waiting-approval' },
    { status: 'open', activity: 'waiting' }, { status: 'open' }, { status: 'closed', activity: 'waiting' },
  ]
  test('an open session takes its activity; open with none yet is active only; closed is not counted', () => {
    expect(native.map(nativeSummaryState)).toEqual(['working', 'waiting-approval', 'waiting', 'unknown', 'ended'])
    const c = summaryCounts(native.map(r => ({ state: nativeSummaryState(r) })))
    expect(c).toEqual({ active: 4, working: 1, needs: 2 })
  })
  test('fleet and native rows add up in one line', () => {
    const c = summaryCounts([...rows, ...native.map(r => ({ state: nativeSummaryState(r) }))])
    expect(c.working).toBe(3)
    expect(c.needs).toBe(4)
  })
})
