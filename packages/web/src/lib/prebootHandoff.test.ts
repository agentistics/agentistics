import { describe, expect, test } from 'bun:test'
import { shouldReleasePreboot } from './prebootHandoff'

describe('pre-React loader hand-off', () => {
  test('keeps the HTML loader until React has committed and painted once', () => {
    expect(shouldReleasePreboot({ reactCommitted: false, firstPainted: false })).toBe(false)
    expect(shouldReleasePreboot({ reactCommitted: true, firstPainted: false })).toBe(false)
    expect(shouldReleasePreboot({ reactCommitted: true, firstPainted: true })).toBe(true)
  })
})
