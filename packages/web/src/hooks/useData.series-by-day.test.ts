import { describe, expect, test } from 'bun:test'
import type { AppData, Filters, SessionMeta } from '@agentistics/core'
import { computeDerivedStats, summarizeApiCostByDay } from './useData'
import { computePlanBasisView } from './usePlanBasis'

/**
 * A session is a span: its per-day series go on the days it WORKED, from the same day slices the
 * period cut uses — never the whole session on the day it started.
 */

const model = 'claude-sonnet-5-5'
const ocModel = 'opencode-go/glm-5.3'
const day = (tokens: number, messages: number) => ({
  input_tokens: tokens, output_tokens: tokens / 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages,
})

/** Claude, worked 09-03, 09-04 and 09-05 (shares 6:3:1). */
const claude = {
  session_id: 'cl', harness: 'claude', project_path: '/p', model, git_remote: 'github.com/o/r',
  start_time: '2026-09-03T12:00:00.000Z',
  input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  user_message_count: 10, assistant_message_count: 10,
  tool_counts: { Bash: 20, Read: 7 },
  daily: { '2026-09-03': day(600_000, 12), '2026-09-04': day(300_000, 6), '2026-09-05': day(100_000, 2) },
} as unknown as SessionMeta

/** Non-Claude with a declared cost, same three days (halves: 50 / 30 / 20 %). */
const opencode = {
  session_id: 'oc', harness: 'opencode', project_path: '/p', model: ocModel, git_remote: 'github.com/o/r',
  start_time: '2026-09-03T12:00:00.000Z',
  input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  user_message_count: 5, assistant_message_count: 5,
  tool_counts: { bash: 10 },
  model_usage: { [ocModel]: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 1, costSource: 'harness' } },
  daily: { '2026-09-03': day(500, 5), '2026-09-04': day(300, 3), '2026-09-05': day(200, 2) },
} as unknown as SessionMeta

const dataOf = (sessions: SessionMeta[], statsCache: Record<string, unknown> = {}) => ({
  statsCache: { version: 1, lastComputedDate: '2026-08-01', dailyActivity: [], dailyModelTokens: [], modelUsage: {}, totalSessions: 0, totalMessages: 0, hourCounts: {}, ...statsCache },
  sessions, allSessions: [], projects: [], harnesses: ['claude', 'opencode'],
} as unknown as AppData)

const both = dataOf([claude, opencode])
const range = (from: string, to: string, more: Partial<Filters> = {}) =>
  ({ dateRange: 'custom', customStart: from, customEnd: to, projects: [], models: [], ...more }) as unknown as Filters
const all = (more: Partial<Filters> = {}) =>
  ({ dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [], ...more }) as unknown as Filters

type D = NonNullable<ReturnType<typeof computeDerivedStats>>
const costDays = (d: D) => Object.values(d.apiCostByDay.days).flatMap(byDay => Object.entries(byDay!))
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const datesOf = (xs: readonly { date: string }[]) => xs.map(x => x.date).sort()

/** Every per-day series adds up to the card above it, inside the window; sessions count once. */
function expectClosed(d: D, from: string, to: string, sessions: number) {
  const inside = (day: string) => day >= from && day <= to
  expect(d.totalSessions).toBe(sessions)
  expect(datesOf(d.heatmapData).filter(x => !inside(x))).toEqual([])
  expect(sum(d.heatmapData.map(h => h.value))).toBe(d.totalMessages)
  expect(sum(d.heatmapData.map(h => h.tools))).toBe(d.totalToolCalls)
  const split = Object.values(d.heatmapByHarness).flat()
  expect(datesOf(split).filter(x => !inside(x))).toEqual([])
  expect(sum(split.map(h => h.value))).toBe(d.totalMessages)
  expect(costDays(d).map(([k]) => k).filter(x => !inside(x))).toEqual([])
  expect(sum(costDays(d).map(([, e]) => e.costUSD))).toBeCloseTo(d.totalCostUSD, 8)
  expect(d.apiCostByDay.undatedCostUSD).toBeCloseTo(0, 8)
}

