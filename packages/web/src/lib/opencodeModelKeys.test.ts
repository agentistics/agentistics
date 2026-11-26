import { describe, expect, test } from 'bun:test'
import { calcCost, emptyStatsCache, isUnpricedModel, type AppData, type Filters, type ModelUsage, type SessionMeta } from '@agentistics/core'
import { computeDerivedStats } from '../hooks/useData'
import { overlayProjected, projectedDerived } from './projectedDerived'
import { modelCostByHarness } from './costBasis'
import { matchModelKey } from './modelKeyMatch'

// CUSTO.MODELO-OPENCODE (owner print 2521fdb5, 2.229.3): with the OpenCode filter the headline cost was
// right and every "Usage by model" row read R$0,00. Two facts collided:
//  - the replay keys a model by OpenCode's RAW modelID (`fable-5.1`) and records OpenCode's `cost: 0`
//    (a gateway/subscription route that bills nothing per call) as a DECLARED zero, so the projection
//    prices every row at 0;
//  - the legacy adapter keys the same model by its ROUTE (`upx/fable-5.1`, `opencodeModel`) and prices
//    it from the tokens.
// `overlayProjected` gave the legacy cost back to the TOTAL but only to rows under the SAME key — none
// matched, so the top and the table disagreed.

const base: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
const day = '2026-11-20'
const usage = (i: number, o: number, r: number, w: number, extra: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: i, outputTokens: o, cacheReadInputTokens: r, cacheCreationInputTokens: w, webSearchRequests: 0, costUSD: 0, ...extra,
})
const oc = (id: string, rows: Record<string, ModelUsage>): SessionMeta => {
  const all = Object.values(rows)
  const sum = (k: keyof ModelUsage) => all.reduce((a, u) => a + (u[k] as number), 0)
  return {
    session_id: id, harness: 'opencode', project_path: '/repo', model: Object.keys(rows)[0],
    start_time: `${day}T10:00:00Z`, end_time: `${day}T11:00:00Z`, duration_minutes: 60, user_message_count: 2,
    assistant_message_count: 4, tool_counts: {}, input_tokens: sum('inputTokens'), output_tokens: sum('outputTokens'),
    cache_read_input_tokens: sum('cacheReadInputTokens'), cache_creation_input_tokens: sum('cacheCreationInputTokens'),
    model_usage: rows, user_message_timestamps: [`${day}T10:00:00Z`], message_hours: [10],
  } as unknown as SessionMeta
}

// Legacy keys (route) as the adapter writes them; no declared cost (OpenCode wrote 0, the adapter keeps 0 undeclared).
const fable = usage(3_100_000, 973_600, 92_200_000, 4_200_000)
const opus = usage(14_900, 2_000_000, 146_700_000, 11_400_000)
const codex = usage(1_200_000, 28_700, 12_200_000, 0) // a model no source can price
const sessions = [
  oc('s1', { 'upx/fable-5.1': fable, 'upx/codex-61': codex }),
  oc('s2', { 'upx/opus-5-5': opus }),
]
const data: AppData = { statsCache: emptyStatsCache(), sessions, allSessions: [], projects: [], harnesses: ['claude', 'opencode'] }
const filters: Filters = { ...base, harnesses: ['opencode'] }
const coverage = {
  candidates: ['opencode'],
  blendedOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as never,
  legacyFor: (h: string) => computeDerivedStats(data, { ...filters, harnesses: [h] as Filters['harnesses'] }),
}

type Row = [model: string, u: ModelUsage, usd: number]
/** The metrics API as the replay feeds it: RAW model ids, the declared 0 as the price. */
function query(rows: Row[], harnessCost: number) {
  return async (p: string) => {
    const groupBy = new URLSearchParams(p).get('groupBy')
    const groups = groupBy === 'model'
      ? rows.map(([model, u, usd]) => ({ key: { model }, metrics: { tokens: { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens }, cost: { usd } } }))
      : groupBy === 'harness'
        ? [{ key: { harness: 'opencode' }, metrics: { sessions: { count: 2 }, cost: { usd: harnessCost } } }]
        : [{ key: {}, metrics: { sessions: { count: 2 } } }]
    return { ok: true as const, body: { groups, page: { nextCursor: null } } }
  }
}
const overlayOf = (rows: Row[], harnessCost: number) =>
  projectedDerived(query(rows, harnessCost) as never, {}, () => ({ input: 0, cacheRead: 0, cacheWrite: 0 }) as never)

