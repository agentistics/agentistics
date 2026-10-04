import { describe, expect, test } from 'bun:test'
import { MODEL_PRICING, pricingKey } from './types'
import { PRICE_PROVENANCE, priceProvenance } from './pricing-provenance'

describe('price provenance (ST-02)', () => {
  test('every priced row says where its rates were read', () => {
    expect(Object.keys(MODEL_PRICING).filter(k => !PRICE_PROVENANCE[k])).toEqual([])
    expect(Object.keys(PRICE_PROVENANCE).filter(k => !MODEL_PRICING[k])).toEqual([])
  })

  test('a suffixed id resolves to its row, the same row getModelPrice uses', () => {
    expect(pricingKey('gemini-3.6-flash-tiered')).toBe('gemini-3.6-flash')
    expect(priceProvenance('claude-opus-5-5')).toEqual({ source: 'platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-09-25' })
  })

  test('an unknown model has no source — N/A, never the fallback rate', () => {
    expect(pricingKey('mistral-large-3')).toBeNull()
    expect(priceProvenance('mistral-large-3')).toBeNull()
  })

  test('a legacy row with no recorded date says null, not a neighbour\'s date', () => {
    expect(priceProvenance('claude-3-haiku-20240307')).toEqual({ source: 'platform.claude.com/docs/en/about-claude/pricing', verifiedAt: null })
  })
})
