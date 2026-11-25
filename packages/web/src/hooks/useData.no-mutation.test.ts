import { describe, test, expect } from 'bun:test'
import { computeDerivedStats, computeHarnessSummaries } from './useData'
import type { AppData, Filters, SessionMeta, StatsCache } from '@agentistics/core'

// CUSTO.OSCILA — the Costs and Compare pages read a total that CLIMBED on every load of the same
// data (40,16 -> 40,98 -> 41,80, always +0,82 on the `claude-sonnet-5-5` row). The unfiltered branch
// of `computeDerivedStats` copied `statsCache.modelUsage` SHALLOWLY and then `+=`'d a non-Claude
// session running a Claude model into the entry it shared with the payload, so every derivation of
// the same `AppData` added that session to Claude's own cached history once more — and the mutated
// object was what the next derivation (and the localStorage snapshot) read.
describe('deriving the dashboard never mutates the payload it derives from', () => {
  const cache = (): StatsCache => ({
    version: 1,
    lastComputedDate: '2026-11-20',
    dailyActivity: [{ date: '2026-11-20', sessionCount: 2, messageCount: 8, toolCallCount: 0 }],
    dailyModelTokens: [],
    modelUsage: {
      'claude-sonnet-5-5': {
        inputTokens: 1_000_000, outputTokens: 200_000,
        cacheReadInputTokens: 3_000_000, cacheCreationInputTokens: 100_000, webSearchRequests: 0, costUSD: 0,
      },
    },
    totalSessions: 2,
    totalMessages: 8,
    longestSession: { sessionId: 'c1', duration: 1, messageCount: 4, timestamp: '2026-11-20T10:00:00Z' },
    firstSessionDate: '2026-11-20',
    hourCounts: {},
    totalSpeculationTimeSavedMs: 0,
  } as StatsCache)

  // A NON-Claude harness driving a Claude model — the shape that shares a `modelUsage` key with
  // the Claude cache (agy, OpenCode and Kimi can all run `claude-*`).
  const other = {
    session_id: 'oc1', harness: 'opencode', start_time: '2026-11-21T10:00:00Z',
    project_path: '/p', user_message_count: 2, assistant_message_count: 2,
    input_tokens: 100_000, output_tokens: 20_000,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    model: 'claude-sonnet-5-5', tool_counts: {},
  } as unknown as SessionMeta

  const makeData = (): AppData => ({
    statsCache: cache(),
    sessions: [other],
    allSessions: [other],
    projects: [],
    harnesses: ['claude', 'opencode'],
  } as unknown as AppData)

  const filters: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] } as unknown as Filters

  test('the same payload derived twice gives the same total (a reload does not add a session)', () => {
    const data = makeData()
    const first = computeDerivedStats(data, filters)!.totalCostUSD
    const second = computeDerivedStats(data, filters)!.totalCostUSD
    const third = computeDerivedStats(data, filters)!.totalCostUSD
    expect(second).toBeCloseTo(first, 9)
    expect(third).toBeCloseTo(first, 9)
    // And equal to a derivation over a payload nobody derived before.
    expect(first).toBeCloseTo(computeDerivedStats(makeData(), filters)!.totalCostUSD, 9)
  })

  test("statsCache.modelUsage is left exactly as the server sent it", () => {
    const data = makeData()
    const before = JSON.stringify(data.statsCache)
    computeDerivedStats(data, filters)
    computeDerivedStats(data, filters, [], false)
    expect(JSON.stringify(data.statsCache)).toBe(before)
  })

  test("the Compare page's Claude column does not move after the dashboard derives", () => {
    const data = makeData()
    const claudeCost = () => computeHarnessSummaries(data).claude.costUSD
    const before = claudeCost()
    computeDerivedStats(data, filters)
    computeDerivedStats(data, filters)
    expect(claudeCost()).toBeCloseTo(before, 9)
  })
})
