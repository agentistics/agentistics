import { describe, expect, it } from 'bun:test'
import { computeHandoffPanel, quotaRate, type QuotaObservation } from './handoff-panel'
import { computeHandoffWhy, planHandoffHints } from './handoff-hint'

const leader = { id: 'leader', title: '[ LEADER ] - test', contextTokens: 256_000, contextWindow: 1_000_000, model: 'claude-opus-4-6', turns: 84, costUSD: 18.4, calls: 150 }

describe('handoff panel v1 adapter', () => {
  it('shares the owner cut with the existing model hint and preserves worker behavior', () => {
    expect(planHandoffHints([{ ...leader, cutTokens: 400_000 }])).toHaveLength(0)
    expect(planHandoffHints([{ ...leader, cutTokens: 150_000 }])).toHaveLength(1)
    expect(planHandoffHints([{ ...leader, title: 'Worker', cutTokens: 150_000 }])).toHaveLength(0)
    expect(computeHandoffWhy({ ...leader, cutTokens: 312_000 }).thresholdTokens).toBe(312_000)
    expect(computeHandoffPanel(leader, { profile: 'custom', customTokens: 312_000 }).cutTokens).toBe(312_000)
  })
  it('projects twenty replies and +X% of the real context window, including successor overhead', () => {
    const p = computeHandoffPanel(leader, { extraPercent: 10 }, { fiveHourPctPerUSD: 2, weekPctPerUSD: .3 }, 123)
    const why = computeHandoffWhy(leader)
    expect(p).toMatchObject({ version: 1, sessionId: 'leader', updatedAt: 123, cutTokens: 250_000, level: 'due', replies: 150, spentUSD: 18.4, projectionReplies: 20 })
    expect(p.nextReplyUSD).not.toBeNull()
    expect(p.projections[0]!.costUSD).toBeCloseTo(p.nextReplyUSD! * 20)
    expect(p.projections[1]!.contextTokens).toBe(356_000)
    expect(p.projections[1]!.costUSD! / p.projections[0]!.costUSD!).toBeCloseTo(356 / 256)
    expect(p.projections[2]!.costUSD).toBeCloseTo(p.handoffOverheadUSD! + 20 * p.successorReplyUSD!)
    expect(p.breakEvenReplies).toBe(why.breakEvenTurns!)
    for (const r of p.projections) {
      expect(r.fiveHourPct).toBeCloseTo(r.costUSD! * 2)
      expect(r.weekPct).toBeCloseTo(r.costUSD! * .3)
    }
  })
  it('keeps absent prices, context and quota unknown', () => {
    const p = computeHandoffPanel({ id: 'x', title: 'x', model: 'unpriced-model' }, null)
    expect(p.nextReplyUSD).toBeNull()
    expect(p.spentUSD).toBeNull()
    expect(p.replies).toBeNull()
    expect(computeHandoffPanel({ id: 'x', title: 'x', turns: 100 }, null).replies).toBeNull()
    expect(p.contextTokens).toBeNull()
    expect(p.projections.every(r => r.costUSD === null && r.fiveHourPct === null && r.weekPct === null)).toBe(true)
    const missingWindow = computeHandoffPanel({ ...leader, contextWindow: undefined }, null)
    expect(missingWindow.projections[1]!.costUSD).toBeNull()
    expect(missingWindow.projections[0]!.costUSD).not.toBeNull()
  })
  it('keeps warning preferences without changing the physical level', () => {
    const p = computeHandoffPanel(leader, { warnings: { due: false } })
    expect(p.level).toBe('due')
    expect(p.config.warnings.due).toBe(false)
    expect(p.projections[0]!.fiveHourPct).toBeNull()
  })
})

describe('measured plan quota estimates', () => {
  const previous: QuotaObservation = { at: 1_000, totalUSD: 10, population: 'a,b', fiveHour: { usedPct: 20, resetsAt: 999_999 }, week: { usedPct: 30, resetsAt: 9_999_999 } }
  const current: QuotaObservation = { ...previous, at: 61_000, totalUSD: 12, fiveHour: { usedPct: 24, resetsAt: 999_999 }, week: { usedPct: 31, resetsAt: 9_999_999 } }
  it('uses separate window and week measured consumption', () => {
    expect(quotaRate(previous, current)).toEqual({ fiveHourPctPerUSD: 2, weekPctPerUSD: .5 })
  })
  it('does not invent burn at birth, renewal, stale samples or population changes', () => {
    for (const before of [undefined, { ...previous, population: 'a' }, { ...previous, totalUSD: 12 }, { ...previous, at: -1_800_000 }]) {
      expect(quotaRate(before, current)).toEqual({ fiveHourPctPerUSD: null, weekPctPerUSD: null })
    }
    expect(quotaRate(previous, { ...current, fiveHour: { usedPct: 1, resetsAt: 8_888_888 } })).toEqual({ fiveHourPctPerUSD: null, weekPctPerUSD: .5 })
  })
})
