import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { calcCost, MODEL_PRICING } from '../types'
import { sessionCost, sumCost } from './cost'

const tok = { input: 1000, output: 500, cacheRead: 20_000, cacheWrite: 300 }

describe('sessionCost', () => {
  test('price × tokens, exact, per turn', () => {
    const model = 'claude-sonnet-5'
    expect(MODEL_PRICING[model]).toBeDefined()
    const one = calcCost({ inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 300, webSearchRequests: 0, costUSD: 0 }, model)
    const c = sessionCost([{ model, tokens: tok }, { model, tokens: tok }])
    expect(c.costUSD).toBeCloseTo(one * 2, 10)
    expect(c.basis).toBe('table×tokens')
    expect(c.priceTable).toMatch(/^MODEL_PRICING@/)
    expect(c.missing).toBeUndefined()
  })

  test('a model without a price is missing: price, never a fallback rate', () => {
    const c = sessionCost([{ model: 'no-such-model-xyz', tokens: tok }])
    expect(c.costUSD).toBeNull()
    expect(c.missing).toBe('price')
  })

  test('a turn without stored tokens is missing: tokens, never 0', () => {
    const c = sessionCost([{ model: 'claude-sonnet-5', tokens: tok }, { model: 'claude-sonnet-5', tokens: null }])
    expect(c.costUSD).toBeNull()
    expect(c.missing).toBe('tokens')
    expect(sessionCost([]).costUSD).toBeNull()
  })

  test('the models in use are priced', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'gpt-6.1-sol', 'gemini-3.8-flash']) {
      expect(sessionCost([{ model: m, tokens: tok }]).costUSD).not.toBeNull()
    }
  })
})

describe('sumCost', () => {
  const priced = (usd: number | null) => ({ costUSD: usd, basis: 'table×tokens' as const, priceTable: 'x', ...(usd === null ? { missing: 'price' as const } : {}) })
  test('reports coverage and the ids it could not price; the sum is not 0', () => {
    const s = sumCost([{ id: 'a', cost: priced(1) }, { id: 'b', cost: priced(null) }, { id: 'c', cost: priced(2) }])
    expect(s.value).toBe(3)
    expect([s.covered, s.total]).toEqual([2, 3])
    expect(s.missing).toEqual(['b'])
  })
  test('nothing priced → null, not 0', () => {
    expect(sumCost([{ id: 'a', cost: priced(null) }]).value).toBeNull()
    expect(sumCost([]).value).toBeNull()
  })
})

test('cost.ts has no entry that takes a period total to share out', () => {
  const src = readFileSync(new URL('./cost.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  expect(src).not.toMatch(/monthly|allocat|prorat|pro-rata/i)
  expect(src).not.toMatch(/\(\s*(total|period\w*)\s*:/i)
})
