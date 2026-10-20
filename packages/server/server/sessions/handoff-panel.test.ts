import { describe, expect, it } from 'bun:test'
import { computeHandoffPanel, createHandoffQuotaSampler, handoffMetrics, quotaRate, type QuotaObservation } from './handoff-panel'
import { toConversation } from './conversations'
import type { HarnessId, SessionMeta } from '@agentistics/core'
import { parseGeminiChat } from '../adapters/gemini-parse'
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

describe('recorded metrics across harnesses', () => {
  it('fills Gemini projections from its real rich JSON and JSONL prompt records', () => {
    const messages = [
      { id: 'u', type: 'user', timestamp: '2026-10-20T12:00:00Z', content: 'Inspect the task' },
      { id: 'g1', type: 'gemini', timestamp: '2026-10-20T12:00:10Z', model: 'gemini-3.8-flash', content: 'Inspecting', tokens: { input: 220_000, cached: 180_000, output: 100 } },
      // A later, smaller prompt after compaction must win over the largest prompt.
      { id: 'g2', type: 'gemini', timestamp: '2026-10-20T12:01:00Z', model: 'gemini-3.8-flash', content: 'Done', tokens: { input: 120_000, cached: 100_000, output: 200 } },
      { id: 'g3', type: 'gemini', timestamp: '2026-10-20T12:01:01Z', content: 'No usage on this record' },
    ]
    const header = { sessionId: 'native-gemini', startTime: '2026-10-20T12:00:00Z', lastUpdated: '2026-10-20T12:01:01Z' }
    for (const content of [JSON.stringify({ ...header, messages }), [header, ...messages].map(m => JSON.stringify(m)).join('\n')]) {
      const session = parseGeminiChat(content, 'project/file', '/work')!
      expect(session.context_tokens).toBe(120_000)
      expect(session.input_tokens).toBe(60_000)
      const conversation = toConversation(session)
      const p = computeHandoffPanel(handoffMetrics({ id: 'm', title: 'Leader', harness: 'gemini', conversationId: 'native-gemini', model: 'auto' }, [conversation]), null)
      expect(p.contextWindow).toBe(1_048_576)
      expect(p.spentUSD).toBeCloseTo(.067125)
      expect(p.nextReplyUSD).toBeCloseTo(.009)
      expect(p.projections.every(r => r.costUSD !== null)).toBe(true)
      expect(p.projections.every(r => r.fiveHourPct === null && r.weekPct === null)).toBe(true)
    }
  })
  const cases: [HarnessId, string, string, number, number][] = [
    ['claude', 'opus', 'claude-opus-5-5', .2, 1.8],
    ['codex', 'gpt-6.1-sol', 'gpt-6.1-sol', .1, .9],
    ['gemini', 'auto', 'gemini-3.8-flash', .075, .525],
    ['copilot', 'auto', 'gpt-6.1-sol', .1, .9],
    ['antigravity', 'gemini-3.8-flash-high', 'gemini-3.8-flash-high', .075, .525],
    ['kimi', 'default', 'claude-opus-5-5', .2, 1.8],
    ['opencode', 'default', 'gpt-6-astra', 1, 7],
  ]
  for (const [harness, spawnModel, model, cacheRate, spent] of cases) {
    it(`${harness}: uses observed usage and model instead of the spawn alias`, () => {
      const conversation = toConversation({
        session_id: harness === 'gemini' ? 'project/session-2026-10-20.json' : 'native-id',
        native_session_id: harness === 'gemini' ? 'native-id' : undefined,
        harness, model, project_path: '/work/task', start_time: '2026-10-20T12:00:00Z',
        input_tokens: 100_000, output_tokens: 20_000, cache_read_input_tokens: 5_000_000,
        cache_creation_input_tokens: 0, assistant_message_count: 84, user_message_count: 12,
        context_tokens: 186_875, context_window: 1_000_000,
      } as SessionMeta)
      const row = handoffMetrics({ id: 'managed', title: 'Leader', harness, model: spawnModel, conversationId: 'native-id' }, [conversation])
      const p = computeHandoffPanel(row, null, { fiveHourPctPerUSD: 2, weekPctPerUSD: .5 })
      expect(p.spentUSD).toBeCloseTo(spent)
      expect(p.replies).toBe(84)
      expect(p.nextReplyUSD).toBeCloseTo(186_875 / 1_000_000 * cacheRate)
      expect(p.successorReplyUSD).toBeCloseTo(.1 * cacheRate)
      expect(p.handoffOverheadUSD).toBeGreaterThan(0)
      for (const projection of p.projections) {
        expect(projection.costUSD).toBeGreaterThan(0)
        expect(projection.fiveHourPct).toBeCloseTo(projection.costUSD! * 2)
        expect(projection.weekPct).toBeCloseTo(projection.costUSD! * .5)
      }
    })
  }
  it('does not borrow a different conversation or harness, even in the same directory', () => {
    const c = { sessionId: 'other-id', harness: 'claude', cwd: '/work', model: 'claude-opus-5-5', costUSD: 7 } as const
    const row = { id: 'm', title: 'Leader', harness: 'claude', conversationId: 'missing', model: 'opus' }
    for (const source of [[c], [{ ...c, sessionId: 'missing', harness: 'gemini' as const }], []]) {
      const p = computeHandoffPanel(handoffMetrics(row, source as ReturnType<typeof toConversation>[]), null)
      expect(p.spentUSD).toBeNull()
      expect(p.nextReplyUSD).toBeNull()
    }
  })
})

