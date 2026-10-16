import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentVisible, harnessAggregate, meterDiscontinuity, resetNoticesFor,
  alternativeWithRoom, bindingPct, currentUsedPct, effectiveWindow, forecastWindow, mostRoom, parseClaudeRateLimitEvent,
  parseCodexRateLimits, planBudget, planPace, planSlots, planThresholdNotices, registeredPlanLabel,
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

  test('idle under-pace plans still recommend at least two sessions', () => {
    const l = { ...withPlan('codex', 11, 35, 'Plus'), updatedAt: now }
    const pace = planPace(l, now, [{ ...l, updatedAt: now - H, windows: [win('5h', 10, reset5), win('week', 35, resetWeek)] }])
    expect(pace.burnPctPerHour).toBe(0)
    expect(pace.paceStatus).toBe('under')
    expect(pace.freeSlotsMeasured).toBe(false)
    expect(routeRecommendation([{ ...planBudget(l, now), ...pace }], 'mechanical').cadence.parallel).toBeGreaterThanOrEqual(2)
  })

  test('a held five-hour budget has no slots even with zero burn', () => {
    const l = { ...withPlan('codex', 92, 35, 'Plus'), updatedAt: now }
    const pace = planPace(l, now, [{ ...l, updatedAt: now - H, windows: [win('5h', 92, reset5), win('week', 35, resetWeek)] }])
    expect(pace.paceStatus).toBe('under')
    expect(pace.burnPctPerHour).toBe(0)
    expect(pace.suggestedParallel).toBe(0)
    expect(pace.freeSlots).toBe(0)
    expect(pace.pauseUntil).toBe(reset5)
  })

  test('a held weekly budget has no slots even with zero burn', () => {
    const l = { ...withPlan('codex', 72, 96, 'Plus'), updatedAt: now }
    const pace = planPace(l, now, [{ ...l, updatedAt: now - H, windows: [win('5h', 72, reset5), win('week', 96, resetWeek)] }])
    expect(pace.paceStatus).toBe('under')
    expect(pace.burnPctPerHour).toBe(0)
    expect(pace.suggestedParallel).toBe(0)
    expect(pace.freeSlots).toBe(0)
    expect(pace.pauseUntil).toBe(resetWeek)
  })

  test('both windows held: the pause lasts until the weekly reset', () => {
    const l = { ...withPlan('codex', 92, 96, 'Plus'), updatedAt: now }
    const pace = planPace(l, now, [{ ...l, updatedAt: now - H, windows: [win('5h', 92, reset5), win('week', 96, resetWeek)] }])
    expect(pace.freeSlots).toBe(0)
    expect(pace.pauseUntil).toBe(resetWeek)
  })

  test('a below-threshold zero-burn budget still offers two sessions', () => {
    const l = { ...withPlan('codex', 72, 35, 'Plus'), updatedAt: now }
    const pace = planPace(l, now, [{ ...l, updatedAt: now - H, windows: [win('5h', 72, reset5), win('week', 35, resetWeek)] }])
    expect(pace.burnPctPerHour).toBe(0)
    expect(pace.suggestedParallel).toBeGreaterThanOrEqual(2)
    expect(pace.freeSlots).toBeGreaterThanOrEqual(2)
  })
})

test('plan slots use the mean burn of the live sessions', () => {
  const slots = planSlots({
    sustainablePctPerHour: 10,
    liveSessions: [
      { id: 'a', model: 'sonnet', burnPctPerHour: 2 },
      { id: 'b', model: 'opus', burnPctPerHour: 4 },
    ],
  })
  expect(slots.freeSlots).toBe(1)
})

test('11/10 over pace stops new slots and gives a pause-until time', () => {
  const now = Date.parse('2026-11-10T20:00:00Z')
  const reset = now + (1 / 0.28) * H
  const l = lim('codex', [win('5h', 40, reset), win('week', 99, reset)], now)
  const pace = planPace(l, now, [{
    ...l,
    updatedAt: now - H,
    windows: [win('5h', 40, reset), win('week', 94.6, reset)],
  }])
  // 4.4%/h burn against 0.28%/h sustainable: the old ratio-based formula incorrectly offered 8.
  expect(pace.burnPctPerHour).toBeCloseTo(4.4)
  expect(pace.sustainablePctPerHour).toBeCloseTo(0.28)
  expect(pace.paceStatus).toBe('over')
  expect(pace.suggestedParallel).toBe(0)
  expect(pace.freeSlots).toBe(0)
  expect(pace.pauseUntil).toBe(reset)
})

