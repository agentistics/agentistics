import { describe, expect, test } from 'bun:test'
import { shouldReleasePreboot } from './prebootHandoff'

describe('boot splash hand-off', () => {
  test('stays while any boot state holds it, even once React has painted', () => {
    expect(shouldReleasePreboot({ holds: 1, released: false, painted: true })).toBe(false)
    expect(shouldReleasePreboot({ holds: 2, released: false, painted: true })).toBe(false)
  })

  test('stays until the commit that replaces it has been painted', () => {
    expect(shouldReleasePreboot({ holds: 0, released: false, painted: false })).toBe(false)
  })

  test('leaves once nothing holds it and the replacement is on screen', () => {
    expect(shouldReleasePreboot({ holds: 0, released: false, painted: true })).toBe(true)
  })

  test('leaves only once: a released splash is never released again', () => {
    expect(shouldReleasePreboot({ holds: 0, released: true, painted: true })).toBe(false)
  })
})
