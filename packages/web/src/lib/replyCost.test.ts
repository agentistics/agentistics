import { describe, expect, test } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { replyCost, replyCostExceeds } from './replyCost'

const meta = (o: object) => ({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, assistant_message_count: 0, ...o }) as SessionMeta

describe('replyCost', () => {
  test('last turn is the context gauge; average is resent volume per reply', () => {
    const r = replyCost('claude', meta({ context_tokens: 400_000, input_tokens: 1000, cache_read_input_tokens: 8_000_000, cache_creation_input_tokens: 1_000_000, assistant_message_count: 30 }))
    expect(r.lastTurn).toBe(400_000)
    expect(r.average).toBe(Math.round(9_001_000 / 30))
  })
  test('unknown is null, never 0', () => {
    expect(replyCost('claude', undefined)).toEqual({ lastTurn: null, average: null })
    expect(replyCost('claude', meta({}))).toEqual({ lastTurn: null, average: null })
    expect(replyCost('gemini', meta({ context_tokens: 5, input_tokens: 9, assistant_message_count: 1 })).lastTurn).toBeNull()
  })
  test('threshold warns only above it, 0 disables', () => {
    expect(replyCostExceeds(300_001, 300_000)).toBe(true)
    expect(replyCostExceeds(300_000, 300_000)).toBe(false)
    expect(replyCostExceeds(null, 300_000)).toBe(false)
    expect(replyCostExceeds(9e9, 0)).toBe(false)
  })
})