const views: [string, Partial<Filters>][] = [
  ['unified (cache branch)', {}],
  ['project filter (session branch)', { projects: ['/p'] }],
  ['harness opencode', { harnesses: ['opencode'] }],
  ['harness claude', { harnesses: ['claude'] }],
]

describe('per-day series: a session started BEFORE the window keeps its in-window part', () => {
  for (const [name, more] of views) {
    const n = more.harnesses ? 1 : 2

    test(`${name}: one day of a three-day session lands on that day only`, () => {
      const d = computeDerivedStats(both, range('2026-09-05', '2026-09-05', more))!
      expect(datesOf(d.heatmapData)).toEqual(['2026-09-05'])
      expectClosed(d, '2026-09-05', '2026-09-05', n)
    })

    test(`${name}: two days of three, series sum == period total`, () => {
      const d = computeDerivedStats(both, range('2026-09-04', '2026-09-05', more))!
      expect(datesOf(d.heatmapData)).toEqual(['2026-09-04', '2026-09-05'])
      expectClosed(d, '2026-09-04', '2026-09-05', n)
    })

    test(`${name}: all time spreads over the three days`, () => {
      const d = computeDerivedStats(both, all(more))!
      expect(datesOf(d.heatmapData)).toEqual(['2026-09-03', '2026-09-04', '2026-09-05'])
      // Over all time those two views take Claude's headline from the cumulative cache, empty here.
      if (name !== 'unified (cache branch)' && name !== 'harness claude') expectClosed(d, '2026-09-03', '2026-09-05', n)
      else expect(d.totalSessions).toBe(n)
    })
  }

  test("cost per day is that day's share, not the whole session on its first day", () => {
    const d = computeDerivedStats(both, all({ harnesses: ['opencode'] }))!
    const byDay = d.apiCostByDay.days.opencode!
    expect(byDay['2026-09-03']!.costUSD).toBeCloseTo(0.5, 8)
    expect(byDay['2026-09-04']!.costUSD).toBeCloseTo(0.3, 8)
    expect(byDay['2026-09-05']!.costUSD).toBeCloseTo(0.2, 8)
    expect(byDay['2026-09-03']!.tokens).toBe(550)
    expect(byDay['2026-09-04']!.tokens).toBe(330)
  })

  test('a session is counted once in the cost series, however many days it spans', () => {
    const d = computeDerivedStats(both, all({ projects: ['/p'] }))!
    expect(sum(costDays(d).map(([, e]) => e.sessions))).toBe(2)
  })

  test('a declared cost on a row with no tokens is not repeated on every day', () => {
    const odd = {
      ...opencode, session_id: 'z',
      model_usage: { ...opencode.model_usage, extra: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 3, costSource: 'harness' } },
    } as unknown as SessionMeta
    const d = computeDerivedStats(dataOf([odd]), all({ harnesses: ['opencode'] }))!
    expect(d.totalCostUSD).toBeCloseTo(4, 8)
    expect(sum(costDays(d).map(([, e]) => e.costUSD))).toBeCloseTo(4, 8)
  })

  test('the repository sparkline counts the days worked inside the window', () => {
    const d = computeDerivedStats(both, range('2026-09-04', '2026-09-05'))!
    expect(d.repoStats[0]!.activityByDay).toEqual({ '2026-09-04': 2, '2026-09-05': 2 })
  })

  test('the cache branch never dates more than the headline it decomposes', () => {
    // The cache holds more for 09-05 than the local sessions do, so that day is priced from the cache
    // — while the session's own share of it, all output, costs MORE than the apportioned figure.
    const outputOnly = {
      ...claude,
      daily: { ...claude.daily, '2026-09-05': { input_tokens: 0, output_tokens: 300_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 2 } },
    } as unknown as SessionMeta
    const data = dataOf([outputOnly], {
      lastComputedDate: '2026-09-05',
      dailyActivity: [{ date: '2026-09-05', messageCount: 9, sessionCount: 3, toolCallCount: 4 }],
      dailyModelTokens: [{ date: '2026-09-05', tokensByModel: { [model]: 500_000 } }],
    })
    const d = computeDerivedStats(data, range('2026-09-04', '2026-09-05'))!
    expect(sum(costDays(d).map(([, e]) => e.costUSD))).toBeCloseTo(d.totalCostUSD, 8)
    expect(d.apiCostByDay.undatedCostUSD).toBeCloseTo(0, 8)
    expect(datesOf(d.heatmapData)).toEqual(['2026-09-04', '2026-09-05'])
  })
})

