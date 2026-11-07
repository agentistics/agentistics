import { describe, expect, test } from 'bun:test'
import { GO_MONTHLY_LIMITS, goMonthlyLimit, goPlanLimits, goTrainsOnData, goUsage, opencodePlan } from './opencodeGo'

const H = 3_600_000
const NOW = Date.UTC(2026, 10, 7, 12)

describe('Go limits (docs table, 2026-11-06)', () => {
  test('per plan, per model, in dollars', () => {
    expect(goMonthlyLimit('glm-5.3-flash', 'go')).toBe(60)
    expect(goMonthlyLimit('glm-5.3-flash', 'go-plus')).toBe(180)
    expect(goMonthlyLimit('glm-5.3-flash', 'go-teams')).toBe(65)
    expect(goMonthlyLimit('kimi-k2.7-code', 'go')).toBe(60)
    expect(goMonthlyLimit('glm-5.3', 'go')).toBe(15)
  })
  test('Teams is $5 above Go on every model; Plus is at least Go', () => {
    for (const [id, [go, plus, teams]] of Object.entries(GO_MONTHLY_LIMITS)) {
      expect(teams - go).toBe(5)
      expect(plus).toBeGreaterThanOrEqual(go)
      expect(id).not.toMatch(/\s/)
    }
  })
  test('an unlisted model or a plan without Go limits has none', () => {
    expect(goMonthlyLimit('big-pickle', 'go')).toBeNull()
    expect(goMonthlyLimit('glm-5.3', 'zen')).toBeNull()
  })
  test('plans: Go is US$10/month; Teams is per member', () => {
    expect(opencodePlan('go').priceUsd).toBe(10)
    expect(opencodePlan('go-teams').perMember).toBe(true)
  })
  test('Muse Spark trains on data', () => {
    expect(goTrainsOnData('muse-spark-1.3-contributor')).toBe(true)
    expect(goTrainsOnData('glm-5.3')).toBe(false)
  })
})

describe('goUsage', () => {
  test('5h is 20% of the monthly limit, week 50%, month 100%, over rolling windows', () => {
    const u = goUsage([
      { model: 'glm-5.3', costUsd: 1.5, at: NOW - 1 * H },     // in all three
      { model: 'glm-5.3', costUsd: 3, at: NOW - 24 * H },      // week + month
      { model: 'glm-5.3', costUsd: 6, at: NOW - 10 * 24 * H }, // month
      { model: 'glm-5.3', costUsd: 99, at: NOW - 40 * 24 * H }, // out of every window
    ], 'go', NOW)
    const m = u.models[0]!
    const by = Object.fromEntries(m.windows.map(w => [w.kind, w]))
    expect(by['5h']).toMatchObject({ usedUsd: 1.5, limitUsd: 3, fraction: 0.5 })
    expect(by.week).toMatchObject({ usedUsd: 4.5, limitUsd: 7.5, fraction: 0.6 })
    expect(by.month).toMatchObject({ usedUsd: 10.5, limitUsd: 15, fraction: 0.7 })
    expect(m.binding.kind).toBe('month')
    expect(m.binding.fraction).toBeCloseTo(0.7)
  })

  test('models are ranked by the window nearest its limit; tightest names one per window', () => {
    const u = goUsage([
      { model: 'glm-5.3-flash', costUsd: 6, at: NOW - H },  // 6/12 of 5h = 0.5
      { model: 'glm-5.3', costUsd: 1.5, at: NOW - H },      // 1.5/3 of 5h = 0.5, 1.5/15 month
      { model: 'kimi-k3', costUsd: 3, at: NOW - H },        // 3/3 = 1.0
    ], 'go', NOW)
    expect(u.models[0]!.model).toBe('kimi-k3')
    expect(u.tightest['5h']!.model).toBe('kimi-k3')
    expect(u.tightest.month!.model).toBe('kimi-k3')
  })

  test('a model with no listed limit is reported, not counted as unused', () => {
    const u = goUsage([{ model: 'big-pickle', costUsd: 1, at: NOW - H }], 'go', NOW)
    expect(u.models).toEqual([])
    expect(u.unlisted).toEqual(['big-pickle'])
    expect(u.tightest['5h']).toBeNull()
  })

  test('future-dated and negative rows are ignored', () => {
    const u = goUsage([{ model: 'glm-5.3', costUsd: -1, at: NOW - H }, { model: 'glm-5.3', costUsd: 5, at: NOW + H }], 'go', NOW)
    expect(u.models).toEqual([])
  })
})

describe('goPlanLimits', () => {
  test('one 5 h and one week window from the tightest model, with the rolling reset', () => {
    const at = NOW - 2 * H
    const l = goPlanLimits(goUsage([{ model: 'glm-5.3', costUsd: 1.5, at }, { model: 'glm-5.3-flash', costUsd: 1, at }], 'go', NOW), NOW)!
    expect(l).toMatchObject({ harness: 'opencode', source: 'opencode-cost-estimate', sourcePlan: 'OpenCode Go', updatedAt: NOW })
    expect(l.windows).toEqual([
      { kind: '5h', usedPct: 50, resetsAt: at + 5 * H },
      { kind: 'week', usedPct: 20, resetsAt: at + 7 * 24 * H },
    ])
  })
  test('nothing used on a listed model is no reading', () => {
    expect(goPlanLimits(goUsage([], 'go', NOW), NOW)).toBeNull()
    expect(goPlanLimits(goUsage([{ model: 'big-pickle', costUsd: 1, at: NOW - H }], 'go', NOW), NOW)).toBeNull()
  })
})
