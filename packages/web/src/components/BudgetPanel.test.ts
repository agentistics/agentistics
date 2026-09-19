import { describe, test, expect } from 'bun:test'
import { computeMonthCost } from './BudgetPanel'
import type { StatsCache, ModelUsage } from '@agentistics/core'

/**
 * `computeMonthCost` apportions a day's per-model TOTAL token count by the model's GLOBAL
 * (`statsCache.modelUsage`) proportions — see the function's own doc. Every fixture below uses a
 * single day / single model whose day total equals the model's global total, so the apportionment
 * ratio is exactly 1 and the expected numbers can be read straight off the model's own price.
 *
 * Model: claude-opus-4-8 — input 5, output 25, cacheRead 0.5, cacheWrite (5m) 6.25,
 * cacheWrite1h (2x base input) 10.
 */

function usage(overrides: Partial<ModelUsage>): ModelUsage {
  return {
    inputTokens: 500_000, outputTokens: 200_000, cacheReadInputTokens: 100_000,
    cacheCreationInputTokens: 200_000, webSearchRequests: 0, costUSD: 0,
    ...overrides,
  }
}

function statsCacheFor(modelId: string, u: ModelUsage, dayTokens: number): StatsCache {
  return {
    version: 1,
    lastComputedDate: '2026-03-31',
    dailyActivity: [],
    dailyModelTokens: [{ date: '2026-04-15', tokensByModel: { [modelId]: dayTokens } }],
    modelUsage: { [modelId]: u },
    totalSessions: 0,
    totalMessages: 0,
    longestSession: { sessionId: 'x', duration: 1, messageCount: 1, timestamp: '2026-04-01T00:00:00Z' },
    firstSessionDate: '2026-04-01',
    hourCounts: {},
    totalSpeculationTimeSavedMs: 0,
  }
}

const MONTH_START = new Date('2026-04-01T00:00:00Z')
const NOW = new Date('2026-04-30T00:00:00Z')
const MODEL = 'claude-opus-4-8'

describe('computeMonthCost — cache-write TTL rate', () => {
  test('a 1h-only cache write (both TTL fields stated) is priced at 2x, not the flat 5m rate', () => {
    const sc = statsCacheFor(MODEL, usage({
      cacheCreation1hInputTokens: 200_000, cacheCreation5mInputTokens: 0,
    }), 1_000_000)
    // input 2.5 + output 5.0 + cacheRead 0.05 + cacheWrite(1h) (200_000/1e6)*10=2.0
    expect(computeMonthCost(sc, MONTH_START, NOW)).toBeCloseTo(9.55)
  })

  test('a 5m-only cache write (both TTL fields stated) is priced at the 1.25x rate', () => {
    const sc = statsCacheFor(MODEL, usage({
      cacheCreation1hInputTokens: 0, cacheCreation5mInputTokens: 200_000,
    }), 1_000_000)
    // input 2.5 + output 5.0 + cacheRead 0.05 + cacheWrite(5m) (200_000/1e6)*6.25=1.25
    expect(computeMonthCost(sc, MONTH_START, NOW)).toBeCloseTo(8.8)
  })

  test('a mixed 1h/5m cache write sums each portion at its own rate', () => {
    const sc = statsCacheFor(MODEL, usage({
      cacheCreation1hInputTokens: 120_000, cacheCreation5mInputTokens: 80_000,
    }), 1_000_000)
    // cacheWrite = (120_000/1e6)*10 + (80_000/1e6)*6.25 = 1.2 + 0.5 = 1.7
    // total = 2.5 + 5.0 + 0.05 + 1.7
    expect(computeMonthCost(sc, MONTH_START, NOW)).toBeCloseTo(9.25)
  })

  test('no TTL fields at all falls back to the whole counter at the conservative 5-minute rate — same figure as the genuinely-all-5m case', () => {
    const sc = statsCacheFor(MODEL, usage({}), 1_000_000)
    expect(computeMonthCost(sc, MONTH_START, NOW)).toBeCloseTo(8.8)
  })

  test('a HALF-present breakdown (one TTL field stated, the other genuinely undefined) is treated as no breakdown, never a partial one', () => {
    const sc = statsCacheFor(MODEL, usage({
      cacheCreation1hInputTokens: 50_000,
      // cacheCreation5mInputTokens intentionally left undefined.
    }), 1_000_000)
    expect(computeMonthCost(sc, MONTH_START, NOW)).toBeCloseTo(8.8)
  })

  test('a zero-cache-write month prices the cache term to exactly zero, whichever branch runs', () => {
    const withSplit = statsCacheFor(MODEL, usage({
      cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0, cacheCreation5mInputTokens: 0,
    }), 800_000)
    // gTotal now 500_000+200_000+100_000+0 = 800_000, matching the day total.
    // input 2.5 + output 5.0 + cacheRead 0.05 + cacheWrite 0
    expect(computeMonthCost(withSplit, MONTH_START, NOW)).toBeCloseTo(7.55)

    const noSplit = statsCacheFor(MODEL, usage({ cacheCreationInputTokens: 0 }), 800_000)
    expect(computeMonthCost(noSplit, MONTH_START, NOW)).toBeCloseTo(7.55)
  })

  test('a day outside the month contributes nothing', () => {
    const sc = statsCacheFor(MODEL, usage({
      cacheCreation1hInputTokens: 200_000, cacheCreation5mInputTokens: 0,
    }), 1_000_000)
    sc.dailyModelTokens = [{ date: '2026-03-15', tokensByModel: { [MODEL]: 1_000_000 } }]
    expect(computeMonthCost(sc, MONTH_START, NOW)).toBe(0)
  })

  test('a model with no global row falls back to the 70/30 Sonnet-rate estimate, unaffected by this change', () => {
    const sc: StatsCache = {
      version: 1, lastComputedDate: '2026-03-31', dailyActivity: [],
      dailyModelTokens: [{ date: '2026-04-15', tokensByModel: { 'unknown-model': 1_000_000 } }],
      modelUsage: {}, totalSessions: 0, totalMessages: 0,
      longestSession: { sessionId: 'x', duration: 1, messageCount: 1, timestamp: '2026-04-01T00:00:00Z' },
      firstSessionDate: '2026-04-01', hourCounts: {}, totalSpeculationTimeSavedMs: 0,
    }
    // (1_000_000*0.7/1e6)*3 + (1_000_000*0.3/1e6)*15 = 2.1 + 4.5
    expect(computeMonthCost(sc, MONTH_START, NOW)).toBeCloseTo(6.6)
  })
})
