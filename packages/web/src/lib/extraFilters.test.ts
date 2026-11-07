import { describe, expect, test } from 'bun:test'
import { extraActive, extraActiveCount, pickExtra, type ExtraDimension, type ExtraFilters } from './extraFilters'

const dim = (o: Partial<ExtraDimension> = {}): ExtraDimension => ({ id: 'v', label: 'V', mode: 'multi', options: [], selected: [], onChange: () => {}, ...o })

describe('extra filter dimensions', () => {
  test('multi toggles values in and out', () => {
    const d = dim()
    expect(pickExtra(d, 'a')).toEqual(['a'])
    expect(pickExtra(dim({ selected: ['a'] }), 'b')).toEqual(['a', 'b'])
    expect(pickExtra(dim({ selected: ['a', 'b'] }), 'a')).toEqual(['b'])
  })

  test('single keeps one; picking it again clears (or returns to the neutral value)', () => {
    expect(pickExtra(dim({ mode: 'single' }), 'a')).toEqual(['a'])
    expect(pickExtra(dim({ mode: 'single', selected: ['a'] }), 'b')).toEqual(['b'])
    expect(pickExtra(dim({ mode: 'single', selected: ['a'] }), 'a')).toEqual([])
    expect(pickExtra(dim({ mode: 'single', selected: ['week'], neutral: 'day' }), 'week')).toEqual(['day'])
    expect(pickExtra(dim({ mode: 'single', selected: ['day'], neutral: 'day' }), 'day')).toEqual(['day'])
  })

  test('a neutral selection is not a filter and is not counted', () => {
    expect(extraActive(dim())).toBe(false)
    expect(extraActive(dim({ selected: ['a'] }))).toBe(true)
    expect(extraActive(dim({ mode: 'single', selected: ['day'], neutral: 'day' }))).toBe(false)
    expect(extraActive(dim({ mode: 'single', selected: ['week'], neutral: 'day' }))).toBe(true)
    const extra: ExtraFilters = { dims: [dim({ selected: ['a'] }), dim({ id: 'g', mode: 'single', selected: ['day'], neutral: 'day' }), dim({ id: 'q' })], clear: () => {} }
    expect(extraActiveCount(extra)).toBe(1)
    expect(extraActiveCount(undefined)).toBe(0)
  })
})