describe('renewed windows project their next period', () => {
  const now = Date.parse('2026-10-15T12:00:00Z')
  const day = 24 * H

  test('a stale weekly reset one day past leaves six days of sustainable budget', () => {
    const l = lim('codex', [win('5h', 99, now - day), win('week', 99, now - day)], now - 3 * day)
    const budget = planBudget(l, now)
    const pace = planPace(l, now)
    expect(budget.daysToWeekReset).toBeGreaterThan(5.9)
    expect(budget.daysToWeekReset).toBeLessThan(6.1)
    expect(budget.weekResetsAt).toBe(now + 6 * day)
    expect(budget.weekResetProjected).toBe(true)
    expect(budget.dailyBudgetPct).toBeLessThan(20)
    expect(budget.status).toBe('ok')
    expect(budget.fiveHourPct).toBe(0)
    expect(budget.weekPct).toBe(0)
    expect(pace.sustainablePctPerHour).toBeCloseTo(100 / 144)
    expect(pace.sustainablePctPerHour).toBeLessThan(100 / 0.5 * 0.99)
    expect(bindingPct(l, now)).toBe(0)
    expect(l.windows[1]).toEqual(win('week', 99, now - day))
  })

  test('near the next projected reset the sustainable rate stays under the absolute criterion', () => {
    const reset = now - 6 * day - 45 * 60_000
    const l = lim('codex', [win('week', 40, reset)], now - 7 * day - 3600_000)
    const at = reset + 7 * day - 15 * 60_000
    const pace = planPace(l, at)
    expect(pace.sustainablePctPerHour).toBeLessThanOrEqual(100 / 0.5 * 0.99)
  })

  test('fifteen days past advances three weekly periods without mutating the reading', () => {
    const w = win('week', 96, now - 15 * day)
    const projected = effectiveWindow(w, now)
    expect(projected).toEqual({ kind: 'week', usedPct: 0, resetsAt: w.resetsAt + 3 * PLAN_WINDOW_MS.week, projected: true })
    expect(projected.resetsAt).toBe(now + 6 * day)
    expect(effectiveWindow(projected, now)).toBe(projected)
    expect(w.usedPct).toBe(96)
    expect(forecastWindow(w, now)).toEqual({ kind: 'renewed' })
  })

  test('reset boundaries advance to a strictly future reset for either kind', () => {
    for (const kind of ['5h', 'week'] as const) {
      const w = win(kind, 100, now)
      expect(effectiveWindow(w, now - 1)).toBe(w)
      expect(effectiveWindow(w, now)).toEqual({ kind, usedPct: 0, resetsAt: now + PLAN_WINDOW_MS[kind], projected: true })
      expect(effectiveWindow(w, now + PLAN_WINDOW_MS[kind]).resetsAt).toBe(now + 2 * PLAN_WINDOW_MS[kind])
    }
  })

  test('an unrenewed captured fixture keeps its existing budget and pace', () => {
    const rec = JSON.parse(fixture('plan-limits-claude.jsonl')) as { t: number; l: string }
    const l = parseClaudeRateLimitEvent(JSON.parse(rec.l), rec.t)!
    for (const w of l.windows) expect(effectiveWindow(w, rec.t)).toBe(w)
    expect(planBudget(l, rec.t)).toEqual({
      harness: 'claude', plan: 'unregistered', fiveHourPct: 25, weekPct: 35,
      weekResetsAt: 1792112400000, daysToWeekReset: 6.010701979166667,
      dailyBudgetPct: 10.81404471978358, status: 'tight',
      updatedAt: 1791593075349, stale: false,
    })
    expect(planPace(l, rec.t)).toEqual({
      paceStatus: 'on', burnPctPerHour: 0.4505851966576492,
      sustainablePctPerHour: 0.4505851966576492, suggestedParallel: 1,
      note: 'On pace: keep the current cadence through the weekly reset.',
      freeSlots: 1, freeSlotsMeasured: true, liveSessions: [],
    })
  })

  test('burn uses only readings at or after the latest weekly renewal', () => {
    const renewal = now - 2 * H
    const reset = renewal + PLAN_WINDOW_MS.week
    const before = lim('codex', [win('week', 1, renewal)], renewal - H)
    const first = lim('codex', [win('week', 4, reset)], renewal)
    const latest = lim('codex', [win('week', 10, reset)], now)
    const pace = planPace(latest, now, [before, first])
    expect(pace.burnPctPerHour).toBeCloseTo(3)
    expect(pace).toEqual(planPace(latest, now, [first]))
    expect(planPace(latest, now, [before]).burnPctPerHour).toBeCloseTo(planPace(latest, now).sustainablePctPerHour)
  })
})

