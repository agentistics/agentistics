import { describe, test, expect } from 'bun:test'
import { hasRealVersions } from './versionVisibility'

describe('hasRealVersions', () => {
  test('no versions at all: the version UI is hidden', () => {
    expect(hasRealVersions([])).toBe(false)
    expect(hasRealVersions(null)).toBe(false)
  })
  test('a published x.y.z version turns it on', () => {
    expect(hasRealVersions([{ version: '2.202.2', state: 'published' }])).toBe(true)
    expect(hasRealVersions([{ version: '2.203.0', state: 'planned' }, { version: '2.202.2', state: 'published' }])).toBe(true)
  })
  test('only an estimated / unreleased label does not', () => {
    expect(hasRealVersions([{ version: '2.203.0', state: 'planned' }])).toBe(false)
    expect(hasRealVersions([{ version: 'next', state: 'planned' }])).toBe(false)
  })
})
