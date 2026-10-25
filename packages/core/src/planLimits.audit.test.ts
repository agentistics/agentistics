import { describe, expect, test } from 'bun:test'
import {
  effectiveWindow, forecastWindow, planBudget, planPace, planSlots, routeRecommendation, PLAN_WINDOW_MS,
  type PlanLimits, type PlanWindowKind,
} from './planLimits'

const H = 3_600_000
const NOW = Date.parse('2026-10-25T12:00:00Z')
function limits(pct = 40, reset = NOW + 60 * H, updatedAt = NOW, account = 'a'): PlanLimits {
  return { harness: 'codex', account, source: 'codex-rollout', updatedAt,
    windows: [{ kind: 'week', usedPct: pct, resetsAt: reset }] }
}

describe('Usage audit: budgets, measurements and thresholds', () => {
  for (const [pct, expected] of [[0, 100 / 2.5], [40, 24], [100, 0], [125, 0]]) {
    test(`daily budget at ${pct}% remains nonnegative`, () => {
      expect(planBudget(limits(pct), NOW).dailyBudgetPct).toBeCloseTo(expected!)
    })
  }
  for (const [ratio, expected] of [[0, 'under'], [0.79, 'under'], [0.8, 'on'], [1, 'on'], [1.2, 'on'], [1.21, 'over']] as const) {
    test(`recent burn/sustainable ratio ${ratio} is ${expected}`, () => {
      // Remaining 60% / 60h = 1%/h, so an hour's delta is exactly the ratio.
      const l = limits()
      const p = planPace(l, NOW, [limits(40 - ratio, l.windows[0]!.resetsAt, NOW - H)])
      expect(p.burnPctPerHour).toBeCloseTo(ratio)
      expect(p.sustainablePctPerHour).toBe(1)
      expect(p.paceStatus).toBe(expected)
    })
  }
  test('one reading is policy fallback, not measured capacity; positive live burn is measured', () => {
    const l = limits()
    expect(planPace(l, NOW)).toMatchObject({ paceStatus: 'on', freeSlotsMeasured: false })
    expect(planPace(l, NOW, [], [{ id: 's', model: 'm', burnPctPerHour: 0.5 }]).freeSlotsMeasured).toBe(true)
  })
  test('positive burn against zero remaining quota is over pace', () => {
    expect(planPace(limits(100), NOW, [limits(99, NOW + 60 * H, NOW - H)]))
      .toMatchObject({ paceStatus: 'over', sustainablePctPerHour: 0, suggestedParallel: 0, freeSlots: 0 })
  })
  test('different account, different renewal, old segment and future samples cannot measure this window', () => {
    const l = limits()
    const samples = [limits(1, NOW + 60 * H, NOW - H, 'b'),
      limits(1, NOW + 59 * H, NOW - H), limits(1, NOW + 60 * H, NOW + H)]
    for (const sample of samples) expect(planPace(l, NOW, [sample]).freeSlotsMeasured).toBe(false)
    expect(planPace(l, NOW, [limits(1, NOW + 60 * H, NOW - H)], [], NOW - H / 2).freeSlotsMeasured).toBe(false)
  })
  for (const [five, week, status, pause] of [
    [84.9, 40, 'ok', undefined], [85, 40, 'hold', NOW + H],
    [0, 80, 'tight', undefined], [0, 95, 'hold', NOW + 60 * H],
    [90, 96, 'hold', NOW + 60 * H],
  ] as const) test(`hold boundaries: 5h=${five}, week=${week}`, () => {
    const l = limits(week)
    l.windows.push({ kind: '5h', usedPct: five, resetsAt: NOW + H })
    expect(planBudget(l, NOW).status).toBe(status)
    expect(planPace(l, NOW).pauseUntil).toBe(pause)
  })
  test('over-pace pause solves remaining/burn and respects the next 5h recheck', () => {
    const l = limits()
    const history = [limits(38, NOW + 60 * H, NOW - H)]
    expect(planPace(l, NOW, history).pauseUntil).toBe(NOW + 30 * H)
    l.windows.push({ kind: '5h', usedPct: 10, resetsAt: NOW + H })
    expect(planPace(l, NOW, history).pauseUntil).toBe(NOW + H)
  })
  test('missing weekly window has no measured weekly burn', () => {
    const l = limits(); l.windows = [{ kind: '5h', usedPct: 10, resetsAt: NOW + H }]
    expect(planPace(l, NOW, [{ ...l, updatedAt: NOW - H }]).freeSlotsMeasured).toBe(false)
    expect(planBudget(l, NOW).weekResetsAt).toBe(NOW)
  })
  test('slot pool subtracts measured live burn before dividing by average per-session burn', () => {
    expect(planSlots({ sustainablePctPerHour: 2, liveSessions: [
      { id: 'a', model: 'm', burnPctPerHour: 0.5 }, { id: 'b', model: 'm', burnPctPerHour: 0.5 },
    ] }).freeSlots).toBe(2)
  })
  test('decimal slot boundaries do not lose a whole slot', () => {
    expect(planSlots({ sustainablePctPerHour: 1.2, typicalBurnPctPerHour: 0.4, liveSessions: [] }).freeSlots).toBe(3)
    expect(planSlots({ sustainablePctPerHour: 1.19, typicalBurnPctPerHour: 0.4, liveSessions: [] }).freeSlots).toBe(2)
  })
})

