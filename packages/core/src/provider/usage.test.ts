import { describe, expect, it } from 'bun:test'
import { fromAnthropicUsage, providerUsageTokens, toModelUsage, usagePricing } from './usage'
import { totalTokens } from '../tokens'

describe('fromAnthropicUsage — the four counters', () => {
  it('never includes cache in `input`, even with huge cache numbers', () => {
    const { usage, anomalies } = fromAnthropicUsage({
      input_tokens: 2,
      output_tokens: 100,
      cache_read_input_tokens: 454714,
      cache_creation_input_tokens: 693,
    })
    expect(usage.input).toBe(2)
    expect(usage.cacheRead).toBe(454714)
    expect(usage.cacheWrite).toBe(693)
    expect(anomalies).toEqual([])
  })

  it('maps all four counters exactly, with no `missing` when every counter is present', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    })
    expect(usage).toMatchObject({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })
    expect(usage.missing).toBeUndefined()
  })

  it('produces no total field — totals only via tokens.ts', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
    })
    expect((usage as unknown as Record<string, unknown>).total).toBeUndefined()
    expect(totalTokens(providerUsageTokens(usage))).toBe(100)
  })
})

describe('fromAnthropicUsage — missing counters', () => {
  it('lists an absent counter in `missing` and sets it to the 0 placeholder', () => {
    const { usage } = fromAnthropicUsage({ input_tokens: 5, output_tokens: 7 })
    expect(usage.cacheRead).toBe(0)
    expect(usage.cacheWrite).toBe(0)
    expect(usage.missing).toEqual(['cacheRead', 'cacheWrite'])
  })

  it('treats a negative or non-finite value as absent, not as a real 0', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: -1, output_tokens: Number.NaN, cache_read_input_tokens: Number.POSITIVE_INFINITY,
      cache_creation_input_tokens: '40',
    })
    expect(usage.missing).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('leaves contextTokens absent when any input-side counter is missing', () => {
    const { usage: noCacheWrite } = fromAnthropicUsage({
      input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2,
    })
    expect(noCacheWrite.contextTokens).toBeUndefined()

    const { usage: noInput } = fromAnthropicUsage({
      output_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 3,
    })
    expect(noInput.contextTokens).toBeUndefined()
  })

  it('computes contextTokens as the input-side gauge once all three are present, output notwithstanding', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 454714, cache_creation_input_tokens: 693,
    })
    expect(usage.contextTokens).toBe(2 + 454714 + 693)
  })
})

describe('fromAnthropicUsage — cacheWriteByTtl, both-or-neither', () => {
  it('adopts the split when both buckets are present and sum to the flat figure', () => {
    const { usage, anomalies } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    })
    expect(usage.cacheWriteByTtl).toEqual({ ephemeral5m: 100, ephemeral1h: 200 })
    expect(anomalies).toEqual([])
  })

  it('drops the breakdown and records an anomaly when only one bucket is present', () => {
    const { usage, anomalies } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100 },
    })
    expect(usage.cacheWriteByTtl).toBeUndefined()
    expect(usage.cacheWrite).toBe(300) // flat figure still stands
    expect(anomalies).toEqual(['cache-ttl-split-partial'])
  })

  it('drops the breakdown and records an anomaly when the buckets do not sum to the flat figure', () => {
    const { usage, anomalies } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 999,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    })
    expect(usage.cacheWriteByTtl).toBeUndefined()
    expect(usage.cacheWrite).toBe(999)
    expect(anomalies).toEqual(['cache-ttl-split-mismatch'])
  })

  it('drops the breakdown when the flat cacheWrite figure itself is missing', () => {
    const { usage, anomalies } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    })
    expect(usage.cacheWriteByTtl).toBeUndefined()
    expect(anomalies).toEqual(['cache-ttl-split-mismatch'])
  })

  it('is silent (no breakdown, no anomaly) when neither bucket is present at all', () => {
    const { usage, anomalies } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 300,
    })
    expect(usage.cacheWriteByTtl).toBeUndefined()
    expect(anomalies).toEqual([])
  })
})

describe('fromAnthropicUsage — reasoning: absent is not `unknown`', () => {
  it('is absent when Anthropic states no thinking-details field, distinguishably from a real reading', () => {
    const { usage } = fromAnthropicUsage({ input_tokens: 1, output_tokens: 1 })
    expect(usage.reasoning).toBeUndefined()
    expect('reasoning' in usage).toBe(false)
  })

  it('is carried as billing:"unknown" when output_tokens_details.thinking_tokens is a number', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 50, output_tokens_details: { thinking_tokens: 12 },
    })
    expect(usage.reasoning).toEqual({ tokens: 12, billing: 'unknown' })
  })

  it('the two cases are distinguishable, never collapsed into the same shape', () => {
    const { usage: absent } = fromAnthropicUsage({ input_tokens: 1, output_tokens: 1 })
    const { usage: present } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, output_tokens_details: { thinking_tokens: 0 },
    })
    expect(absent.reasoning).toBeUndefined()
    expect(present.reasoning).toEqual({ tokens: 0, billing: 'unknown' })
  })
})

