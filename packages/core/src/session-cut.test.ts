import { describe, expect, test } from 'bun:test'
import { cutSessionUsage } from './session-cut'
import { sessionCostUSD } from './types'

const lifetime = {
  model: 'claude-opus-5-5',
  input_tokens: 1_000, output_tokens: 10_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 100_000,
  cache_creation_1h_input_tokens: 80_000, cache_creation_5m_input_tokens: 20_000,
}
const day = { input_tokens: 100, output_tokens: 1_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000 }

describe('cutSessionUsage: a session reduced to a day range prices only that range', () => {
  test('the counters are the cut, and the 1h/5m split is scaled to the cut cache writes', () => {
    const c = cutSessionUsage(lifetime, day)
    expect(c).toMatchObject({ ...day, cache_creation_1h_input_tokens: 8_000, cache_creation_5m_input_tokens: 2_000 })
  })

  test('the cut costs a tenth of the session here, not the session\'s lifetime cache writes', () => {
    const whole = sessionCostUSD(lifetime)!
    const cut = sessionCostUSD(cutSessionUsage(lifetime, day))!
    expect(cut).toBeCloseTo(whole / 10, 8)
    // The defect it replaces: the cut counters beside the LIFETIME split priced every cache write ever.
    const naive = sessionCostUSD({ ...lifetime, ...day })!
    expect(naive).toBeGreaterThan(cut * 5)
  })

  test('a model_usage breakdown is scaled per counter, so a multi-model cut keeps each model at its own rate', () => {
    const multi = {
      ...lifetime,
      model_usage: {
        'claude-opus-5-5': { inputTokens: 500, outputTokens: 5_000, cacheReadInputTokens: 500_000, cacheCreationInputTokens: 50_000, webSearchRequests: 0, costUSD: 0 },
        'claude-sonnet-5': { inputTokens: 500, outputTokens: 5_000, cacheReadInputTokens: 500_000, cacheCreationInputTokens: 50_000, webSearchRequests: 0, costUSD: 0 },
      },
    }
    const c = cutSessionUsage(multi, day)
    expect(c.model_usage!['claude-sonnet-5']).toMatchObject({ inputTokens: 50, outputTokens: 500, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 5_000 })
    expect(sessionCostUSD(c)!).toBeCloseTo(sessionCostUSD(multi)! / 10, 8)
  })

  test('a cost the harness DECLARED is cut by the same share as its tokens', () => {
    // The defect: the counters were cut (100 -> 50) but the declared `costUSD` stayed lifetime
    // (0.25), and `calcCost` returns a declared cost as given — so "today" carried the whole bill.
    const declared = {
      model: 'opencode-go/glm-5.3',
      input_tokens: 60, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      model_usage: {
        'opencode-go/glm-5.3': { inputTokens: 60, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.25, costSource: 'harness' as const, unpricedTokens: 10 },
      },
    }
    const half = { input_tokens: 30, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const c = cutSessionUsage(declared, half)
    const u = c.model_usage['opencode-go/glm-5.3']
    expect(u).toMatchObject({ inputTokens: 30, outputTokens: 20, costSource: 'harness' })
    expect(u.costUSD).toBeCloseTo(0.125, 10)
    expect(u.unpricedTokens).toBeCloseTo(5, 10)
    expect(sessionCostUSD(c)!).toBeCloseTo(0.125, 10)
    // The whole session as the range: exact, nothing moves.
    expect(sessionCostUSD(cutSessionUsage(declared, { input_tokens: 60, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }))!).toBeCloseTo(0.25, 10)
  })

  test('a declared cost on a zero-token row is kept whole, not shared out to zero', () => {
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const s = {
      model: 'x/free',
      ...zero,
      model_usage: { 'x/free': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.25, costSource: 'harness' as const } },
    }
    const c = cutSessionUsage(s, zero)
    expect(c.model_usage!['x/free']!.costUSD).toBeCloseTo(0.25, 10)
    expect(sessionCostUSD(c)).toBeCloseTo(0.25, 10)
  })

  test('a table-priced model keeps its costUSD field untouched (it is priced from the cut counters)', () => {
    const multi = {
      ...lifetime,
      model_usage: {
        'claude-opus-5-5': { inputTokens: 1_000, outputTokens: 10_000, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 100_000, webSearchRequests: 0, costUSD: 7 },
      },
    }
    const c = cutSessionUsage(multi, day)
    expect(c.model_usage!['claude-opus-5-5']!.costUSD).toBe(7)
    expect('costSource' in c.model_usage!['claude-opus-5-5']!).toBe(false)
  })

  test('no split recorded: none is invented', () => {
    const { cache_creation_1h_input_tokens: _a, cache_creation_5m_input_tokens: _b, ...plain } = lifetime
    const c = cutSessionUsage(plain, day)
    expect('cache_creation_1h_input_tokens' in c).toBe(false)
  })
})
