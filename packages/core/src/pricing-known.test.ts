import { describe, expect, test } from 'bun:test'
import { canonicalModelId, getModelPrice, hasModelPrice, isUnpricedModel } from './types'

describe('hasModelPrice — only a model the table knows is priced; no guessed figure', () => {
  test('a known id, a dated id and a truncated id are known', () => {
    expect(hasModelPrice('claude-sonnet-4-5')).toBe(true)
    expect(hasModelPrice('claude-sonnet-4-5-20250929')).toBe(true)
  })
  test('an id the table does not know (an OpenRouter model) is not', () => {
    expect(hasModelPrice('aion-labs/aion-2.0')).toBe(false)
    expect(hasModelPrice('')).toBe(false)
  })
})


describe('gateway model ids are priced at the public API rate', () => {
  test('company gateway route upx/fable-5.1 = claude-fable-5-1', () => {
    expect(canonicalModelId('upx/fable-5.1')).toBe('claude-fable-5-1')
    expect(isUnpricedModel('upx/fable-5.1')).toBe(false)
    expect(getModelPrice('upx/fable-5.1')).toEqual(getModelPrice('claude-fable-5-1'))
  })
  test('openrouter, litellm and bedrock spellings', () => {
    expect(getModelPrice('openrouter/anthropic/claude-opus-4.8')).toEqual(getModelPrice('claude-opus-4-8'))
    expect(getModelPrice('litellm/sonnet-5')).toEqual(getModelPrice('claude-sonnet-5'))
    expect(getModelPrice('us.anthropic.claude-opus-5-5:0')).toEqual(getModelPrice('claude-opus-5-5'))
  })
  test('an unknown model behind a gateway stays unpriced', () => {
    expect(isUnpricedModel('litellm/foo')).toBe(true)
    expect(isUnpricedModel('upx/some-internal-model')).toBe(true)
  })
})
