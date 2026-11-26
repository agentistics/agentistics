/**
 * CUSTO.DECLARADO-TOPO — a cost the HARNESS declared survives the consolidate-store import, all the way
 * to the projected headline. No mock between the store record and the number on the Costs page:
 * `storeSessionEvents` (the import's store half) → `costByDimensionProjection` (the real fold) →
 * `runMetricsQuery` (the real `/api/runtime/metrics` aggregation) → `projectedDerived` (the web's
 * overlay, whose `totalCostUSD` IS the Costs headline once the projection takes over).
 *
 * The seed is the 2.229.2 proof's: two Claude sessions on `claude-sonnet-5-5` (1.0M in / 0.2M out /
 * 5.0M cache read in all → 4.50 at the table) and one OpenCode session on the same model that DECLARES
 * US$ 0.25 (`costSource: 'harness'`) for 60k in / 4k out / 90k cache read / 3k cache write (0.1765 at
 * the table). Expected headline: 4.75. 2.229.2 answered 4.68 — the OpenCode tokens repriced.
 */
import { describe, expect, test } from 'bun:test'
import { calcCost, CAPABILITY_STATES, type AgentisticsEvent, type AnyAgentisticsEvent, type HarnessId, type ModelUsage, type SessionMeta } from '@agentistics/core'
import type { HarnessEntityIds } from '@agentistics/engine-api'
import { costByDimensionProjection } from '../projections/cost-by-dimension'
import { runMetricsQuery, parseMetricsQuery } from '../runtime-metrics-query'
import { fakeReader } from '../runtime-metrics-fixtures'
import { projectedDerived } from '../../../web/src/lib/projectedDerived'
import { storeSessionEvents } from './import-store'

const MODEL = 'claude-sonnet-5-5'
const ids = (h: string): HarnessEntityIds => ({
  sessionIdOf: c => `ses_${h}_${c}`,
  runIdOf: c => `run_${h}_${c}`,
  mainAgentIdOf: c => `agt_${h}_${c}`,
})

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, extra: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite,
  webSearchRequests: 0, costUSD: 0, ...extra,
})

function meta(harness: HarnessId, id: string, u: ModelUsage): SessionMeta {
  return {
    session_id: id, harness, project_path: '/work/app', start_time: '2026-11-20T10:00:00Z', end_time: '2026-11-20T11:00:00Z',
    model: MODEL, input_tokens: u.inputTokens, output_tokens: u.outputTokens,
    cache_read_input_tokens: u.cacheReadInputTokens, cache_creation_input_tokens: u.cacheCreationInputTokens,
    model_usage: { [MODEL]: u },
  } as unknown as SessionMeta
}

const claudeA = usage(600_000, 120_000, 3_000_000, 0)
const claudeB = usage(400_000, 80_000, 2_000_000, 0)
const opencode = usage(60_000, 4_000, 90_000, 3_000, { costUSD: 0.25, costSource: 'harness' })
const SEED: [HarnessId, string, ModelUsage][] = [['claude', 'c-a', claudeA], ['claude', 'c-b', claudeB], ['opencode', 'oc-1', opencode]]

function importedEvents(h: HarnessId, id: string, u: ModelUsage): AgentisticsEvent[] {
  const r = storeSessionEvents(meta(h, id, u), {
    harness: h, ids: ids(h), tokens: CAPABILITY_STATES[h].tokens, sourceRef: `consolidate:${h}/${id}.json`, recordedAt: '2026-11-25T00:00:00.000Z',
  })
  if (!r.ok) throw new Error(r.reason)
  return r.events
}

function factsOf(events: AgentisticsEvent[]) {
  const s = costByDimensionProjection.empty()
  costByDimensionProjection.fold(s, events as AnyAgentisticsEvent[])
  return costByDimensionProjection.finish(s).facts
}

const reader = fakeReader(SEED.flatMap(([h, id, u]) => factsOf(importedEvents(h, id, u))), [])
const query = async (p: URLSearchParams) => {
  const parsed = parseMetricsQuery(p)
  if (!parsed.ok) return { ok: false as const, status: 400, error: parsed.error.code }
  return { ok: true as const, body: await runMetricsQuery(reader, parsed.query) as never }
}

describe('a declared cost survives the store import (CUSTO.DECLARADO-TOPO)', () => {
  test('the coarse model.completed carries the declared figure as the harness stated it', () => {
    const mc = importedEvents('opencode', 'oc-1', opencode).find(e => e.type === 'model.completed')!
    expect(mc.data).toMatchObject({ model: MODEL, costUSD: 0.25, costSource: 'harness' })
  })

  test('a table-priced record still carries no cost field (the projection prices it)', () => {
    const mc = importedEvents('claude', 'c-a', claudeA).find(e => e.type === 'model.completed')!
    expect('costUSD' in mc.data).toBe(false)
    expect('costSource' in mc.data).toBe(false)
  })

  test('/api/runtime/metrics groupBy=harness prices the OpenCode session at its declared 0.25, not the table', async () => {
    const a = await query(new URLSearchParams('groupBy=harness&metrics=cost&limit=1000'))
    if (!a.ok) throw new Error(a.error)
    const body = a.body as { groups: { key: { harness: string }; metrics: { cost: { usd: number } } }[] }
    const byHarness = Object.fromEntries(body.groups.map(g => [g.key.harness, g.metrics.cost.usd]))
    expect(byHarness.opencode).toBeCloseTo(0.25, 10)
    const tablePrice = calcCost({ ...opencode, costUSD: 0, costSource: undefined }, MODEL)
    expect(tablePrice).toBeCloseTo(0.1765, 10)
    expect(byHarness.opencode).not.toBeCloseTo(tablePrice, 4)
  })

  test('the projected headline and the by-model row are 4.75 for the proof seed', async () => {
    const d = await projectedDerived(query, {}, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as never)
    const claudeTable = calcCost(claudeA, MODEL) + calcCost(claudeB, MODEL)
    expect(claudeTable).toBeCloseTo(4.5, 10)
    expect(d.totalCostUSD).toBeCloseTo(claudeTable + 0.25, 10)
    expect(d.totalCostUSD).toBeCloseTo(4.75, 10)
    expect(calcCost(d.modelUsage[MODEL]!, MODEL)).toBeCloseTo(4.75, 10)
  })
})
