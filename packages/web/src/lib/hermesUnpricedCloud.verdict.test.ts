// QA-ONLY probe for HERMES.S2.2 (not part of the delivery; deleted after the QA run).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { emptyStatsCache, hasModelCost, MODEL_PRICING, unpricedTokens, type AppData, type Filters, type SessionMeta } from '@agentistics/core'
import { computeDerivedStats } from '../hooks/useData'
import { overlayProjected, projectedDerived } from './projectedDerived'

const COMMUNITY = {
  'gpt-oss-120b': { input: 0.2, output: 0.3, cacheRead: 0.02, cacheWrite: 0.2, cacheWrite1h: 0.4 },
  'llama3.2-3b-instruct': { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0.1, cacheWrite1h: 0.2 },
}
beforeAll(() => { Object.assign(MODEL_PRICING, COMMUNITY) })
afterAll(() => { for (const k of Object.keys(COMMUNITY)) delete MODEL_PRICING[k] })

const tok = (i: number, o: number) => ({ total: i + o, input: i, output: o, cacheRead: 0, cacheWrite: 0 })
const mk = (modelGroups: unknown[], harnessCost: unknown) => projectedDerived((async (p: URLSearchParams) => {
  const gb = p.get('groupBy')
  const groups = gb === 'model' ? modelGroups
    : gb === 'harness' ? [{ key: { harness: 'hermes' }, metrics: { sessions: { count: 2 }, cost: harnessCost } }]
      : [{ key: {}, metrics: { sessions: { count: 2 } } }]
  return { ok: true as const, body: { groups, page: { nextCursor: null } } as never }
}) as never, {}, () => ({ input: 0, cacheRead: 0, cacheWrite: 0 }) as never)

describe('QA S2.2 probe', () => {
  test('old server (no unpricedRows): falls back to the table — unknown id unpriced, known id at usd 0 stays priced', async () => {
    const d = (await mk([
      { key: { model: 'mystery-model-zz9' }, metrics: { tokens: tok(1000, 100), cost: { usd: 0 } } },
      { key: { model: 'claude-sonnet-4-5' }, metrics: { tokens: tok(2000, 200), cost: { usd: 0 } } },
    ], { usd: 0 }))!
    expect(d.modelUsage['mystery-model-zz9']!.unpricedTokens).toBe(1100)
    expect(d.modelUsage['claude-sonnet-4-5']!.unpricedTokens).toBe(0)
  })

  test('new server: usd 0 with unpricedRows > 0 is unpriced even when the browser table would price it', async () => {
    const d = (await mk([
      { key: { model: 'gpt-oss:120b' }, metrics: { tokens: tok(5000, 800), cost: { usd: 0, pricedRows: 0, unpricedRows: 1, partial: false } } },
      { key: { model: 'claude-sonnet-4-5' }, metrics: { tokens: tok(2000, 200), cost: { usd: 0, pricedRows: 1, unpricedRows: 0, partial: false } } },
    ], { usd: 0, pricedRows: 1, unpricedRows: 1, partial: true }))!
    expect(d.modelUsage['gpt-oss:120b']!.unpricedTokens).toBe(5800)
    expect(d.modelUsage['claude-sonnet-4-5']!.unpricedTokens).toBe(0)
  })

  test('hermes with ONLY local + cloud (legacy total 0): local llama becomes a known 0, cloud stays unknown', async () => {
    const h = (id: string, model: string, i: number, o: number): SessionMeta => ({
      session_id: id, harness: 'hermes', project_path: `/w/${id}`, model, start_time: '2026-11-28T03:00:00Z', end_time: '2026-11-28T03:10:00Z',
      user_message_count: 1, assistant_message_count: 1, input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      tool_counts: {}, message_hours: [3], user_message_timestamps: ['2026-11-28T03:00:00Z'],
    } as unknown as SessionMeta)
    const data = { statsCache: emptyStatsCache(), sessions: [h('a', 'ollama/llama3.2', 10_000, 2_000), h('b', 'ollama-cloud/gpt-oss:120b', 50_000, 8_000)], allSessions: [], projects: [], harnesses: ['hermes'] } as unknown as AppData
    const filters: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
    const legacyHermes = computeDerivedStats(data, { ...filters, harnesses: ['hermes'] as Filters['harnesses'] })
    expect(legacyHermes!.totalCostUSD).toBe(0)
    const absent = { reason: 'none of the 1 cost row(s) could be priced' }
    const ov = await mk([
      { key: { model: 'gpt-oss:120b' }, metrics: { tokens: tok(50_000, 8_000) }, absent: { cost: absent } },
      { key: { model: 'llama3.2' }, metrics: { tokens: tok(10_000, 2_000) }, absent: { cost: absent } },
    ], { usd: 0, pricedRows: 0, unpricedRows: 2, partial: true })
    const out = overlayProjected(computeDerivedStats(data, filters), ov, {
      candidates: ['hermes'], blendedOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as never,
      legacyFor: (x: string) => computeDerivedStats(data, { ...filters, harnesses: [x] as Filters['harnesses'] }),
    })!
    expect(hasModelCost(out.modelUsage['llama3.2']!, 'llama3.2')).toBe(true)
    expect(hasModelCost(out.modelUsage['gpt-oss:120b']!, 'gpt-oss:120b')).toBe(false)
    expect(unpricedTokens(Object.entries(out.modelUsage))).toBe(58_000)
    expect(out.totalCostUSD).toBe(0)
  })
})