describe('quota calibration lifecycle', () => {
  const sample = (at: number, totalUSD: number, five = 20, week = 30): QuotaObservation => ({
    at, totalUSD, population: 'a,b',
    fiveHour: { usedPct: five, resetsAt: 50_000_000 },
    week: { usedPct: week, resetsAt: 500_000_000 },
  })
  it('keeps a useful baseline past five minutes and holds the rate between rounded readings', () => {
    const sampler = createHandoffQuotaSampler()
    expect(sampler.observe('codex:a', sample(0, 10))).toEqual({ fiveHourPctPerUSD: null, weekPctPerUSD: null })
    sampler.observe('codex:a', sample(6 * 60_000, 11))
    expect(sampler.observe('codex:a', sample(7 * 60_000, 12, 24, 31))).toEqual({ fiveHourPctPerUSD: 2, weekPctPerUSD: .5 })
    expect(sampler.observe('codex:a', sample(8 * 60_000, 13, 24, 31))).toEqual({ fiveHourPctPerUSD: 2, weekPctPerUSD: .5 })
    expect(sampler.observe('codex:a', sample(9 * 60_000, 14, 28, 32))).toEqual({ fiveHourPctPerUSD: 2, weekPctPerUSD: .5 })
  })
  it('isolates harnesses/accounts, renewals, population changes and missing or stale data', () => {
    const sampler = createHandoffQuotaSampler()
    sampler.observe('claude:a', sample(0, 10))
    expect(sampler.observe('claude:a', sample(60_000, 12, 24, 31))).toEqual({ fiveHourPctPerUSD: 2, weekPctPerUSD: .5 })
    expect(sampler.observe('codex:a', sample(60_000, 12, 24, 31)).fiveHourPctPerUSD).toBeNull()
    expect(sampler.observe('claude:b', sample(60_000, 12, 24, 31)).weekPctPerUSD).toBeNull()
    expect(sampler.observe('claude:a', { ...sample(120_000, 13, 1, 31), fiveHour: { usedPct: 1, resetsAt: 60_000_000 } })).toEqual({ fiveHourPctPerUSD: null, weekPctPerUSD: .5 })
    expect(sampler.observe('claude:a', { ...sample(180_000, 14), population: 'a' }).weekPctPerUSD).toBeNull()
    expect(sampler.observe('claude:a', { ...sample(240_000, 15), week: undefined }).weekPctPerUSD).toBeNull()
    expect(sampler.observe('claude:a', sample(40 * 60_000, 20, 40, 40))).toEqual({ fiveHourPctPerUSD: null, weekPctPerUSD: null })
    sampler.forget('claude:a')
    expect(sampler.observe('claude:a', sample(41 * 60_000, 21, 42, 41)).fiveHourPctPerUSD).toBeNull()
  })
})