describe('fromAnthropicUsage — iterations: carried verbatim, never folded', () => {
  it('carries each element verbatim (deep-equal raw) and preserves the count', () => {
    const el1 = { type: 'compaction', model: 'claude-haiku-5', input_tokens: 500, output_tokens: 20 }
    const el2 = { type: 'advisor_message', input_tokens: 10, output_tokens: 5 }
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, iterations: [el1, el2],
    })
    expect(usage.iterations).toHaveLength(2)
    expect(usage.iterations?.[0]).toEqual({ kind: 'compaction', model: 'claude-haiku-5', raw: el1 })
    expect(usage.iterations?.[1]).toEqual({ kind: 'advisor_message', raw: el2 })
  })

  it('sets iterationsRelation to "unmeasured", the only value this reader can state', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, iterations: [{ type: 'message' }],
    })
    expect(usage.iterationsRelation).toBe('unmeasured')
  })

  it('never sums iteration tokens into the four counters', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      iterations: [{ type: 'compaction', input_tokens: 999999, output_tokens: 999999 }],
    })
    expect(usage.input).toBe(100)
    expect(usage.output).toBe(200)
    expect(providerUsageTokens(usage)).toEqual({ input: 100, output: 200, cacheRead: 0, cacheWrite: 0 })
  })

  it('is absent when the array is empty', () => {
    const { usage } = fromAnthropicUsage({ input_tokens: 1, output_tokens: 1, iterations: [] })
    expect(usage.iterations).toBeUndefined()
    expect(usage.iterationsRelation).toBeUndefined()
  })

  it('falls back to kind "unknown" for a non-object element and for a missing/non-string type, dropping nothing', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, iterations: ['not-an-object', { foo: 'bar' }, { type: 42 }],
    })
    expect(usage.iterations).toHaveLength(3)
    expect(usage.iterations?.[0]).toEqual({ kind: 'unknown', raw: { value: 'not-an-object' } })
    expect(usage.iterations?.[1]).toEqual({ kind: 'unknown', raw: { foo: 'bar' } })
    expect(usage.iterations?.[2]).toEqual({ kind: 'unknown', raw: { type: 42 } })
  })
})

describe('fromAnthropicUsage — serverToolUse', () => {
  it('carries web_search_requests as a count', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 3 },
    })
    expect(usage.serverToolUse).toEqual({ webSearchRequests: 3 })
  })

  it('is absent with no server_tool_use object', () => {
    const { usage } = fromAnthropicUsage({ input_tokens: 1, output_tokens: 1 })
    expect(usage.serverToolUse).toBeUndefined()
  })
})

describe('fromAnthropicUsage — non-object input', () => {
  it('marks every counter missing and records usage-not-an-object for null', () => {
    const { usage, anomalies } = fromAnthropicUsage(null)
    expect(usage).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      missing: ['input', 'output', 'cacheRead', 'cacheWrite'],
    })
    expect(anomalies).toEqual(['usage-not-an-object'])
  })

  it('does the same for a primitive, an array, and undefined', () => {
    for (const bad of ['nope', 42, [1, 2, 3], undefined]) {
      const { anomalies } = fromAnthropicUsage(bad)
      expect(anomalies).toEqual(['usage-not-an-object'])
    }
  })
})

describe('providerUsageTokens / totalTokens — reasoning and iterations never leak in', () => {
  it('ignores a billing:"unknown" reasoning count entirely', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      output_tokens_details: { thinking_tokens: 999 },
    })
    expect(totalTokens(providerUsageTokens(usage))).toBe(30)
  })

  it('ignores iterations entirely', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      iterations: [{ type: 'compaction', input_tokens: 5000, output_tokens: 5000 }],
    })
    expect(totalTokens(providerUsageTokens(usage))).toBe(30)
  })
})

describe('toModelUsage', () => {
  it('maps the four counters and defaults webSearchRequests to 0 when absent', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
    })
    expect(toModelUsage(usage)).toEqual({
      inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4,
      webSearchRequests: 0,
    })
  })

  it('carries webSearchRequests through when present', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
      server_tool_use: { web_search_requests: 7 },
    })
    expect(toModelUsage(usage).webSearchRequests).toBe(7)
  })

  it('maps cacheWriteByTtl onto the 1h/5m ModelUsage fields when present', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    })
    const modelUsage = toModelUsage(usage)
    expect(modelUsage.cacheCreation5mInputTokens).toBe(100)
    expect(modelUsage.cacheCreation1hInputTokens).toBe(200)
    expect(modelUsage.cacheCreationInputTokens).toBe(300)
  })

  it('has neither 1h/5m field when there is no adopted split', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 300,
    })
    const modelUsage = toModelUsage(usage)
    expect(modelUsage.cacheCreation1hInputTokens).toBeUndefined()
    expect(modelUsage.cacheCreation5mInputTokens).toBeUndefined()
  })

  it('never returns a costUSD field — this module counts, it never prices', () => {
    const { usage } = fromAnthropicUsage({ input_tokens: 1, output_tokens: 1 })
    expect('costUSD' in toModelUsage(usage)).toBe(false)
  })
})

describe('usagePricing', () => {
  it('is "complete" when every counter is present and there are no iterations', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    })
    expect(usagePricing(usage)).toBe('complete')
  })

  it('is "partial" when a counter is missing', () => {
    const { usage } = fromAnthropicUsage({ input_tokens: 1, output_tokens: 1 })
    expect(usagePricing(usage)).toBe('partial')
  })

  it('is "partial" when iterations are present, even with every counter accounted for', () => {
    const { usage } = fromAnthropicUsage({
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      iterations: [{ type: 'message' }],
    })
    expect(usagePricing(usage)).toBe('partial')
  })

  it('is "partial" for a non-object raw body (everything missing)', () => {
    const { usage } = fromAnthropicUsage(undefined)
    expect(usagePricing(usage)).toBe('partial')
  })
})
