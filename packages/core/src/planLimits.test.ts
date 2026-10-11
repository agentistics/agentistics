import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  alternativeWithRoom, currentUsedPct, forecastWindow, mostRoom, parseClaudeRateLimitEvent,
  parseCodexRateLimits, planBudget, planPace, planThresholdNotices, registeredPlanLabel,
  routeRecommendation, PLAN_WINDOW_MS,
  type PlanLimits, type PlanNoticeState,
} from './planLimits'

const fixture = (name: string) => readFileSync(join(import.meta.dir, '__fixtures__', name), 'utf8').trim()

describe('parsers — real captured lines', () => {
  test('claude: a structured out.jsonl record carrying a rate_limit_event', () => {
    const rec = JSON.parse(fixture('plan-limits-claude.jsonl')) as { t: number; l: string }
    const l = parseClaudeRateLimitEvent(JSON.parse(rec.l), rec.t)!
    expect(l.harness).toBe('claude')
    expect(l.source).toBe('claude-stream')
    expect(l.updatedAt).toBe(rec.t)
    expect(l.windows.map(w => w.kind)).toEqual(['5h', 'week'])
    for (const w of l.windows) {
      expect(w.usedPct).toBeGreaterThanOrEqual(0)
      expect(w.usedPct).toBeLessThanOrEqual(100)
      expect(w.resetsAt).toBeGreaterThan(1_700_000_000_000) // ms, not seconds
    }
  })
  test('codex: a rollout token_count event', () => {
    const line = JSON.parse(fixture('plan-limits-codex.jsonl'))
    const l = parseCodexRateLimits(line)!
    expect(l.harness).toBe('codex')
    expect(l.windows.map(w => w.kind)).toEqual(['5h', 'week'])
    expect(l.updatedAt).toBe(Date.parse(line.timestamp))
    expect(l.sourcePlan).toBe(line.payload.rate_limits.plan_type)
    expect(l.windows[1]!.usedPct).toBe(line.payload.rate_limits.secondary.used_percent)
    expect(l.windows[0]!.resetsAt).toBe(line.payload.rate_limits.primary.resets_at * 1000)
  })
  test('anything else is null, never a zero record', () => {
    expect(parseClaudeRateLimitEvent({ type: 'assistant' }, 1)).toBeNull()
    expect(parseClaudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: {} }, 1)).toBeNull()
    expect(parseCodexRateLimits({ timestamp: '2026-10-10T00:00:00Z', payload: { type: 'token_count', rate_limits: null } })).toBeNull()
    expect(parseCodexRateLimits({ payload: { type: 'agent_message' } })).toBeNull()
    // an unknown window length is skipped, not guessed
    expect(parseCodexRateLimits({ timestamp: '2026-10-10T00:00:00Z', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 5, window_minutes: 60, resets_at: 1 } } } })).toBeNull()
  })
})

const H = 3_600_000
const win = (kind: '5h' | 'week', usedPct: number, resetsAt: number) => ({ kind, usedPct, resetsAt })
const lim = (harness: 'claude' | 'codex', windows: ReturnType<typeof win>[], updatedAt = 0): PlanLimits =>
  ({ harness, account: 'default', windows, updatedAt, source: harness === 'claude' ? 'claude-stream' : 'codex-rollout' })

describe('forecast', () => {
  const now = 10 * H
  test('slow pace lasts past renewal', () => {
    // opened 4h ago (resets in 1h), 20% used → 5%/h → 80% left needs 16h
    expect(forecastWindow(win('5h', 20, now + H), now)).toEqual({ kind: 'lasts' })
  })
  test('fast pace runs out before renewal, at the extrapolated time', () => {
    // opened 1h ago (resets in 4h), 50% used → 50%/h → runs out in 1h
    expect(forecastWindow(win('5h', 50, now + 4 * H), now)).toEqual({ kind: 'runs-out', at: now + H })
  })
  test('exhausted and renewed', () => {
    expect(forecastWindow(win('week', 100, now + H), now)).toEqual({ kind: 'exhausted', until: now + H })
    expect(forecastWindow(win('week', 100, now - 1), now)).toEqual({ kind: 'renewed' })
    expect(currentUsedPct(win('week', 80, now - 1), now)).toBe(0)
  })
  test('nothing used lasts', () => {
    expect(forecastWindow(win('week', 0, now + PLAN_WINDOW_MS.week), now)).toEqual({ kind: 'lasts' })
  })
})

