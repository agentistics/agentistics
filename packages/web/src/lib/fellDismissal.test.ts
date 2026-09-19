import { describe, expect, it } from 'bun:test'
import { fellGroupDismissed } from './fellDismissal'

describe('fellGroupDismissed', () => {
  it('is false when nothing has ever been dismissed', () => {
    expect(fellGroupDismissed(null, ['a', 'b'])).toBe(false)
  })

  it('is true for the exact same set, in any order', () => {
    expect(fellGroupDismissed(['a', 'b'], ['b', 'a'])).toBe(true)
  })

  it('is false once the fall is a DIFFERENT set — one more session fell', () => {
    expect(fellGroupDismissed(['a', 'b'], ['a', 'b', 'c'])).toBe(false)
  })

  it('is false once the fall SHRANK — one row was reopened on its own', () => {
    expect(fellGroupDismissed(['a', 'b'], ['a'])).toBe(false)
  })

  it('is false for a same-size set that does not actually match', () => {
    expect(fellGroupDismissed(['a', 'b'], ['a', 'c'])).toBe(false)
  })

  it('an empty dismissal only matches an empty fall', () => {
    expect(fellGroupDismissed([], [])).toBe(true)
    expect(fellGroupDismissed([], ['a'])).toBe(false)
  })
})
