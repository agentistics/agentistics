import { afterEach, expect, test } from 'bun:test'
import { clearHeldKill, offerHeldKill, peekHeldKill, registerHeldKillHost } from './heldKill'

afterEach(() => clearHeldKill())

test('with no host mounted the offer is refused and nothing is stored (the caller shows its notice)', () => {
  expect(offerHeldKill({ id: 'a', message: 'm' })).toBe(false)
  expect(peekHeldKill()).toBeNull()
  // A host that mounts later finds no stale question.
  const off = registerHeldKillHost()
  expect(peekHeldKill()).toBeNull()
  off()
})

test('with a host the question is stored, and the last host leaving drops it', () => {
  const off = registerHeldKillHost()
  expect(offerHeldKill({ id: 'a', message: 'm' })).toBe(true)
  expect(peekHeldKill()?.id).toBe('a')
  off()
  expect(peekHeldKill()).toBeNull()
})
