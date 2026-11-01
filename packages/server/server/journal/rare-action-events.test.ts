/** ADAPTER.LIMITES A2 — the keyed-action events are RARE (read back by session on a repeat), and every rare type is canonical. */
import { expect, test } from 'bun:test'
import { isEventType } from '@agentistics/core'
import { RARE_EVENT_TYPES } from './journal'

test('action.claimed and action.settled are rare event types and in the canonical vocabulary', () => {
  expect(RARE_EVENT_TYPES).toContain('action.claimed')
  expect(RARE_EVENT_TYPES).toContain('action.settled')
  for (const t of RARE_EVENT_TYPES) expect(isEventType(t)).toBe(true)
})
