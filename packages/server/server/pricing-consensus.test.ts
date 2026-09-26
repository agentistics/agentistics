import { describe, expect, test } from 'bun:test'
import { MODEL_PRICING } from '@agentistics/core'
import { vetOfficialPricing } from './pricing-consensus'

const OPUS = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }

describe('vetOfficialPricing', () => {
  test('a row that agrees with what we already had is adopted', () => {
    const r = vetOfficialPricing({ 'claude-opus-5': { ...OPUS, input: 6 } }, { 'claude-opus-5': OPUS })
    expect(r.accepted['claude-opus-5']!.input).toBe(6)
    expect(r.rejected).toEqual([])
  })

  test('the 2026-09-25 misread is refused: cache read priced at the 1h write rate, output at the hit rate', () => {
    const misread = { input: 5, output: 0.5, cacheRead: 10, cacheWrite: 25 }
    const r = vetOfficialPricing({ 'claude-opus-5': misread }, { 'claude-opus-5': OPUS })
    expect(r.accepted['claude-opus-5']).toBeUndefined()
    expect(r.rejected.map(x => x.id)).toEqual(['claude-opus-5'])
  })

  test('the misread is refused by the row invariants alone, even for a model nobody knew', () => {
    const misread = { input: 5, output: 0.5, cacheRead: 10, cacheWrite: 25 }
    const r = vetOfficialPricing({ 'claude-new-7': misread }, {})
    expect(r.accepted['claude-new-7']).toBeUndefined()
    expect(r.rejected[0]!.reason).toBe('invariant')
  })

  test('a single field far from the prior figure is enough to refuse the row', () => {
    const r = vetOfficialPricing({ 'claude-opus-5': { ...OPUS, cacheWrite: 25 } }, { 'claude-opus-5': OPUS })
    expect(r.rejected).toEqual([{ id: 'claude-opus-5', reason: 'drift', field: 'cacheWrite' }])
  })

  test('a new model with a sane row is adopted on the day it appears', () => {
    const r = vetOfficialPricing({ 'claude-new-7': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } }, {})
    expect(r.accepted['claude-new-7']).toBeDefined()
  })

  test('non-positive or non-finite figures are refused', () => {
    const r = vetOfficialPricing({ a: { ...OPUS, input: 0 }, b: { ...OPUS, output: NaN } }, {})
    expect(r.rejected.map(x => x.id).sort()).toEqual(['a', 'b'])
  })

  test('the row shapes the OpenAI and Google parsers produce pass against the built-in table', () => {
    const r = vetOfficialPricing({
      'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
      'gemini-3.6-flash': { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5 },
    }, MODEL_PRICING)
    expect(r.rejected).toEqual([])
  })
})
