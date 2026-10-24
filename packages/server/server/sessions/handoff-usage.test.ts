import { describe, it, expect } from 'bun:test'
import type { PlanLimits, HarnessId } from '@agentistics/core'
import { windowQuotaRate, retainedQuotaRate, accountForReply, countBilledReplies, type BilledReply } from './handoff-usage'
import { computeHandoffPanel, handoffMetrics } from './handoff-panel'
import { parseCodexRollout } from '../adapters/codex-parse'
import { toConversation } from './conversations'
import type { ManagedSession } from './types'

const now = Date.parse('2026-10-20T16:00:00Z')
const five = 5 * 3600_000, week = 7 * 24 * 3600_000
const limit = (harness: HarnessId, account = 'a'): PlanLimits => ({ harness, account, updatedAt: now,
  windows: [{ kind: '5h', usedPct: 24, resetsAt: now + 3600_000 }, { kind: 'week', usedPct: 35, resetsAt: now + 24 * 3600_000 }],
} as PlanLimits)
const reply = (harness: HarnessId, costUSD: number | null, at = now - 1000, account = 'a'): BilledReply => ({ harness, conversationId: 'conversation', account, costUSD, at })

describe('account history calibration', () => {
  for (const harness of ['claude', 'codex'] as const) it(`${harness}: calibrates immediately from all conversations in each meter window`, () => {
    const l = limit(harness)
    const rows = [reply(harness, 6), { ...reply(harness, 6), conversationId: 'closed-conversation' }, reply(harness, 58, now - five),
      reply(harness, 1000, now - week), reply(harness, 1000, now + 1), reply(harness, 1000, now - 1000, 'other'), reply('gemini', 1000)]
    const rates = windowQuotaRate(l, rows, now)
    expect(rates).toEqual({ fiveHourPctPerUSD: 2, weekPctPerUSD: .5 })
    const p = computeHandoffPanel({ id: harness, title: 'Leader', model: harness === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol', contextTokens: 200000, contextWindow: 1000000 }, null, rates)
    for (const r of p.projections) { expect(r.fiveHourPct).toBeCloseTo(r.costUSD! * 2); expect(r.weekPct).toBeCloseTo(r.costUSD! * .5) }
  })
  it('uses only spend at or before the reading and reports no invented rate without spend', () => {
    expect(windowQuotaRate(limit('codex'), [reply('codex', 100, now + 1)], now).fiveHourPctPerUSD).toBeNull()
    expect(windowQuotaRate(limit('codex'), [reply('codex', null)], now).weekPctPerUSD).toBeNull()
  })
  it('restores a serialized last good account rate after a reset/restart', () => {
    const saved = JSON.parse(JSON.stringify({ 'codex:a': { fiveHourPctPerUSD: 2, weekPctPerUSD: .5 } }))
    const reset = limit('codex'); reset.windows.forEach(w => w.usedPct = 0)
    expect(retainedQuotaRate(windowQuotaRate(reset, [], now), saved['codex:a'])).toEqual(saved['codex:a'])
    expect(retainedQuotaRate(windowQuotaRate(reset, [], now), saved['codex:b'])).toEqual({ fiveHourPctPerUSD: null, weekPctPerUSD: null })
    expect(retainedQuotaRate({ fiveHourPctPerUSD: NaN, weekPctPerUSD: Infinity }, saved['codex:a'])).toEqual(saved['codex:a'])
  })
  it('keeps the source account of an old conversation after a managed session switches account', () => {
    const accounts = { version: 2 as const, accounts: [], segments: {}, bindings: { 'codex:/accounts/old': 'old', 'codex:/accounts/new': 'new' } }
    const managed = [{ id: 'm', harness: 'codex', conversationId: 'c', accountId: 'new' }] as ManagedSession[]
    expect(accountForReply('codex', 'c', '/accounts/old/sessions/file.jsonl:33', accounts, managed, [])).toBe('old')
    expect(accountForReply('codex', 'c', '/accounts/new/sessions/file.jsonl:34', accounts, managed, [])).toBe('new')
  })
  it('gives no-meter harnesses an explicit explanation without a made-up rate', () => {
    const p = computeHandoffPanel({ id: 'g', title: 'Gemini', model: 'gemini-3.8-flash', contextTokens: 100000, contextWindow: 1000000 }, null,
      { fiveHourPctPerUSD: null, weekPctPerUSD: null, unavailableReason: 'no-meter' })
    expect(p.quotaUnavailableReason).toBe('no-meter')
    expect(p.projections[0]!.fiveHourPct).toBeNull()
    expect(p.projections[0]!.costUSD).toBeGreaterThan(0)
  })
  it('fills Codex replies from response_item records without double-counting agent_message mirrors', () => {
    const records = [{ type: 'session_meta', payload: { id: 'c', timestamp: '2026-10-20T12:00:00Z', cwd: '/work' } },
      ...[1, 2, 3].map(n => ({ type: 'response_item', timestamp: `2026-10-20T12:00:0${n}Z`, payload: { type: 'message', role: 'assistant', content: [] } }))]
    const parse = (more: object[] = []) => toConversation(parseCodexRollout([...records, ...more].map(r => JSON.stringify(r)).join('\n'), 'c')!)
    expect(computeHandoffPanel(handoffMetrics({ id: 'm', title: 'Leader', harness: 'codex', conversationId: 'c' }, [parse()]), null).replies).toBe(3)
    expect(parse([1, 2, 3].map(() => ({ type: 'event_msg', payload: { type: 'agent_message', message: 'reply' } }))).calls).toBe(3)
    expect(countBilledReplies([reply('gemini', 1), reply('gemini', 2), reply('codex', 1)]).get('gemini:conversation')).toBe(2)
  })
})
