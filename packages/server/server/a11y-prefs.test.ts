import { describe, expect, it } from 'bun:test'
import { applyA11yPut } from './a11y-prefs'
import { DEFAULT_ACCESSIBILITY_PREFS } from '@agentistics/core'

describe('applyA11yPut', () => {
  it('sanitises junk to the defaults', () => {
    expect(applyA11yPut('junk')).toEqual(DEFAULT_ACCESSIBILITY_PREFS)
  })
})