describe('per-account primitives (B1)', () => {
  const now = Date.parse('2026-10-10T00:00:00Z')
  const H = 3_600_000
  const w = (kind: '5h' | 'week', usedPct: number, resetsAt: number) => ({ kind, usedPct, resetsAt })
  const mk = (harness: any, account: string, five: number, week: number, updatedAt = now): PlanLimits =>
    ({ harness, account, plan: 'Max', windows: [w('5h', five, now + 3 * H), w('week', week, now + 72 * H)], updatedAt, source: 'claude-stream' })
  const row = (l: PlanLimits) => ({ ...planBudget(l, now), ...planPace(l, now), account: l.account, updatedAt: l.updatedAt })

  test('agentVisible filters by account id, not harness', () => {
    const rows = [{ harness: 'claude' as const, account: 'acc_a' }, { harness: 'claude' as const, account: 'acc_b' }]
    const accounts = [
      { id: 'acc_a', harness: 'claude' as const, available: false },
      { id: 'acc_b', harness: 'claude' as const, available: true },
    ]
    expect(agentVisible(rows, accounts).map(r => r.account)).toEqual(['acc_b'])
    expect(agentVisible(rows, accounts.map(a => ({ ...a, available: false })))).toEqual([])
    expect(agentVisible(rows, [{ id: 'acc_a', available: true, retired: true }, accounts[1]!]).map(r => r.account)).toEqual(['acc_b'])
  })

  test('legacy default rows follow the harness only when it has a hidden current account', () => {
    const legacy = [{ harness: 'claude' as const, account: 'default' }, { harness: 'codex' as const, account: 'default' }]
    expect(agentVisible(legacy, [{ id: 'x', harness: 'claude', available: false }]).map(r => r.harness)).toEqual(['codex'])
    expect(agentVisible(legacy, [])).toHaveLength(2)
    expect(agentVisible([{ harness: 'claude' as const, account: 'acc_zz' }], [])).toEqual([])
  })

  test('a row with no account is rejected, never treated as the legacy default', () => {
    const unattributed = [{ harness: 'codex' }] as unknown as { harness: 'codex'; account: string }[]
    expect(agentVisible(unattributed, [])).toEqual([])
  })

  test('visibility composes into routing: one hidden account, then both hidden', () => {
    const rows = [
      { ...row(mk('codex', 'acc_a', 10, 20)), harness: 'codex' as const },
      { ...row(mk('codex', 'acc_b', 10, 30)), harness: 'codex' as const },
    ]
    const accts = (a: boolean, b: boolean) => [
      { id: 'acc_a', harness: 'codex' as const, available: a },
      { id: 'acc_b', harness: 'codex' as const, available: b },
    ]
    const one = routeRecommendation(agentVisible(rows.map(r => ({ ...r, account: r.account! })), accts(false, true)), 'mechanical')
    expect(one.account).toBe('acc_b')
    const none = routeRecommendation(agentVisible(rows.map(r => ({ ...r, account: r.account! })), accts(false, false)), 'mechanical')
    expect(none.harness).toBeNull()
  })

  test('route: registered held account + unregistered ok account does not crash', () => {
    const held = { ...row(mk('claude', 'acc_a', 90, 50)), status: 'hold' as const }
    const unreg = { ...row(mk('claude', 'acc_b', 10, 10)), plan: 'unregistered' }
    expect(routeRecommendation([held, unreg], 'lead').harness).toBeNull()
    const alt = row(mk('codex', 'acc_c', 10, 10))
    const r = routeRecommendation([held, unreg, { ...alt, harness: 'codex' as const }], 'lead')
    expect(r.harness).toBe('codex')
    expect(r.account).toBe('acc_c')
  })

  test('route: registered tight account + unregistered ok account is not eligible off-lead', () => {
    const tight = { ...row(mk('claude', 'acc_a', 10, 85)), status: 'tight' as const }
    const unreg = { ...row(mk('claude', 'acc_b', 10, 10)), plan: 'unregistered' }
    expect(routeRecommendation([tight, unreg], 'mechanical').harness).toBeNull()
    expect(routeRecommendation([tight, unreg], 'lead').account).toBe('acc_a')
  })

  test.each(['claude', 'codex', 'gemini', 'copilot'] as const)('aggregate pace/slots are harness-generic (%s)', h => {
    const p = (account: string, paceStatus: 'under' | 'on' | 'over', freeSlots: number, status: 'ok' | 'hold' = 'ok') =>
      ({ ...row(mk(h, account, 10, 20)), harness: h, paceStatus, freeSlots, status })
    const [agg] = harnessAggregate([p('a', 'over', 1), p('b', 'on', 2), p('c', 'under', 4, 'hold'), p('d', 'under', 0, 'hold')])
    expect(agg).toMatchObject({ harness: h, freeSlots: 3, paceStatus: 'on' })
    expect(harnessAggregate([p('c', 'under', 4, 'hold')])[0]).toMatchObject({ status: 'hold', freeSlots: 0 })
    expect(harnessAggregate([p('c', 'under', 4, 'hold')])[0]!.paceStatus).toBeUndefined()
  })

  test('meterDiscontinuity boundaries: exactly 1h / exactly 15 points / no matching kind', () => {
    const prev = mk('claude', 'acc_a', 50, 60, now)
    const pw = prev.windows[1]!
    const next = (usedPct: number, resetsAt: number, kind: '5h' | 'week' = 'week'): PlanLimits =>
      ({ ...prev, updatedAt: now + 1000, windows: [w(kind, usedPct, resetsAt)] })
    expect(meterDiscontinuity(prev, next(40, pw.resetsAt + H))).toBe(false) // exactly 1h is not > 1h
    expect(meterDiscontinuity(prev, next(40, pw.resetsAt + H + 1))).toBe(true)
    expect(meterDiscontinuity(prev, next(45, pw.resetsAt + 2 * H))).toBe(true) // drop of exactly 15
    expect(meterDiscontinuity(prev, next(46, pw.resetsAt + 2 * H))).toBe(false)
    expect(meterDiscontinuity({ ...prev, windows: [w('week', 60, pw.resetsAt)] }, next(10, pw.resetsAt + 2 * H, '5h'))).toBe(false)
  })

  test('aggregate sums free slots of non-held accounts; hold only when all hold', () => {
    const a = { ...row(mk('claude', 'acc_a', 10, 20)), freeSlots: 2 }
    const b = { ...row(mk('claude', 'acc_b', 10, 30)), freeSlots: 3 }
    const held = { ...row(mk('claude', 'acc_c', 90, 50)), freeSlots: 0 }
    const [agg] = harnessAggregate([a, b, held])
    expect(agg).toMatchObject({ harness: 'claude', freeSlots: 5, accounts: 3 })
    expect(agg!.status).not.toBe('hold')
    expect(harnessAggregate([held])[0]!.status).toBe('hold')
  })

  test('Q6: of two accounts with room, drain the one whose week resets first; tie -> most room', () => {
    const soon = row({ ...mk('claude', 'acc_soon', 40, 60), windows: [w('5h', 40, now + 3 * H), w('week', 60, now + 24 * H)] })
    const late = row({ ...mk('claude', 'acc_late', 5, 10), windows: [w('5h', 5, now + 3 * H), w('week', 10, now + 120 * H)] })
    // acc_late has far more room, but acc_soon's quota is lost first: it takes the work.
    const r = routeRecommendation([late, soon], 'hard-bug')
    expect(r.account).toBe('acc_soon')
    expect(r.accountAlternatives).toEqual([{ harness: 'claude', account: 'acc_late' }])
    // Same week reset -> the one with the most room.
    const a = row(mk('claude', 'acc_a', 10, 45))
    const b = row(mk('claude', 'acc_b', 10, 30))
    expect(routeRecommendation([a, b], 'hard-bug').account).toBe('acc_b')
    // A held account is never drained, however soon it resets.
    const held = row({ ...mk('claude', 'acc_held', 10, 99), windows: [w('5h', 10, now + 3 * H), w('week', 99, now + 6 * H)] })
    expect(routeRecommendation([held, late], 'hard-bug').account).toBe('acc_late')
  })

  test('Q6: a missing week window sorts after real weekly resets, then ties use room', () => {
    const noWeek = row({ ...mk('claude', 'acc_no_week', 80, 0), windows: [w('5h', 80, now + 3 * H)] })
    const weekly = row({ ...mk('claude', 'acc_week', 5, 10), windows: [w('5h', 5, now + 3 * H), w('week', 10, now + 120 * H)] })
    expect(routeRecommendation([noWeek, weekly], 'hard-bug').account).toBe('acc_week')
    const roomy = row({ ...mk('claude', 'acc_roomy', 5, 0), windows: [w('5h', 5, now + 3 * H)] })
    expect(routeRecommendation([noWeek, roomy], 'hard-bug').account).toBe('acc_roomy')
  })

  test('route picks the account with most room; ties go to the newest', () => {
    const a = row(mk('claude', 'acc_a', 10, 45))
    const b = row(mk('claude', 'acc_b', 10, 30))
    const r = routeRecommendation([a, b], 'hard-bug')
    expect(r.harness).toBe('claude')
    expect(r.account).toBe('acc_b')
    expect(r.accountAlternatives).toEqual([{ harness: 'claude', account: 'acc_a' }])
    const t1 = row(mk('claude', 'acc_old', 10, 30, now - H))
    const t2 = row(mk('claude', 'acc_new', 10, 30, now))
    expect(routeRecommendation([t1, t2], 'hard-bug').account).toBe('acc_new')
  })

  test('planPace ignores readings before the segment start', () => {
    const before = mk('claude', 'acc_a', 10, 10, now - 3 * H)
    const latest = mk('claude', 'acc_a', 10, 40, now)
    expect(planPace(latest, now, [before]).burnPctPerHour).toBeCloseTo(10)
    expect(planPace(latest, now, [before], [], now - H).burnPctPerHour).toBeCloseTo(planPace(latest, now).sustainablePctPerHour)
  })

  test('resetNoticesFor clears only that account', () => {
    const st = { 'claude:acc_a:5h': { resetsAt: 1, told: 75 }, 'claude:acc_b:5h': { resetsAt: 1, told: 75 } }
    expect(Object.keys(resetNoticesFor(st, 'claude', 'acc_a'))).toEqual(['claude:acc_b:5h'])
  })

  test('meterDiscontinuity needs all three conditions', () => {
    const prev = mk('claude', 'acc_a', 50, 60, now)
    const at = now + 1000
    const base = { ...prev, updatedAt: at }
    const week = (usedPct: number, resetsAt: number): PlanLimits => ({ ...base, windows: [w('week', usedPct, resetsAt)] })
    const pw = prev.windows[1]!
    expect(meterDiscontinuity(prev, week(40, pw.resetsAt + 2 * H))).toBe(true)
    expect(meterDiscontinuity(prev, week(40, pw.resetsAt + 10 * 60_000))).toBe(false) // reset barely moved
    expect(meterDiscontinuity(prev, week(55, pw.resetsAt + 2 * H))).toBe(false) // drop < 15
    expect(meterDiscontinuity({ ...prev, windows: [w('week', 60, now - 1)] }, week(40, now + 2 * H))).toBe(false) // old renewed
  })
})
