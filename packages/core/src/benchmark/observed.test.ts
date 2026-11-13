import { describe, expect, test } from 'bun:test'
import type { MetricItem, TimeBucket } from '../deliveryMetrics'
import type { Priced, SessionRole } from './contract'
import { buildObserved, type ObservedSession } from './observed'

const DAY = 24 * 3600 * 1000
const price = (usd: number | null): Priced => ({ costUSD: usd, basis: 'table×tokens', priceTable: 't', ...(usd === null ? { missing: 'tokens' as const } : {}) })
const stage = (running: number): Record<TimeBucket, number> => ({ queue: 0, running, qa: 0, adjust: 0, leader: 0, merge: 0, ci: 0, blocked: 0 })

function item(id: string, o: Partial<MetricItem> = {}): MetricItem {
  return {
    subtaskId: id, taskId: 't', taskTitle: 'T', title: id, priority: null, version: null, stage: 'published', harness: 'claude', authorModel: null,
    startMs: 0, startBasis: 'queue', publishedAtMs: 10 * DAY, refMs: 10 * DAY, leadMs: DAY, stageMs: stage(3600_000),
    qaResult: 'first_pass', qaRejections: 0, adjustRounds: 0, blocks: [], costUSD: null, tokens: null, eta: null, hasEta: false, queueMs: 0, ...o,
  }
}
const sess = (id: string, subtaskId: string | null, role: SessionRole, usd: number | null, o: Partial<ObservedSession> = {}): ObservedSession =>
  ({ id, subtaskId, harness: 'claude', role, cost: price(usd), ...o })

describe('buildObserved', () => {
  const items = [item('d1'), item('d2', { qaResult: 'rejected_once', qaRejections: 1 }), item('d3', { qaResult: 'pending', publishedAtMs: null, leadMs: null }), item('d4', { qaResult: 'rejected_many', qaRejections: 3 })]
  const sessions = [
    sess('s1', 'd1', 'leader', 2), sess('s2', 'd1', 'worker', 6), sess('s3', 'd2', 'worker', 5, { wasted: true }),
    sess('s4', 'd2', 'unknown', 2), sess('s5', 'd4', 'qa', null), sess('s6', 'd4', 'worker', 1),
  ]
  const all = new Set(items.map(i => i.subtaskId))
  const o = buildObserved({ items, sessions, historyKnown: all, abandoned: new Set(), filters: { fromMs: 0, toMs: 20 * DAY }, escaped: new Set(['d2']) })

  test('never carries a verdict, and says it is biased', () => {
    expect('verdict' in o).toBe(false)
    expect(JSON.stringify(o)).not.toMatch(/"verdict"/)
    expect(o.label).toBe('observed-biased')
  })

  test('coordination share is a range, not a point', () => {
    expect(o.metrics.coordinationShare.value).toBeNull()
    expect(o.coordinationShareRange.lo).toBeCloseTo(2 / 16, 10)
    expect(o.coordinationShareRange.hi).toBeCloseTo(4 / 16, 10)
    expect(o.roleUnknownSessions).toBe(1)
    expect(o.metrics.coordinationShare.interval).toMatchObject({ method: 'range' })
  })

  test('missing is missing: an unpriced session leaves its delivery out and is named', () => {
    const c = o.metrics.costPerDelivery
    expect(c.missing).toEqual(['d4'])
    expect([c.n, c.total]).toEqual([2, 4])
    expect(c.value).toBeCloseTo((8 + 7) / 2, 10)
    expect(c.gaps).toEqual([{ code: 'no_sessions', count: 1 }, { code: 'no_tokens', count: 1 }])
    expect(c.interval).not.toBeNull()
    expect(o.coverage.claude).toMatchObject({ sessions: 6, withCost: 5, withRole: 5, withLink: 6 })
  })

  test('a delivery with no session at all is a gap, never a zero cost', () => {
    const c = buildObserved({ items, sessions: sessions.filter(s => s.subtaskId !== 'd4'), historyKnown: all }).metrics.costPerDelivery
    expect(c.gaps).toContainEqual({ code: 'no_sessions', count: 2 })
    expect([c.n, c.total]).toEqual([2, 4])
  })

  test('QA rate, rounds, escape and waste', () => {
    expect(o.metrics.qaFirstRoundRejection.value).toBeCloseTo(2 / 3, 10)
    expect(o.metrics.qaFirstRoundRejection.interval).toMatchObject({ method: 'wilson' })
    expect(o.metrics.qaRoundsMedian.value).toBe(2)
    expect(o.metrics.escapedDefectRate.value).toBeCloseTo(1 / 3, 10)
    expect(o.metrics.wastedCostShare.value).toBeCloseTo(5 / 16, 10)
  })

  test('escape links that are not recorded give null, not 0; unstructured items are counted', () => {
    const n = buildObserved({ items, sessions, historyKnown: all })
    expect(n.metrics.escapedDefectRate.value).toBeNull()
    expect(n.metrics.escapedDefectRate.gaps).toContainEqual({ code: 'escape_links_not_recorded', count: 3 })
    expect(n.notStructured).toEqual({ qaVerdict: 4, escapedLink: 4 })
    const st = buildObserved({ items, sessions, historyKnown: all, structured: { qaVerdict: new Set(['d1', 'd2']), escapedLink: new Set() } })
    expect(st.notStructured).toEqual({ qaVerdict: 2, escapedLink: 4 })
  })

  test('an unconfirmed harness is not measured with a reason, never zero or estimated', () => {
    const r = buildObserved({ items, sessions: [...sessions, sess('x', 'd1', 'worker', null, { harness: 'codex' })], historyKnown: all })
    expect(r.coverage.codex).toMatchObject({ sessions: 1, withCost: 0, status: 'not measured', reason: 'confirmed cost/tokens for 0 of 1 sessions' })
  })

  test('empty input yields nulls, never zeros', () => {
    const e = buildObserved({ items: [], sessions: [], historyKnown: new Set() })
    expect(e.deliveries).toBe(0)
    for (const m of Object.values(e.metrics)) expect(m.value).toBeNull()
    expect(e.coordinationShareRange).toEqual({ lo: null, hi: null })
  })
})