const rowsSum = (rows: Record<string, ModelUsage>) => Object.entries(rows).reduce((s, [m, u]) => s + calcCost(u, m), 0)

describe('matchModelKey — a route id finds the raw id the projection keys on', () => {
  const keys = ['fable-5.1', 'opus-5-5', 'anthropic/claude-x']
  test('exact wins', () => expect(matchModelKey('opus-5-5', keys)).toBe('opus-5-5'))
  test('provider prefix', () => expect(matchModelKey('upx/fable-5.1', keys)).toBe('fable-5.1'))
  test('a raw id that itself has a slash', () => expect(matchModelKey('openrouter/anthropic/claude-x', keys)).toBe('anthropic/claude-x'))
  test('no partial segment match', () => expect(matchModelKey('upx/fable-5.10', keys)).toBeNull())
  test('nothing', () => expect(matchModelKey('upx/unknown', keys)).toBeNull())
})

describe('OpenCode filter: the by-model rows add up to the headline (owner print 2521fdb5)', () => {
  test('every row priced at a declared 0: rows take the legacy price, sum == top, unknown stays unknown', async () => {
    const overlay = await overlayOf([['fable-5.1', fable, 0], ['opus-5-5', opus, 0], ['codex-61', codex, 0]], 0)
    const legacy = computeDerivedStats(data, filters)!
    const out = overlayProjected(legacy, overlay, coverage)!
    const expected = calcCost(fable, 'upx/fable-5.1') + calcCost(opus, 'upx/opus-5-5')
    expect(expected).toBeGreaterThan(0)
    expect(legacy.totalCostUSD).toBeCloseTo(expected, 6)
    expect(out.totalCostUSD).toBeCloseTo(expected, 6)
    expect(rowsSum(out.modelUsage)).toBeCloseTo(out.totalCostUSD, 6)
    expect(calcCost(out.modelUsage['fable-5.1']!, 'fable-5.1')).toBeCloseTo(calcCost(fable, 'upx/fable-5.1'), 6)
    expect(calcCost(out.modelUsage['opus-5-5']!, 'opus-5-5')).toBeCloseTo(calcCost(opus, 'upx/opus-5-5'), 6)
    // A model nobody can price is still "unknown" and its tokens still flagged unpriced — never a R$0,00 price.
    expect(isUnpricedModel('codex-61')).toBe(true)
    expect(out.modelUsage['codex-61']!.unpricedTokens).toBeGreaterThan(0)
    // Tokens are not counted twice.
    expect(out.modelUsage['fable-5.1']!.inputTokens).toBe(fable.inputTokens)
  })

  test('one model declared, the others at a declared 0: the 0 rows are priced, the declared one is kept', async () => {
    const overlay = await overlayOf([['fable-5.1', fable, 1.5], ['opus-5-5', opus, 0], ['codex-61', codex, 0]], 1.5)
    const declared = { 'upx/fable-5.1': { ...fable, costUSD: 1.5, costSource: 'harness' as const }, 'upx/codex-61': codex }
    const d2: AppData = { ...data, sessions: [oc('s1', declared), oc('s2', { 'upx/opus-5-5': opus })] }
    const legacy = computeDerivedStats(d2, filters)!
    const out = overlayProjected(legacy, overlay, { ...coverage, legacyFor: h => computeDerivedStats(d2, { ...filters, harnesses: [h] as Filters['harnesses'] }) })!
    const expected = 1.5 + calcCost(opus, 'upx/opus-5-5')
    expect(legacy.totalCostUSD).toBeCloseTo(expected, 6)
    expect(out.totalCostUSD).toBeCloseTo(expected, 6)
    expect(rowsSum(out.modelUsage)).toBeCloseTo(out.totalCostUSD, 6)
    expect(calcCost(out.modelUsage['fable-5.1']!, 'fable-5.1')).toBeCloseTo(1.5, 9)
  })

  test('the plan-basis split files a raw-keyed row under OpenCode, not Claude', async () => {
    const overlay = await overlayOf([['fable-5.1', fable, 0], ['opus-5-5', opus, 0], ['codex-61', codex, 0]], 0)
    const legacy = computeDerivedStats(data, filters)!
    const out = overlayProjected(legacy, overlay, coverage)!
    const split = modelCostByHarness(out.modelUsage, legacy.filteredSessions)
    expect(split['fable-5.1']?.claude).toBeUndefined()
    expect(split['fable-5.1']?.opencode).toBeCloseTo(calcCost(fable, 'upx/fable-5.1'), 6)
  })
})