describe('Usage audit: tight is a warning, not a routing hold', () => {
  const rows = () => (['claude', 'codex'] as const).map((harness, i) => {
    const l = limits(i === 0 ? 66 : 4, NOW + (i === 0 ? 4.55 : 6.85) * 24 * H, NOW, `${harness}-account`)
    l.harness = harness
    l.plan = 'Registered plan'
    l.windows.push({ kind: '5h', usedPct: i === 0 ? 72 : 27, resetsAt: NOW + 2 * H })
    const history = [{ ...l, updatedAt: NOW - 0.8 * H, windows: l.windows.map(w => w.kind === 'week' ? { ...w, usedPct: w.usedPct - (i === 0 ? 0.1 : 0.2) } : w) }]
    return { ...planBudget(l, NOW), ...planPace(l, NOW, history), account: l.account, spawnable: true }
  })

  for (const kind of ['lead', 'hard-bug', 'design', 'spec-impl', 'mechanical', 'qa', 'probe'] as const) {
    test(`tight/under plans at 72% and 27% 5h still route ${kind}`, () => {
      const budgets = rows()
      for (const b of budgets) expect(b).toMatchObject({ status: 'tight', paceStatus: 'under', suggestedParallel: 2, freeSlots: 2 })
      const r = routeRecommendation(budgets, kind, kind === 'qa' ? 'claude' : undefined)
      expect(r.harness).not.toBeNull()
      expect(r.cadence.parallel).toBe(2)
      expect(r.reason).not.toContain('all plans on hold')
      expect(r.reason).toContain('Tight budget warning.')
      if (kind === 'qa') expect(r.harness).toBe('codex')
    })
  }
  test('a weekly warning below the 95% hold threshold does not block workers', () => {
    const b = { ...rows()[0]!, weekPct: 90 }
    expect(routeRecommendation([b], 'mechanical').harness).toBe('claude')
  })
  test('a real hold still blocks and names the earliest actual 5h/week pause', () => {
    const budgets = rows().map((b, i) => ({ ...b, status: 'hold' as const, pauseUntil: NOW + (i + 1) * H }))
    const r = routeRecommendation(budgets, 'mechanical')
    expect(r.harness).toBeNull()
    expect(r.cadence.parallel).toBe(0)
    expect(r.reason).toBe(`all plans on hold until ${new Date(NOW + H).toISOString()}`)
  })
  test('registration, author exclusion and yielded rows do not falsely claim all plans are held', () => {
    for (const budgets of [[], rows().map(b => ({ ...b, plan: 'unregistered' })),
      [rows()[0]!], rows().map(b => ({ ...b, yieldsTo: 'fresh-account' }))]) {
      const r = routeRecommendation(budgets, 'qa', 'claude')
      expect(r.harness).toBeNull()
      expect(r.reason).toBe('No eligible plan for qa.')
    }
  })
})

