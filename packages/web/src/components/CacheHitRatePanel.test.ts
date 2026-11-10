import { describe, test, expect } from 'bun:test'
import { cacheSavingsRecorded } from './CacheHitRatePanel'

const row = { hitRate: 0.5, cacheReadTokens: 1000, inputTokens: 1000 }

describe('cacheSavingsRecorded', () => {
  test('only a gateway model with no known price used the cache: not recorded', () => {
    expect(cacheSavingsRecorded({ 'upx/modelo-interno': row })).toBe(false)
  })
  test('a priced model used the cache: recorded', () => {
    expect(cacheSavingsRecorded({ 'claude-sonnet-4-5': row, 'upx/modelo-interno': row })).toBe(true)
  })
  test('no cache use at all: the zeros are measured, recorded', () => {
    expect(cacheSavingsRecorded({})).toBe(true)
  })
})

describe('cacheSavingsRecorded through a gateway', () => {
  test('a gateway route to a known model is priced: recorded', () => {
    expect(cacheSavingsRecorded({ 'upx/fable-5.1': row })).toBe(true)
  })
})
