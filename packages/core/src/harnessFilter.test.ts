import { describe, expect, it } from 'bun:test'
import { distinctHarnesses, filterByHarnesses } from './harnessFilter'

describe('distinctHarnesses', () => {
  it('lists each harness once, in canonical order, reading a missing one as claude', () => {
    expect(distinctHarnesses([{ harness: 'codex' }, {}, { harness: 'codex' }])).toEqual(['claude', 'codex'])
  })
})

describe('filterByHarnesses', () => {
  const rows = [{ id: 1, harness: 'codex' as const }, { id: 2 }]
  it('an empty selection lets everything through', () => {
    expect(filterByHarnesses(rows, [])).toBe(rows)
  })
  it('keeps only the selected harnesses, a missing one counting as claude', () => {
    expect(filterByHarnesses(rows, ['claude']).map(r => r.id)).toEqual([2])
    expect(filterByHarnesses(rows, ['codex']).map(r => r.id)).toEqual([1])
  })
})
