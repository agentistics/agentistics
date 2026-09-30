import { describe, expect, test } from 'bun:test'
import { findAll, locateSnippet } from './match.ts'

describe('locateSnippet', () => {
  test('matches at the exact tier', () => {
    const out = locateSnippet(['a', 'b', 'c', 'd'], ['b', 'c'])
    expect(out).toEqual({ ok: true, tier: 'exact', start: 1 })
  })

  test('falls back to trailing-ws when only whitespace at line end differs', () => {
    const out = locateSnippet(['a', 'b  ', 'c\t', 'd'], ['b', 'c'])
    expect(out).toEqual({ ok: true, tier: 'trailing-ws', start: 1 })
  })

  test('falls back to surrounding-ws when leading whitespace also differs', () => {
    const out = locateSnippet(['a', '  b', 'c  ', 'd'], ['b', 'c'])
    expect(out).toEqual({ ok: true, tier: 'surrounding-ws', start: 1 })
  })

  test('exact tier is preferred over a looser one when it alone matches', () => {
    // 'b' also appears with different whitespace elsewhere, but the EXACT occurrence is unique.
    const out = locateSnippet(['x', 'b', 'y', '  b  '], ['b'])
    expect(out).toEqual({ ok: true, tier: 'exact', start: 1 })
  })

  test('refuses "no-match" when nothing matches at any tier, and tries all three', () => {
    const out = locateSnippet(['a', 'b', 'c'], ['nope'])
    expect(out).toEqual({ ok: false, reason: 'no-match' })
  })

  test('refuses "ambiguous" when a tier matches more than once, without trying a looser tier', () => {
    const out = locateSnippet(['x', 'b', 'y', 'b', 'z'], ['b'])
    expect(out).toEqual({ ok: false, reason: 'ambiguous', tier: 'exact', count: 2 })
  })

  test('an ambiguous EXACT match does not get resolved by relaxing whitespace', () => {
    // Two exact matches for 'b'; a looser tier would still find (at least) those two.
    const out = locateSnippet(['b', 'x', 'b'], ['b'])
    expect(out).toEqual({ ok: false, reason: 'ambiguous', tier: 'exact', count: 2 })
  })

  test('an empty needle never matches', () => {
    expect(locateSnippet(['a', 'b'], [])).toEqual({ ok: false, reason: 'no-match' })
  })

  test('findAll finds every start index at a tier', () => {
    expect(findAll(['b', 'x', 'b', 'y', 'b'], ['b'], 'exact')).toEqual([0, 2, 4])
    expect(findAll(['a', 'b'], ['a', 'b', 'c'], 'exact')).toEqual([])
  })
})
