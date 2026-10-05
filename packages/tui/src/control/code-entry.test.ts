import { describe, expect, test } from 'bun:test'
import { startTabFor, tabOrderFor } from './types'

describe('code entry tab', () => {
  test('the ordinary agentop cockpit has no code tab', () => {
    expect(tabOrderFor(false)).not.toContain('code')
  })

  test('the explicit agentop code entry includes the code tab', () => {
    expect(tabOrderFor(true)).toContain('code')
  })
})

describe('a plain agentop never opens the native front door', () => {
  test('home is the native harness landing: it is absent from a plain cockpit and present under `agentop code`', () => {
    expect(tabOrderFor(false)).not.toContain('home')
    expect(tabOrderFor(true)).toContain('home')
  })
  test('the plain cockpit opens on services whatever was asked, `agentop code` opens on home', () => {
    expect(startTabFor(undefined, false)).toBe('services')
    expect(startTabFor('home', false)).toBe('services')
    expect(startTabFor('code', false)).toBe('services')
    expect(startTabFor('sessions', false)).toBe('sessions')
    expect(startTabFor(undefined, true)).toBe('home')
  })
})