describe('threshold notices — once per threshold per period', () => {
  const R = 100 * H
  const step = (s: PlanNoticeState, pct: number, resetsAt = R) => planThresholdNotices(s, lim('claude', [win('5h', pct, resetsAt)]))
  test('each threshold once, highest only on a jump', () => {
    let s: PlanNoticeState = {}
    let r = step(s, 70); expect(r.notices).toEqual([]); s = r.state
    r = step(s, 76); expect(r.notices.map(n => n.threshold)).toEqual([75]); s = r.state
    r = step(s, 80); expect(r.notices).toEqual([]); s = r.state
    r = step(s, 97); expect(r.notices.map(n => n.threshold)).toEqual([95]); s = r.state
    r = step(s, 96); expect(r.notices).toEqual([]); s = r.state
    r = step(s, 100); expect(r.notices.map(n => n.threshold)).toEqual([100]); s = r.state
    r = step(s, 100); expect(r.notices).toEqual([])
  })
  test('a renewal clears; jitter in resetsAt does not', () => {
    let s = step({}, 90).state
    expect(step(s, 90, R + 30_000).notices).toEqual([])
    const renewed = step(s, 80, R + 5 * H)
    expect(renewed.notices.map(n => n.threshold)).toEqual([75])
    s = renewed.state
    // an older record (previous period) arriving late is ignored
    expect(step(s, 99, R).notices).toEqual([])
  })
})

describe('comparisons', () => {
  const now = 0
  const c = lim('claude', [win('5h', 90, H), win('week', 40, 50 * H)])
  const x = lim('codex', [win('5h', 10, H), win('week', 30, 50 * H)])
  test('most room', () => {
    expect(mostRoom([c, x], now)).toBe('codex')
    expect(mostRoom([c], now)).toBeNull()
  })
  test('alternative with room', () => {
    expect(alternativeWithRoom([c, x], 'claude', now)).toBe('codex')
    expect(alternativeWithRoom([c, lim('codex', [win('5h', 99, H)])], 'claude', now)).toBeNull()
  })
})

test('registered plan label: current subscription period only', () => {
  const billing = { profiles: { claude: { periods: [
    { id: 'a', mode: 'subscription' as const, planId: 'other', label: 'Max antigo', price: { amount: 1, currency: 'USD' as const }, from: '2026-01-01', to: '2026-05-31' },
    { id: 'b', mode: 'subscription' as const, planId: 'other', label: 'Max 20x', price: { amount: 1, currency: 'USD' as const }, from: '2026-06-01' },
  ] } } }
  expect(registeredPlanLabel(billing, 'claude', Date.parse('2026-10-09T12:00:00Z'))).toBe('Max 20x')
  expect(registeredPlanLabel(billing, 'claude', Date.parse('2026-03-01T12:00:00Z'))).toBe('Max antigo')
  expect(registeredPlanLabel(billing, 'codex', Date.parse('2026-10-09T12:00:00Z'))).toBeUndefined()
})

describe('budgets, pacing, and routing', () => {
  const now = Date.parse('2026-10-10T00:00:00Z')
  const reset5 = now + 5 * H
  const resetWeek = now + 3 * 24 * H
  const withPlan = (harness: 'claude' | 'codex', five: number, week: number, plan: string): PlanLimits => ({
    ...lim(harness, [win('5h', five, reset5), win('week', week, resetWeek)]), plan,
  })

  test('hold is driven by the five-hour or 95% weekly threshold', () => {
    expect(planBudget(withPlan('claude', 90, 55, 'Max'), now).status).toBe('hold')
    expect(planBudget(withPlan('codex', 11, 35, 'Plus'), now).status).toBe('ok')
    expect(planBudget(withPlan('codex', 11, 80, 'Plus'), now).status).toBe('tight')
    expect(planBudget(withPlan('codex', 11, 95, 'Plus'), now).status).toBe('hold')
  })

  test('days to the weekly reset are days, and the daily budget spreads what is left over them', () => {
    const b = planBudget(withPlan('claude', 34, 70, 'Max'), now)
    expect(b.daysToWeekReset).toBeCloseTo(3)
    expect(b.dailyBudgetPct).toBeCloseTo(10)
  })

  test('routes spec implementation to codex and QA away from its author', () => {
    const claude = planBudget(withPlan('claude', 20, 55, 'Max'), now)
    const codex = planBudget(withPlan('codex', 11, 35, 'Plus'), now)
    const gemini = { ...planBudget({ ...withPlan('gemini' as any, 10, 20, 'Pro'), harness: 'gemini' as any }, now), ...planPace(withPlan('gemini' as any, 10, 20, 'Pro'), now) }
    const budgets = [claude, codex, gemini]
    expect(routeRecommendation(budgets, 'spec-impl').harness).toBe('codex')
    expect(routeRecommendation(budgets, 'qa', 'codex').harness).toBe('gemini')
  })

  test('under pace increases cadence and is stated in the recommendation', () => {
    const l = { ...withPlan('codex', 11, 35, 'Plus'), updatedAt: now }
    const pace = planPace(l, now, [{ ...l, updatedAt: now - 6 * H, windows: [win('5h', 10, reset5), win('week', 34, resetWeek)] }])
    expect(pace.paceStatus).toBe('under')
    expect(pace.suggestedParallel).toBeGreaterThanOrEqual(2)
    expect(routeRecommendation([{ ...planBudget(l, now), ...pace }], 'mechanical').reason).toContain('Under pace')
  })
})