describe('the cards count a session once, and all time keeps the lifetime counters', () => {
  test('a day the cache holds adds its own count; the session that started elsewhere adds one', () => {
    const data = dataOf([claude], { dailyActivity: [{ date: '2026-09-05', messageCount: 9, sessionCount: 3, toolCallCount: 4 }] })
    const d = computeDerivedStats(data, range('2026-09-03', '2026-09-05'))!
    expect(d.totalSessions).toBe(4)
    expect(d.totalMessages).toBe(9 + 12 + 6)
  })

  /** A day split that records MORE messages than the session's lifetime counters, as real ones do. */
  const noisy = {
    ...claude,
    daily: { '2026-09-03': day(600_000, 30), '2026-09-04': day(300_000, 20), '2026-09-05': day(100_000, 10) },
  } as unknown as SessionMeta

  test('all time reads the lifetime counters; a bounded range reads the days', () => {
    const d = computeDerivedStats(dataOf([noisy]), all())!
    expect(d.totalMessages).toBe(20)
    expect(d.totalToolCalls).toBe(27)
    expect(d.totalSessions).toBe(1)
    // The calendar still draws the day split.
    expect(d.heatmapData.map(h => h.value)).toEqual([30, 20, 10])
    expect(computeDerivedStats(dataOf([noisy]), range('2026-09-04', '2026-09-05'))!.totalMessages).toBe(30)
  })

  test('all time leaves a session that started on a cached day to the cache', () => {
    const data = dataOf([noisy], { dailyActivity: [{ date: '2026-09-03', messageCount: 9, sessionCount: 1, toolCallCount: 4 }] })
    const d = computeDerivedStats(data, all())!
    expect(d.totalMessages).toBe(9)
    expect(d.totalToolCalls).toBe(4)
    expect(d.totalSessions).toBe(1)
  })
})

describe('the day split itself', () => {
  test('work no day records stays undated, never spread over the days', () => {
    const half = { ...opencode, daily: { '2026-09-03': day(250, 5), '2026-09-04': day(250, 5) } } as unknown as SessionMeta
    const d = computeDerivedStats(dataOf([half]), all({ harnesses: ['opencode'] }))!
    const dated = sum(costDays(d).map(([, e]) => e.costUSD))
    expect(d.totalCostUSD).toBeCloseTo(1, 8)
    expect(dated).toBeLessThan(0.9)
    expect(d.apiCostByDay.undatedCostUSD).toBeCloseTo(1 - dated, 8)
  })

  test('a session is counted on its FIRST worked day', () => {
    const d = computeDerivedStats(dataOf([opencode]), all({ harnesses: ['opencode'] }))!
    const byDay = d.apiCostByDay.days.opencode!
    expect(['2026-09-03', '2026-09-04', '2026-09-05'].map(x => byDay[x]!.sessions)).toEqual([1, 0, 0])
  })

  test('the headline-dated cost series still counts the Claude session', () => {
    const d = computeDerivedStats(dataOf([claude]), range('2026-09-03', '2026-09-05'))!
    expect(sum(costDays(d).map(([, e]) => e.sessions))).toBe(1)
  })

  test('a day with no message and no token is not a worked day', () => {
    const hollow = {
      ...claude, daily: { '2026-09-03': day(600_000, 12), '2026-09-04': day(0, 0), '2026-09-05': day(400_000, 8) },
    } as unknown as SessionMeta
    const d = computeDerivedStats(dataOf([hollow]), all({ projects: ['/p'] }))!
    expect(datesOf(d.heatmapData)).toEqual(['2026-09-03', '2026-09-05'])
  })

  test('small counts over equal days still add up: the rounding is cumulative', () => {
    const small = {
      ...claude, tool_counts: { Grep: 1, Glob: 2, Bash: 5 },
      daily: { '2026-09-03': day(100, 1), '2026-09-04': day(100, 1), '2026-09-05': day(100, 1) },
    } as unknown as SessionMeta
    const total: Record<string, number> = {}
    for (const x of ['2026-09-03', '2026-09-04', '2026-09-05']) {
      const d = computeDerivedStats(dataOf([small]), range(x, x, { projects: ['/p'] }))!
      for (const [name, c] of Object.entries(d.toolCounts)) total[name] = (total[name] ?? 0) + c
    }
    expect(total).toEqual({ Grep: 1, Glob: 2, Bash: 5 })
  })
})

