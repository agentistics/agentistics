import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { emptyStatsCache, hasModelCost, MODEL_PRICING, unpricedTokens, type AppData, type Filters, type ModelUsage, type SessionMeta } from '@agentistics/core'
import { computeDerivedStats } from '../hooks/useData'
import { overlayProjected, projectedDerived } from './projectedDerived'
import { ModelBreakdown } from '../components/ModelBreakdown'

// HERMES.S2.2 (proof of 2.232.0, leader/qa/prova-22320.md): an Ollama Cloud session
// (`billing_provider: ollama-cloud`, model `gpt-oss:120b`) read USD 0.00 in "Usage by model", and the
// table's TOTAL lost the "+ unpriced usage" marker the header carried.
//
// Reproduced against the published binary: `/api/runtime/metrics?groupBy=model` answers the Hermes
// rows under the replay's RAW model id (`gpt-oss:120b`, `llama3.2`) with NO `cost` metric (it is
// listed in `absent`: nothing could be priced). The web read that as `cost?.usd ?? 0` and then decided
// for ITSELF whether the model had a price — and once `/api/rates` has loaded the community table into
// `MODEL_PRICING`, the prefix match prices `gpt-oss:120b` (via `gpt-oss-120b`) and `llama3.2` (via
// `llama3.2-3b-instruct`), so the row became a priced, settled $0.

/** The community rows `/api/rates` really carried on that machine (the browser writes them into MODEL_PRICING). */
const COMMUNITY = {
  'gpt-oss-120b': { input: 0.2, output: 0.3, cacheRead: 0.02, cacheWrite: 0.2, cacheWrite1h: 0.4 },
  'llama3.2-3b-instruct': { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0.1, cacheWrite1h: 0.2 },
}
// `useIsMobile` reads the viewport on first render — a desktop one, installed for this file only.
const g = globalThis as { window?: unknown }
const hadWindow = 'window' in g
beforeAll(() => {
  Object.assign(MODEL_PRICING, COMMUNITY)
  if (!hadWindow) g.window = { innerWidth: 1280 }
})
afterAll(() => {
  for (const k of Object.keys(COMMUNITY)) delete MODEL_PRICING[k]
  if (!hadWindow) delete g.window
})

/** The model groups exactly as the 2.232.0 server answered them (cost ABSENT on the two Ollama rows). */
const MODEL_GROUPS = [
  { key: { model: 'claude-sonnet-4-5' }, metrics: { tokens: { total: 1_190_000, input: 200_000, output: 40_000, cacheRead: 900_000, cacheWrite: 50_000 }, cost: { usd: 1.6575, pricedRows: 1, unpricedRows: 0, partial: false } } },
  { key: { model: 'gpt-oss:120b' }, metrics: { tokens: { total: 58_000, input: 50_000, output: 8_000, cacheRead: 0, cacheWrite: 0 } }, absent: { cost: { reason: 'none of the 1 cost row(s) could be priced' } } },
  { key: { model: 'llama3.2' }, metrics: { tokens: { total: 12_000, input: 10_000, output: 2_000, cacheRead: 0, cacheWrite: 0 } }, absent: { cost: { reason: 'none of the 1 cost row(s) could be priced' } } },
]
const query = async (p: URLSearchParams) => {
  const groupBy = p.get('groupBy')
  const groups = groupBy === 'model' ? MODEL_GROUPS
    : groupBy === 'harness' ? [{ key: { harness: 'hermes' }, metrics: { sessions: { count: 3 }, cost: { usd: 1.6575, pricedRows: 1, unpricedRows: 2, partial: true } } }]
      : [{ key: {}, metrics: { sessions: { count: 3 } } }]
  return { ok: true as const, body: { groups, page: { nextCursor: null } } as never }
}
const overlay = () => projectedDerived(query as never, {}, () => ({ input: 0, cacheRead: 0, cacheWrite: 0 }) as never)

// The legacy (adapter) side: what `hermes-parse.ts` writes for the same three sessions.
const hermes = (id: string, model: string, i: number, o: number, r = 0, w = 0): SessionMeta => ({
  session_id: id, harness: 'hermes', project_path: `/work/${id}`, model,
  start_time: '2026-11-28T03:00:00Z', end_time: '2026-11-28T03:10:00Z', user_message_count: 1, assistant_message_count: 1,
  input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w,
  tool_counts: {}, message_hours: [3], user_message_timestamps: ['2026-11-28T03:00:00Z'],
} as unknown as SessionMeta)
const sessions = [
  hermes('a', 'ollama/llama3.2', 10_000, 2_000),
  hermes('b', 'ollama-cloud/gpt-oss:120b', 50_000, 8_000),
  hermes('c', 'claude-sonnet-4-5', 200_000, 40_000, 900_000, 50_000),
]
const data: AppData = { statsCache: emptyStatsCache(), sessions, allSessions: [], projects: [], harnesses: ['hermes'] } as unknown as AppData
const filters: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
const coverage = {
  candidates: ['hermes'],
  blendedOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as never,
  legacyFor: (h: string) => computeDerivedStats(data, { ...filters, harnesses: [h] as Filters['harnesses'] }),
}

describe('HERMES.S2.2: a model the server could not price is never a settled $0 on the web', () => {
  test('projection: an ABSENT cost marks the row unpriced, whatever the browser table would guess', async () => {
    const d = await overlay()
    const cloud = d.modelUsage['gpt-oss:120b']!
    expect(cloud.unpricedTokens).toBe(58_000)
    expect(hasModelCost(cloud, 'gpt-oss:120b')).toBe(false)
    expect(unpricedTokens(Object.entries(d.modelUsage))).toBeGreaterThan(0)
  })

  test('overlay: cloud stays unknown, the LOCAL model is a known 0, the total is a floor', async () => {
    const out = overlayProjected(computeDerivedStats(data, filters), await overlay(), coverage)!
    const rows: Record<string, ModelUsage> = out.modelUsage
    expect(hasModelCost(rows['gpt-oss:120b']!, 'gpt-oss:120b')).toBe(false)
    // `ollama/llama3.2` is local (billed by the user's own runtime): free, not unknown.
    expect(hasModelCost(rows['llama3.2']!, 'llama3.2')).toBe(true)
    expect(rows['llama3.2']!.costUSD).toBe(0)
    expect(unpricedTokens(Object.entries(rows))).toBe(58_000)
    expect(out.totalCostUSD).toBeCloseTo(1.6575, 6)
  })

  test('the "Usage by model" table: cloud reads "desconhecido" and the TOTAL carries "+ uso sem preço"', async () => {
    const out = overlayProjected(computeDerivedStats(data, filters), await overlay(), coverage)!
    const html = renderToStaticMarkup(<ModelBreakdown modelUsage={out.modelUsage} lang="pt" />)
    expect(html).toContain('desconhecido')
    expect(html).toContain('+ uso sem preço')
    expect(html).toContain('data-unpriced-marker')
  })
})