describe('buildObserved — a delivery whose phase history was never recorded', () => {
  const items = [
    item('h1', { stageMs: stage(2 * 3600_000), qaResult: 'first_pass' }),
    item('h2', { stageMs: stage(4 * 3600_000), qaResult: 'rejected_once', qaRejections: 1 }),
    // no history: buildMetricItems gives these an all-zero stage record and `pending` QA. Neither is a measurement.
    item('n1', { stageMs: stage(0), qaResult: 'pending' }), item('n2', { stageMs: stage(0), qaResult: 'pending' }),
  ]
  const o = buildObserved({ items, sessions: [], historyKnown: new Set(['h1', 'h2']) })

  test('active time is the median over deliveries WITH history only — the others are a named gap, not zeros', () => {
    expect(o.metrics.activeMedian.value).toBe(3 * 3600_000)
    expect([o.metrics.activeMedian.n, o.metrics.activeMedian.total]).toEqual([2, 4])
    expect(o.metrics.activeMedian.gaps).toContainEqual({ code: 'no_phase_history', count: 2 })
    expect(o.scope.withPhaseHistory).toBe(2)
  })

  test('a history showing no time in a working stage is a gap (no_active_stage), never a zero', () => {
    const z = buildObserved({ items: [item('z1', { stageMs: stage(0) }), item('z2', { stageMs: stage(0) }), item('z3', { stageMs: stage(3600_000) })], sessions: [], historyKnown: new Set(['z1', 'z2', 'z3']) })
    expect(z.metrics.activeMedian.value).toBe(3600_000)
    expect([z.metrics.activeMedian.n, z.metrics.activeMedian.total]).toEqual([1, 3])
    expect(z.metrics.activeMedian.gaps).toContainEqual({ code: 'no_active_stage', count: 2 })
    const none = buildObserved({ items: [item('z1', { stageMs: stage(0) })], sessions: [], historyKnown: new Set(['z1']) })
    expect(none.metrics.activeMedian.value).toBeNull()
  })

  test('with no history at all the figure is null with the reason', () => {
    const none = buildObserved({ items, sessions: [], historyKnown: new Set() })
    expect(none.metrics.activeMedian.value).toBeNull()
    expect(none.metrics.activeMedian.gaps).toContainEqual({ code: 'no_phase_history', count: 4 })
  })

  test('QA figures need a recorded QA stage: first_pass / rejected only count when history exists', () => {
    expect(o.metrics.qaFirstRoundRejection.value).toBe(0.5)
    expect(o.metrics.qaFirstRoundRejection.n).toBe(2)
    const none = buildObserved({ items: [item('x', { qaResult: 'pending' })], sessions: [], historyKnown: new Set(['x']) })
    expect(none.metrics.qaFirstRoundRejection.value).toBeNull()
    expect(none.metrics.qaFirstRoundRejection.gaps).toContainEqual({ code: 'no_qa_stage', count: 1 })
    expect(none.metrics.qaRoundsMedian.value).toBeNull()
  })
})

