import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { forkCapabilityFor, FORK_CAPABILITIES } from './fork-capability'

describe('fork/account-switch capability is explicit per harness', () => {
  it('has a measured declaration for every harness, with Claude and opencode the verified followers', () => {
    for (const harness of HARNESS_ORDER) expect(FORK_CAPABILITIES[harness]).toBeDefined()
    expect(forkCapabilityFor('claude')).toMatchObject({ follow: true })
    for (const harness of ['codex', 'gemini', 'kimi'] as const) {
      expect(forkCapabilityFor(harness)).toMatchObject({ follow: false })
      expect(forkCapabilityFor(harness).absent).toContain('not verified')
    }
  })

  it('opencode follows forks because ACP session/fork names the successor (measured 1.19.5)', () => {
    expect(forkCapabilityFor('opencode')).toMatchObject({ follow: true })
    expect(forkCapabilityFor('opencode').probe).toContain('session/fork')
  })

  it('never turns an unknown harness into an optimistic follow', () => {
    expect(forkCapabilityFor('future-harness')).toMatchObject({ follow: false, probe: 'not verified' })
  })
})

