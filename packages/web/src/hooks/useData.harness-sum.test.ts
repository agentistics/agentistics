import { describe, expect, test } from 'bun:test'
import { emptyStatsCache, type AppData, type Filters, type SessionMeta, type SurfaceHarnessId } from '@agentistics/core'
import { computeDerivedStats } from './useData'

const base: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }

function s(id: string, harness: SurfaceHarnessId, day: string, user: number, asst: number, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: id, harness, project_path: '/repo', model: 'm', start_time: `${day}T10:00:00Z`, end_time: `${day}T11:00:00Z`,
    duration_minutes: 60, user_message_count: user, assistant_message_count: asst, tool_counts: { Bash: 2 },
    input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    user_message_timestamps: [`${day}T10:00:00Z`], message_hours: [],
    ...extra,
  } as unknown as SessionMeta
}

const sessions: SessionMeta[] = [
  s('a', 'codex', '2026-11-01', 5, 20), s('b', 'codex', '2026-11-02', 3, 10),
  s('c', 'opencode', '2026-11-02', 7, 30), s('d', 'opencode', '2026-11-04', 2, 8, { duration_minutes: 2400 }),
  s('e', 'claude', '2026-11-03', 4, 4),
]
const data: AppData = { statsCache: emptyStatsCache(), sessions, allSessions: [], projects: [], harnesses: ['claude', 'codex', 'opencode'] }
const run = (h: SurfaceHarnessId[]) => computeDerivedStats(data, { ...base, harnesses: h })!

describe('harness filter: additive figures (union = sum of parts)', () => {
  test('messages, sessions, tool calls and tokens add up across harness filters', () => {
    const codex = run(['codex']), open = run(['opencode']), both = run(['codex', 'opencode'])
    for (const k of ['totalMessages', 'totalSessions', 'totalToolCalls'] as const) {
      expect(both[k]).toBe(codex[k] + open[k])
    }
    expect(both.tokenTotals.input).toBe(codex.tokenTotals.input + open.tokenTotals.input)
    expect(both.totalCostUSD).toBeCloseTo(codex.totalCostUSD + open.totalCostUSD, 9)
  })
  test('sessions >= 1 whenever there are messages, for every selection', () => {
    for (const h of [['codex'], ['opencode'], ['claude'], ['codex', 'opencode'], []] as SurfaceHarnessId[][]) {
      const d = run(h)
      if (d.totalMessages > 0) expect(d.totalSessions).toBeGreaterThanOrEqual(1)
    }
  })
  test('unfiltered equals the sum of every single harness', () => {
    const all = run([])
    const parts = (['claude', 'codex', 'opencode'] as SurfaceHarnessId[]).map(h => run([h]))
    expect(all.totalMessages).toBe(parts.reduce((a, d) => a + d.totalMessages, 0))
    expect(all.totalSessions).toBe(parts.reduce((a, d) => a + d.totalSessions, 0))
  })
  test('streak days of the union are the union of the days', () => {
    expect(run(['codex']).streak + 0).toBeGreaterThanOrEqual(0)
    expect(run(['codex', 'opencode']).longestStreak).toBeGreaterThanOrEqual(Math.max(run(['codex']).longestStreak, run(['opencode']).longestStreak))
  })
})

import { overlayProjected, type ProjectedDerived } from '../lib/projectedDerived'
describe('projection overlay never mixes an empty projection into a populated scope', () => {
  const empty = { totalSessions: 0, totalCostUSD: 0, figuresSource: 'projections' } as unknown as ProjectedDerived
  test('empty projection keeps the legacy figures whole (messages>0 => sessions>=1)', () => {
    const legacy = run(['opencode'])
    const out = overlayProjected(legacy, empty)!
    expect(out.totalSessions).toBe(legacy.totalSessions)
    expect(out.totalSessions).toBeGreaterThanOrEqual(1)
  })
  test('a populated projection still overlays; null stays null', () => {
    const legacy = run(['codex'])
    expect(overlayProjected(legacy, { ...empty, totalSessions: 9 })!.totalSessions).toBe(9)
    expect(overlayProjected(null, empty)).toBeNull()
  })
})

describe('union = sum with per-harness projection coverage (A1 guard)', () => {
  const blendedOf = () => ({ input: 3, cacheRead: 0.3, cacheWrite: 3.75 })
  /** A projection that covers Codex alone: it reports exactly what the legacy figures say for Codex. */
  const projectionOf = (d: ReturnType<typeof run>, covered: string[]): ProjectedDerived => ({
    totalSessions: d.totalSessions, totalCostUSD: d.totalCostUSD, modelUsage: d.modelUsage, tokenTotals: d.tokenTotals,
    inputTokens: d.tokenTotals.input, outputTokens: d.tokenTotals.output, toolCounts: d.toolCounts, totalToolCalls: d.totalToolCalls,
    projectStats: d.projectStats, cacheTotals: d.cacheTotals, cacheHitRate: d.cacheHitRate, cacheGrossSavedUSD: 0,
    cacheWriteOverheadUSD: 0, cacheNetSavedUSD: 0, cachePerModel: d.cachePerModel, coveredHarnesses: covered, figuresSource: 'projections',
  }) as unknown as ProjectedDerived
  const view = (h: SurfaceHarnessId[], projected: ProjectedDerived | null) => {
    const legacy = run(h)
    const candidates = h.length ? h : ['claude', 'codex', 'opencode']
    return overlayProjected(legacy, projected, { candidates, blendedOf, legacyFor: x => computeDerivedStats(data, { ...base, harnesses: [x as SurfaceHarnessId] }) })!
  }
  test('Codex covered, OpenCode has no projection: the union equals the sum, in sessions, messages, tokens and cost', () => {
    const codexProjection = projectionOf(run(['codex']), ['codex'])
    const codex = view(['codex'], codexProjection)
    const zero = { ...run(['opencode']), totalSessions: 0, totalCostUSD: 0, modelUsage: {}, tokenTotals: { ...run(['opencode']).tokenTotals, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCounts: {}, totalToolCalls: 0, projectStats: {} }
    const open = view(['opencode'], projectionOf(zero as never, []))
    const both = view(['codex', 'opencode'], codexProjection)
    expect(open.totalSessions).toBe(run(['opencode']).totalSessions)
    expect(both.totalSessions).toBe(codex.totalSessions + open.totalSessions)
    expect(both.totalSessions).toBe(4)
    expect(both.totalMessages).toBe(codex.totalMessages + open.totalMessages)
    expect(both.tokenTotals.input).toBe(codex.tokenTotals.input + open.tokenTotals.input)
    expect(both.totalCostUSD).toBeCloseTo(codex.totalCostUSD + open.totalCostUSD, 9)
    expect(both.totalToolCalls).toBe(codex.totalToolCalls + open.totalToolCalls)
  })
  test('both covered: the projection is used as is', () => {
    const p = projectionOf(run(['codex', 'opencode']), ['codex', 'opencode'])
    expect(view(['codex', 'opencode'], p).totalSessions).toBe(p.totalSessions)
  })
})