describe('Usage audit: window average forecasts and renewal', () => {
  for (const fiveHourPct of [0, 27, 84.9]) test(`4% week with 6.85 days left is tight independently of 5h=${fiveHourPct}`, () => {
    const weekly = { kind: 'week' as const, usedPct: 4, resetsAt: NOW + 6.85 * 24 * H }
    const l = limits(weekly.usedPct, weekly.resetsAt)
    l.windows.push({ kind: '5h', usedPct: fiveHourPct, resetsAt: NOW + 2 * H })
    const elapsedHours = (NOW - (weekly.resetsAt - PLAN_WINDOW_MS.week)) / H
    expect(elapsedHours).toBeCloseTo(3.6)
    expect(elapsedHours / (7 * 24) * 100).toBeCloseTo(2.142857)
    expect(forecastWindow(weekly, NOW, l.updatedAt)).toEqual({ kind: 'runs-out', at: NOW + 86.4 * H })
    expect(planBudget(l, NOW)).toMatchObject({ status: 'tight', fiveHourPct, weekPct: 4, daysToWeekReset: 6.85 })
  })
  test('the same 4% lasts when enough of the week has elapsed', () => {
    const l = limits(4, NOW + 6.5 * 24 * H)
    l.windows.push({ kind: '5h', usedPct: 27, resetsAt: NOW + 2 * H })
    expect(forecastWindow(l.windows[0]!, NOW, l.updatedAt)).toEqual({ kind: 'lasts' })
    expect(planBudget(l, NOW).status).toBe('ok')
  })
  for (const pct of [4, 5, 66]) test(`${pct}% forecast stays fixed between readings`, () => {
    const w = { kind: 'week' as const, usedPct: pct, resetsAt: NOW + PLAN_WINDOW_MS.week * 0.99 }
    const expected = forecastWindow(w, NOW, NOW)
    expect(expected.kind).toBe('runs-out')
    for (const minutes of [1, 4, 10]) expect(forecastWindow(w, NOW + minutes * 60_000, NOW)).toEqual(expected)
    expect(forecastWindow(w, NOW + 60_000, NOW + 60_000)).not.toEqual(expected)
    expect(forecastWindow(w, w.resetsAt, NOW)).toEqual({ kind: 'renewed' })
  })
  for (const kind of ['week', '5h'] as PlanWindowKind[]) {
    const length = PLAN_WINDOW_MS[kind]
    for (const [pct, result] of [[0, 'lasts'], [20, 'lasts'], [80, 'runs-out'], [100, 'exhausted'], [120, 'exhausted']] as const) {
      test(`${kind} half elapsed, ${pct}% → ${result}`, () => {
        const w = { kind, usedPct: pct, resetsAt: NOW + length / 2 }
        expect(forecastWindow(w, NOW).kind).toBe(result)
        if (result === 'runs-out') expect(forecastWindow(w, NOW)).toEqual({ kind: 'runs-out', at: NOW + length / 8 })
      })
    }
    for (const ago of [0, 1, length * 3 + 123]) test(`${kind} renewal ${ago}ms ago is projected once into the current period`, () => {
      const w = { kind, usedPct: 99, resetsAt: NOW - ago }
      const next = effectiveWindow(w, NOW)
      expect(next.usedPct).toBe(0)
      expect(next.projected).toBe(true)
      expect(next.resetsAt).toBeGreaterThan(NOW)
      expect(next.resetsAt - NOW).toBeLessThanOrEqual(length)
      expect(forecastWindow(w, NOW)).toEqual({ kind: 'renewed' })
    })
  }
  test('staleness threshold is strictly older than ten minutes', () => {
    for (const [age, stale] of [[600_000, false], [600_001, true]] as const) {
      expect(planBudget(limits(40, NOW + 60 * H, NOW - age), NOW).stale).toBe(stale)
    }
  })
})
