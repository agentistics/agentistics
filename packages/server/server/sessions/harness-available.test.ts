import { expect, test, describe } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { SPAWN_SPECS } from './spawn-spec'
import { availableHarnesses, resetHarnessAvailability, startableHarnessIds } from './harness-available'

describe('availableHarnesses — what the session wizard may offer', () => {
  test('startable is spec-derived, never a second hand-written list', () => {
    expect(startableHarnessIds()).toEqual(HARNESS_ORDER.filter(h => SPAWN_SPECS[h] !== null))
  })

  test('the offer is a subset of what agentop knows how to spawn', () => {
    const startable = new Set(startableHarnessIds())
    for (const id of availableHarnesses().ids) expect(startable.has(id)).toBe(true)
  })

  test('`ids` keeps the teach-everything fallback; `blind` says it happened', () => {
    // `ids` is what the generated skill teaches, and stays non-empty. `blind` is what the session
    // WIZARD reads: zero CLIs on PATH is a broken PATH, and offering all six there made every pick
    // a pane that died at once.
    expect(availableHarnesses().ids.length).toBeGreaterThan(0)
  })

  test('a PATH that reaches no harness is BLIND, not "every harness"', () => {
    const saved = process.env.PATH
    try {
      process.env.PATH = '/nonexistent-agentop-test-dir'
      resetHarnessAvailability()
      const out = availableHarnesses()
      expect(out.blind).toBe(true)
      expect(out.ids).toEqual(startableHarnessIds())
    } finally {
      process.env.PATH = saved
      resetHarnessAvailability()
    }
  })
})
