import { describe, expect, test } from 'bun:test'
import { limitsStale, planBudget, planPace, routeRecommendation, PLAN_LIMITS_STALE_MS, type AccountBudget, type PlanLimits } from './planLimits'

// FLUXO.AVISOS 6 — the router never recommends a harness it has not read recently.
const H = 3_600_000
const NOW = Date.parse('2026-11-08T12:00:00Z')
function row(harness: 'claude' | 'codex' | 'gemini', readAgoMs: number, pct = 30): AccountBudget {
  const l: PlanLimits = {
    harness, account: `${harness}-acc`, source: 'codex-rollout', updatedAt: NOW - readAgoMs, plan: 'Registered plan',
    windows: [{ kind: 'week', usedPct: pct, resetsAt: NOW + 60 * H }, { kind: '5h', usedPct: pct, resetsAt: NOW + 2 * H }],
  }
  return { ...planBudget(l, NOW), ...planPace(l, NOW, []), account: l.account, spawnable: true }
}

describe('routeRecommendation with stale readings', () => {
  test('the fixture rows really are stale / fresh', () => {
    expect(row('claude', 0).stale).toBe(false)
    expect(row('claude', PLAN_LIMITS_STALE_MS + 1).stale).toBe(true)
    expect(limitsStale({ updatedAt: NOW - 1 } as PlanLimits, NOW)).toBe(false)
  })

  test('a stale preferred harness is not recommended; the fresh one is, and the stale one is named unknown', () => {
    const r = routeRecommendation([row('claude', 3 * H), row('codex', 0)], 'spec-impl')
    expect(r.harness).toBe('codex')
    expect(r.confidence).toBe('fresh')
    expect(r.unknown).toContainEqual({ harness: 'claude', why: 'stale' })
    expect(r.alternatives).not.toContain('claude')
    expect(r.accountAlternatives.map(a => a.harness)).not.toContain('claude')
  })

  test('only stale readings: no harness, said in words, with confidence none — never a recommendation off a dead meter', () => {
    const r = routeRecommendation([row('claude', 3 * H), row('codex', 5 * H)], 'spec-impl')
    expect(r.harness).toBeNull()
    expect(r.confidence).toBe('none')
    expect(r.reason).toContain('No fresh plan_limits reading')
    expect(r.cadence.parallel).toBe(0)
    expect(r.unknown?.filter(u => u.why === 'stale').map(u => u.harness).sort()).toEqual(['claude', 'codex'])
  })

  test('a provider the router prefers but has no row for is listed as no-reading, never offered', () => {
    const r = routeRecommendation([row('codex', 0)], 'spec-impl', undefined, { visibleHarnesses: ['codex', 'claude'] })
    expect(r.harness).toBe('codex')
    expect(r.unknown).toEqual([{ harness: 'claude', why: 'no-reading' }])
    // a caller that does not say which harnesses the reader may see is told about none it cannot prove it has (no leak of hidden ones)
    expect(routeRecommendation([row('codex', 0)], 'spec-impl').unknown).toBeUndefined()
  })

  test('with every preferred harness fresh nothing is unknown', () => {
    const r = routeRecommendation([row('claude', 0), row('codex', 0), row('gemini', 0)], 'spec-impl')
    expect(r.harness).not.toBeNull()
    expect(r.unknown?.filter(u => u.why === 'stale') ?? []).toEqual([])
  })

  test('a stale account of a harness does not take the work from a fresh one of the same harness', () => {
    const fresh = { ...row('claude', 0, 60), account: 'fresh' }
    const stale = { ...row('claude', 3 * H, 5), account: 'stale' }
    const r = routeRecommendation([stale, fresh], 'spec-impl')
    expect(r.harness).toBe('claude')
    expect(r.account).toBe('fresh')
  })
})
