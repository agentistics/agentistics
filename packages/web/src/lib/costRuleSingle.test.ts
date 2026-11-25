import { describe, expect, test } from 'bun:test'
import { calcCost, emptyStatsCache, type AppData, type Filters, type ModelUsage, type SessionMeta } from '@agentistics/core'
import { computeDerivedStats } from '../hooks/useData'
import { overlayProjected, projectedDerived } from './projectedDerived'
import { modelCostByHarness } from './costBasis'

// CUSTO.REGRA-UNICA: the headline cost and the "Usage by model" table must follow ONE rule. A session
// whose harness DECLARES its cost (OpenCode) is billed at that figure in the total, so its share of a
// model row must be the declared figure too — never the same tokens repriced from the table.

const base: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
const model = 'claude-sonnet-5-5'
const day = '2026-11-20'

const usage = (i: number, o: number, r: number, w: number, extra: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: i, outputTokens: o, cacheReadInputTokens: r, cacheCreationInputTokens: w, webSearchRequests: 0, costUSD: 0, ...extra,
})
const session = (id: string, harness: 'claude' | 'opencode', u: ModelUsage): SessionMeta => ({
  session_id: id, harness, project_path: '/repo', model, start_time: `${day}T10:00:00Z`, end_time: `${day}T11:00:00Z`,
  duration_minutes: 60, user_message_count: 2, assistant_message_count: 4, tool_counts: {},
  input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: u.cacheReadInputTokens,
  cache_creation_input_tokens: u.cacheCreationInputTokens, model_usage: { [model]: u },
  user_message_timestamps: [`${day}T10:00:00Z`], message_hours: [10],
}) as unknown as SessionMeta

const claudeA = usage(30, 1200, 80_000, 4000)
const claudeB = usage(12, 900, 50_000, 2500)
// OpenCode declares USD 0.25 for tokens the table prices differently.
const ocTokens = usage(60_000, 4000, 90_000, 3000)
const declared = 0.25
const opencode = usage(ocTokens.inputTokens, ocTokens.outputTokens, ocTokens.cacheReadInputTokens, ocTokens.cacheCreationInputTokens, { costUSD: declared, costSource: 'harness' })

const sessions = [session('c1', 'claude', claudeA), session('c2', 'claude', claudeB), session('o1', 'opencode', opencode)]
const sumTok = (...us: ModelUsage[]) => usage(
  us.reduce((a, u) => a + u.inputTokens, 0), us.reduce((a, u) => a + u.outputTokens, 0),
  us.reduce((a, u) => a + u.cacheReadInputTokens, 0), us.reduce((a, u) => a + u.cacheCreationInputTokens, 0),
)
// Claude's history reaches the unfiltered view through stats-cache.json, as on a real machine.
const statsCache = { ...emptyStatsCache(), modelUsage: { [model]: sumTok(claudeA, claudeB) } }
const data: AppData = { statsCache, sessions, allSessions: [], projects: [], harnesses: ['claude', 'opencode'] }

const claudeTable = calcCost(claudeA, model) + calcCost(claudeB, model)
const expectedTotal = claudeTable + declared

/** What the "Usage by model" table prints: `calcCost` per row (ModelBreakdown), summed. */
const rowsSum = (rows: Record<string, ModelUsage>) => Object.entries(rows).reduce((s, [m, u]) => s + calcCost(u, m), 0)
/** The table under the plan basis splits each row by harness (`modelCostByHarness`); the split must close too. */
const splitSum = (rows: Record<string, ModelUsage>, sess: SessionMeta[]) =>
  Object.values(modelCostByHarness(rows, sess)).reduce((s, byH) => s + Object.values(byH).reduce((a, b) => a + b, 0), 0)

const coverage = {
  candidates: ['claude', 'opencode'],
  blendedOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as never,
  legacyFor: (h: string) => computeDerivedStats(data, { ...base, harnesses: [h] as Filters['harnesses'] }),
}


/** A metrics query answering like the server: one row per model, plus per-harness sessions and cost. */
function query(tokens: ModelUsage, usd: number, harnesses: [string, number, number][]) {
  return async (p: string) => {
    const groupBy = new URLSearchParams(p).get('groupBy')
    const groups = groupBy === 'model'
      ? [{ key: { model }, metrics: { tokens: { input: tokens.inputTokens, output: tokens.outputTokens, cacheRead: tokens.cacheReadInputTokens, cacheWrite: tokens.cacheCreationInputTokens }, cost: { usd } } }]
      : groupBy === 'harness'
        ? harnesses.map(([harness, count, cost]) => ({ key: { harness }, metrics: { sessions: { count }, cost: { usd: cost } } }))
        : [{ key: {}, metrics: { sessions: { count: harnesses.reduce((a, h) => a + h[1], 0) } } }]
    return { ok: true as const, body: { groups, page: { nextCursor: null } } }
  }
}
const overlayOf = (tokens: ModelUsage, usd: number, harnesses: [string, number, number][]) =>
  projectedDerived(query(tokens, usd, harnesses) as never, {}, () => ({ input: 0, cacheRead: 0, cacheWrite: 0 }) as never)

describe('one cost rule: by-model rows add up to the headline', () => {
  test('legacy figures: rows sum == total == Claude table price + declared OpenCode cost', () => {
    const d = computeDerivedStats(data, base)!
    expect(d.totalCostUSD).toBeCloseTo(expectedTotal, 9)
    expect(rowsSum(d.modelUsage)).toBeCloseTo(d.totalCostUSD, 9)
    expect(splitSum(d.modelUsage, d.filteredSessions)).toBeCloseTo(d.totalCostUSD, 9)
  })

  test('projection covering both harnesses: rows use the cost the projection priced, never the table again', async () => {
    const overlay = await overlayOf(sumTok(claudeA, claudeB, ocTokens), expectedTotal, [['claude', 2, claudeTable], ['opencode', 1, declared]])
    const legacy = computeDerivedStats(data, base)!
    const out = overlayProjected(legacy, overlay, coverage)!
    expect(out.totalCostUSD).toBeCloseTo(expectedTotal, 9)
    expect(rowsSum(out.modelUsage)).toBeCloseTo(out.totalCostUSD, 9)
    expect(splitSum(out.modelUsage, legacy.filteredSessions)).toBeCloseTo(out.totalCostUSD, 9)
  })

  test('projection covering Claude only: the OpenCode legacy part merges in at its declared cost', async () => {
    const overlay = await overlayOf(sumTok(claudeA, claudeB), claudeTable, [['claude', 2, claudeTable]])
    const legacy = computeDerivedStats(data, base)!
    const out = overlayProjected(legacy, overlay, coverage)!
    expect(out.totalCostUSD).toBeCloseTo(expectedTotal, 9)
    expect(rowsSum(out.modelUsage)).toBeCloseTo(out.totalCostUSD, 9)
    expect(splitSum(out.modelUsage, legacy.filteredSessions)).toBeCloseTo(out.totalCostUSD, 9)
  })

  test('projection covering OpenCode only: the Claude legacy part merges in at the table price', async () => {
    const overlay = await overlayOf(ocTokens, declared, [['opencode', 1, declared]])
    const legacy = computeDerivedStats(data, base)!
    const out = overlayProjected(legacy, overlay, coverage)!
    expect(out.totalCostUSD).toBeCloseTo(expectedTotal, 9)
    expect(rowsSum(out.modelUsage)).toBeCloseTo(out.totalCostUSD, 9)
    expect(splitSum(out.modelUsage, legacy.filteredSessions)).toBeCloseTo(out.totalCostUSD, 9)
  })
})
