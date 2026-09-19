import { test, expect } from 'bun:test'
import { isLocalModelId } from './local-models'
import { getModelPrice, calcCost } from './types'

const usage = (i: number, o: number) => ({
  inputTokens: i, outputTokens: o, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
  webSearchRequests: 0, costUSD: 0,
})

test('recognises the runtimes that serve a model off your own machine', () => {
  expect(isLocalModelId('ollama-local/qwen2.5-coder-7b')).toBe(true)
  expect(isLocalModelId('ollama/llama3.1')).toBe(true)
  expect(isLocalModelId('lmstudio/qwen2.5')).toBe(true)
  expect(isLocalModelId('llamacpp/mistral')).toBe(true)
  expect(isLocalModelId('local/whatever')).toBe(true)
})

test('is case-insensitive, because a harness may stamp the id however it likes', () => {
  expect(isLocalModelId('Ollama-Local/Qwen')).toBe(true)
})

test('a hosted model is never mistaken for a local one', () => {
  expect(isLocalModelId('claude-opus-5')).toBe(false)
  expect(isLocalModelId('gpt-5.5')).toBe(false)
  expect(isLocalModelId('google/gemini-3-flash')).toBe(false)
  expect(isLocalModelId('kimi-k2')).toBe(false)
})

test('a name that merely CONTAINS a runtime word is not a local model', () => {
  // The prefix is the claim; "ollama" appearing later says nothing about who served it.
  expect(isLocalModelId('acme-ollama-clone')).toBe(false)
  expect(isLocalModelId('vendor/local-llm')).toBe(false)
})

test('a local model is free — not the shared fallback price', () => {
  const p = getModelPrice('ollama-local/qwen2.5-coder-7b')
  expect(p).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 })
  expect(calcCost(usage(2050, 67), 'ollama-local/qwen2.5-coder-7b')).toBe(0)
})

test('the fallback still applies to an unknown HOSTED model', () => {
  expect(getModelPrice('some-new-hosted-model').input).toBeGreaterThan(0)
  expect(calcCost(usage(2050, 67), 'some-new-hosted-model')).toBeGreaterThan(0)
})