describe('plan basis keeps the in-window part of a session started before the window', () => {
  test('A of the plan is the period total', () => {
    const filters = range('2026-09-04', '2026-09-05', { projects: ['/p'], harnesses: ['claude'] })
    const d = computeDerivedStats(dataOf([claude]), filters)!
    const view = computePlanBasisView({
      apiCostByDay: d.apiCostByDay,
      billing: { profiles: { claude: { periods: [{ id: 'bp_a', mode: 'subscription', planId: 'anthropic-max-5x', from: '2026-01-01', price: { amount: 100, currency: 'USD' } }] } } },
      brlRate: 5.5, filters, today: '2026-09-30',
    })
    expect(d.totalCostUSD).toBeGreaterThan(0)
    expect(view.basis!.perHarness.claude!.apiCostUSD).toBeCloseTo(d.totalCostUSD, 8)
  })
})

describe('tool_counts are cut with the session, by the day share of its messages', () => {
  const only = (from: string, to: string) => computeDerivedStats(both, range(from, to, { projects: ['/p'] }))!

  test('one day carries its share, not the lifetime counts', () => {
    const d = computeDerivedStats(dataOf([claude]), range('2026-09-04', '2026-09-04', { projects: ['/p'] }))!
    // 6 of 20 messages.
    expect(d.toolCounts).toEqual({ Bash: 6, Read: 2 })
    expect(d.totalToolCalls).toBe(8)
    expect(d.filteredSessions[0]!.tool_counts).toEqual({ Bash: 6, Read: 2 })
  })

  test('the three one-day views add up to the lifetime counts exactly', () => {
    const parts = ['2026-09-03', '2026-09-04', '2026-09-05'].map(x => only(x, x))
    expect(sum(parts.map(p => p.toolCounts.Bash ?? 0))).toBe(20)
    expect(sum(parts.map(p => p.toolCounts.Read ?? 0))).toBe(7)
    expect(sum(parts.map(p => p.toolCounts.bash ?? 0))).toBe(10)
  })

  test('tool output tokens are cut the same way, and all time is untouched', () => {
    const s = { ...claude, tool_output_tokens: { Bash: 2000 } } as unknown as SessionMeta
    const one = computeDerivedStats(dataOf([s]), range('2026-09-03', '2026-09-03', { projects: ['/p'] }))!
    expect(one.toolOutputTokens).toEqual({ Bash: 1200 })
    const whole = computeDerivedStats(dataOf([s]), all({ projects: ['/p'] }))!
    expect(whole.toolOutputTokens).toEqual({ Bash: 2000 })
    expect(whole.toolCounts).toEqual({ Bash: 20, Read: 7 })
  })
})

describe('summarizeApiCostByDay residue', () => {
  test('a float-rounding residue is exactly zero, so no "no daily record" note shows', () => {
    // 0.1 + 0.2 !== 0.3 in floating point: the days add up to the total, the residue must be 0.
    const d = summarizeApiCostByDay({ claude: { '2026-09-03': { costUSD: 0.1, tokens: 1, sessions: 1 }, '2026-09-04': { costUSD: 0.2, tokens: 1, sessions: 0 } } }, 0.3, 2)
    expect(d.undatedCostUSD).toBe(0)
  })
  test('a real undated remainder is kept', () => {
    const d = summarizeApiCostByDay({ claude: { '2026-09-03': { costUSD: 0.1, tokens: 1, sessions: 1 } } }, 0.15, 1)
    expect(d.undatedCostUSD).toBeCloseTo(0.05, 10)
  })
})
