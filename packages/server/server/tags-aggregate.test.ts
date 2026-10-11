import { test, expect } from 'bun:test'
import { aggregateSessions } from './tags-aggregate'
import type { SessionMeta } from '@agentistics/core'
import { EMPTY_TOKENS, totalTokens } from '@agentistics/core'

function s(over: Partial<SessionMeta>): SessionMeta {
  return {
    session_id: 'x', project_path: '/p', harness: 'claude',
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    ...over,
  } as SessionMeta
}

test('empty input yields zeroes and null tops', () => {
  expect(aggregateSessions([])).toEqual({
    costByHarness: {},
    sessions: 0, costUSD: 0, inputTokens: 0, outputTokens: 0, tokens: EMPTY_TOKENS, unpricedTokens: 0,
    topProject: null, topModel: null, topHarness: null,
  })
})

test('the tokens total carries the cache counters, not just the conversation', () => {
  // The regression the whole `tokens` field exists for: a tag's "Tokens" card summed two of the
  // four and reported a fraction of a percent of the real volume on any cached workload.
  const out = aggregateSessions([
    s({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 5_000 }),
  ])
  expect(out.tokens).toEqual({ input: 100, output: 10, cacheRead: 900_000, cacheWrite: 5_000 })
  expect(totalTokens(out.tokens)).toBe(905_110)
  // The conversational pair is still reported, and is still not the total.
  expect(out.inputTokens + out.outputTokens).toBe(110)
})

test('sums tokens and counts sessions', () => {
  const out = aggregateSessions([
    s({ input_tokens: 100, output_tokens: 10, model: 'claude-opus-4-6' }),
    s({ input_tokens: 50, output_tokens: 5, model: 'claude-opus-4-6' }),
  ])
  expect(out.sessions).toBe(2)
  expect(out.inputTokens).toBe(150)
  expect(out.outputTokens).toBe(15)
  expect(out.costUSD).toBeGreaterThan(0)
})

test('top project/model/harness are the most frequent values', () => {
  const out = aggregateSessions([
    s({ project_path: '/a', model: 'claude-opus-4-6', harness: 'claude' }),
    s({ project_path: '/a', model: 'claude-sonnet-4-6', harness: 'claude' }),
    s({ project_path: '/b', model: 'claude-opus-4-6', harness: 'codex' }),
    s({ project_path: '/a', model: 'claude-opus-4-6', harness: 'claude' }),
  ])
  expect(out.topProject).toBe('/a')
  expect(out.topModel).toBe('claude-opus-4-6')
  expect(out.topHarness).toBe('claude')
})

test('sessions with no model do not produce a phantom top model', () => {
  const out = aggregateSessions([s({}), s({})])
  expect(out.topModel).toBeNull()
})

test('PRICE.UNKNOWN: a session of an unknown model (or none) is counted in tokens, never priced; the total says how much it left out', () => {
  const out = aggregateSessions([
    s({ input_tokens: 1000, output_tokens: 100, model: 'claude-opus-4-6' }),
    s({ input_tokens: 400, output_tokens: 100, model: 'some-new-model' }),
    s({ input_tokens: 10, output_tokens: 0 }),
  ])
  expect(out.inputTokens).toBe(1410)
  expect(out.unpricedTokens).toBe(510)
  const priced = aggregateSessions([s({ input_tokens: 1000, output_tokens: 100, model: 'claude-opus-4-6' })])
  expect(out.costUSD).toBeCloseTo(priced.costUSD)
  expect(priced.unpricedTokens).toBe(0)
})

test('costByHarness splits costUSD per harness and sums back to it', () => {
  const mk = (harness: string, model: string): SessionMeta => ({
    session_id: harness, project_path: '/p', start_time: '2026-01-01T00:00:00Z', harness, model,
    input_tokens: 1000, output_tokens: 1000,
  } as unknown as SessionMeta)
  const agg = aggregateSessions([mk('claude', 'claude-sonnet-4-6'), mk('codex', 'gpt-5'), mk('claude', 'claude-sonnet-4-6')])
  expect(Object.keys(agg.costByHarness).sort()).toEqual(['claude', 'codex'])
  expect(Object.values(agg.costByHarness).reduce((a, b) => a + b, 0)).toBeCloseTo(agg.costUSD)
})