describe('buildObserved — a coordination range that says nothing is withheld', () => {
  test('mostly role-unknown cost gives no range', () => {
    const items = [item('r1')]
    const sessions = [sess('a', 'r1', 'leader', 1), sess('b', 'r1', 'unknown', 9)]
    const o = buildObserved({ items, sessions, historyKnown: new Set(), abandoned: new Set() })
    expect(o.coordinationShareRange).toEqual({ lo: null, hi: null })
    expect(o.metrics.coordinationShare.interval).toBeNull()
    expect(o.metrics.coordinationShare.gaps).toContainEqual({ code: 'role_range_too_wide', count: 1 })
  })
})

describe('buildObserved — abandoned work is not a delivery but its sessions are wasted cost', () => {
  const items = [item('ok1'), item('ab1', { publishedAtMs: null, leadMs: null, stage: 'queue' })]
  const sessions = [sess('s1', 'ok1', 'worker', 6), sess('s2', 'ab1', 'worker', 4)]
  const o = buildObserved({ items, sessions, historyKnown: new Set(['ok1']), abandoned: new Set(['ab1']) })

  test('deliveries excludes it; wasted share is its cost over all cost', () => {
    expect(o.deliveries).toBe(1)
    expect(o.scope.abandonedWithSessions).toBe(1)
    expect(o.metrics.wastedCostShare.value).toBeCloseTo(4 / 10, 10)
    expect(o.metrics.costPerDelivery.value).toBe(6)
  })

  test('when nobody says which work was abandoned the share is null with the reason, never 0', () => {
    const n = buildObserved({ items: [item('ok1')], sessions: [sess('s1', 'ok1', 'worker', 6)], historyKnown: new Set(['ok1']) })
    expect(n.metrics.wastedCostShare.value).toBeNull()
    expect(n.metrics.wastedCostShare.gaps).toContainEqual({ code: 'waste_not_tracked', count: 1 })
  })
  test('when abandoned work is known and none had cost, the share is a measured 0 with an interval', () => {
    const z = buildObserved({ items: [item('ok1')], sessions: [sess('s1', 'ok1', 'worker', 6)], historyKnown: new Set(['ok1']), abandoned: new Set() })
    expect(z.metrics.wastedCostShare.value).toBe(0)
  })
})

describe('buildObserved — throughput and lead time carry intervals', () => {
  test('throughput per week has a Poisson score interval that brackets it', () => {
    const items = [item('a', { refMs: 0 }), item('b', { refMs: 14 * DAY }), item('c', { refMs: 7 * DAY })]
    const o = buildObserved({ items, sessions: [], historyKnown: new Set() })
    expect(o.metrics.throughputPerWeek.value).toBeCloseTo(3 / 2, 10)
    const i = o.metrics.throughputPerWeek.interval!
    expect(i.method).toBe('poisson-score')
    expect(i.lo).toBeLessThan(1.5)
    expect(i.hi).toBeGreaterThan(1.5)
  })
  test('lead median has a bootstrap interval from the same values', () => {
    const items = [1, 2, 3, 4, 5].map(n => item(`l${n}`, { leadMs: n * DAY }))
    const o = buildObserved({ items, sessions: [], historyKnown: new Set() })
    expect(o.metrics.wallMedian.value).toBe(3 * DAY)
    expect(o.metrics.wallMedian.interval!.lo).toBeLessThanOrEqual(3 * DAY)
    expect(o.metrics.wallMedian.interval!.hi).toBeGreaterThanOrEqual(3 * DAY)
  })
})
