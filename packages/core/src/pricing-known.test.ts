import { describe, expect, test } from 'bun:test'
import { hasModelPrice } from './types'

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
