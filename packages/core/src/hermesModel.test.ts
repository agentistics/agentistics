import { describe, expect, it } from 'bun:test'
import { hermesModelId } from './hermesModel'
import { priceProvenance } from './pricing-provenance'
import { HARNESS_CAPABILITIES, MODEL_PRICING, getModelPrice, hasModelCost, sessionCostUSD } from './types'

describe('hermesModelId — provider:model into the price table', () => {
  it('strips a Hermes provider prefix and routes, and prices the model', () => {
    expect(hermesModelId('anthropic:claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
    expect(hermesModelId('openrouter:anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5')
    expect(hermesModelId('anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5')
    expect(hermesModelId('openrouter/anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5')
    expect(hermesModelId('nous:anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
    expect(getModelPrice(hermesModelId('openrouter:anthropic/claude-sonnet-4.5'))).toEqual(getModelPrice('claude-sonnet-4-5'))
  })

  it('keeps a non-Claude table id in the table spelling (dots stay dots)', () => {
    const gpt = Object.keys(MODEL_PRICING).find(k => /^gpt-\d+\.\d+$/.test(k))!
    expect(hermesModelId(`openai:${gpt}`)).toBe(gpt)
    expect(hermesModelId(`openrouter/openai/${gpt}`)).toBe(gpt)
  })

  const cost = (model: string) => sessionCostUSD({ model, input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  const withCommunityRows = (fn: () => void) => {
    const row = { input: 0.2, output: 0.2, cacheRead: 0.2, cacheWrite: 0.2, cacheWrite1h: 0.2 }
    const keys = ['llama3-8b-instruct', 'gpt-oss', 'nemotron-3-nano']
    for (const k of keys) MODEL_PRICING[k] = row
    try { fn() } finally { for (const k of keys) delete MODEL_PRICING[k] }
  }
  const local = { provider: 'local' }

  it('billed locally: keeps a local route and costs nothing, even when the community table knows its name', () => withCommunityRows(() => {
    expect(getModelPrice('llama3:8b').input).toBe(0.2) // what stripping the runtime used to cause
    const cases: Record<string, string> = {
      'ollama:llama3:8b': 'ollama/llama3:8b', 'ollama/llama3:8b': 'ollama/llama3:8b', 'custom:llama3:8b': 'local/llama3:8b',
      'llama3:8b': 'local/llama3:8b', 'qwen:7b': 'local/qwen:7b', 'llama3:latest': 'local/llama3:latest',
      'lmstudio:llama3': 'lmstudio/llama3', 'lm-studio:llama3': 'lmstudio/llama3', 'local:llama3': 'local/llama3', 'vllm:llama3': 'local/llama3',
      'ollama/claude-sonnet-4-5': 'ollama/claude-sonnet-4-5',
    }
    for (const [raw, id] of Object.entries(cases)) {
      expect([raw, hermesModelId(raw, local), cost(id)]).toEqual([raw, id, 0])
    }
  }))

  it('which billing provider is local', () => {
    const of = (provider: string) => hermesModelId('llama3:8b', { provider })
    expect([of('ollama'), of('lmstudio'), of('local'), of('vllm'), of('llamacpp')])
      .toEqual(['ollama/llama3:8b', 'lmstudio/llama3:8b', 'local/llama3:8b', 'local/llama3:8b', 'llamacpp/llama3:8b'])
    expect([of('custom'), of('custom:mine'), of('openrouter')]).toEqual(Array(3).fill('unpriced/llama3:8b'))
  })

  // A `custom` endpoint says nothing about who is behind it (a localhost proxy to a paid service is
  // common) and Hermes itself calls it "unknown": never free, never a table price.
  it('a custom endpoint is always unpriced, on localhost or not', () => {
    const cases: Record<string, string> = {
      'claude-sonnet-4-5': 'unpriced/claude-sonnet-4-5', 'anthropic:claude-sonnet-4-5': 'unpriced/claude-sonnet-4-5',
      'anthropic/claude-sonnet-4.5': 'unpriced/anthropic/claude-sonnet-4.5', 'gpt-4o': 'unpriced/gpt-4o',
      'llama3:8b': 'unpriced/llama3:8b', 'ollama:llama3:8b': 'unpriced/llama3:8b',
    }
    for (const provider of ['custom', 'custom:proxy']) {
      for (const [raw, expected] of Object.entries(cases)) {
        const billing = { provider, baseUrl: 'http://localhost:4000/v1' }
        const id = hermesModelId(raw, billing)
        expect([raw, id, cost(id), priceProvenance(id)]).toEqual([raw, expected, null, null])
      }
    }
  })

  it('Ollama Cloud, an unknown provider or none: unpriced — never 0, never the community price', () => withCommunityRows(() => {
    const billings = [{ provider: 'ollama-cloud' }, { provider: 'somebody' }, { provider: '' }, { provider: null }, undefined]
    for (const raw of ['gpt-oss:120b', 'nemotron-3-nano:30b', 'custom:gpt-oss:120b', 'ollama:llama3:8b', 'llama3:8b', 'gpt-oss:cloud', 'ollama-cloud:gpt-oss:120b']) {
      for (const billing of billings) {
        const id = hermesModelId(raw, billing)
        expect([raw, billing, cost(id), getModelPrice(id).input, priceProvenance(id)]).toEqual([raw, billing, null, 0, null])
      }
    }
    // A `…cloud` tag served through a local daemon is billed by Ollama Cloud.
    expect(hermesModelId('gpt-oss:120b-cloud', local)).toBe('ollama-cloud/gpt-oss:120b-cloud')
    expect(cost('ollama-cloud/gpt-oss:120b-cloud')).toBeNull()
    expect(hermesModelId('claude-sonnet-4-5', { provider: 'ollama-cloud' })).toBe('ollama-cloud/claude-sonnet-4-5')
  }))

  it('a Bedrock version suffix is not a local tag', () => {
    expect(cost(hermesModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0', { provider: 'bedrock' }))).toBeGreaterThan(0)
  })

  it('leaves an unknown model unknown', () => {
    expect(hermesModelId('not-a-provider/thing')).toBe('not-a-provider/thing')
    expect(hermesModelId('openrouter:nousresearch/hermes-4-405b')).toBe('nousresearch/hermes-4-405b')
    expect(hermesModelId('')).toBe('')
    expect(hermesModelId(null)).toBe('')
  })

  it('an unknown model has no cost (null), never a measured 0', () => {
    const session = { model: hermesModelId('nous:hermes-4-405b'), input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(sessionCostUSD(session)).toBeNull()
  })
})

describe('hasModelCost — a per-model row', () => {
  const usage = { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }
  it('shows a declared cost for a model the table does not know, a declared 0 included', () => {
    expect(hasModelCost({ ...usage, costUSD: 0.5, costSource: 'harness' }, 'm-a')).toBe(true)
    expect(hasModelCost({ ...usage, costSource: 'harness' }, 'm-a')).toBe(true)
  })
  it('stays unknown with no declared cost, or when part was left unpriced and nothing was declared', () => {
    expect(hasModelCost(usage, 'm-a')).toBe(false)
    expect(hasModelCost({ ...usage, costSource: 'mixed', unpricedTokens: 11 }, 'm-a')).toBe(false)
    expect(hasModelCost(usage, 'claude-sonnet-4-5')).toBe(true)
  })
})

describe('hermes capabilities', () => {
  it('claims tokens, cost, model, tools and active time only', () => {
    const c = HARNESS_CAPABILITIES.hermes
    expect([c.tokens, c.cost, c.model, c.tools, c.activeTime]).toEqual([true, true, true, true, true])
    for (const k of ['agents', 'gitLines', 'dynamicWorkflows', 'contextWindow', 'compaction', 'skills', 'mcpServers'] as const) {
      expect([k, c[k]]).toEqual([k, false])
    }
  })
})
