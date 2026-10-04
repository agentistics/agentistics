import { describe, expect, test } from 'bun:test'
import { tabOrderFor } from './types'

describe('code entry tab', () => {
  test('the ordinary agentop cockpit has no code tab', () => {
    expect(tabOrderFor(false)).not.toContain('code')
  })

  test('the explicit agentop code entry includes the code tab', () => {
    expect(tabOrderFor(true)).toContain('code')
  })
})
