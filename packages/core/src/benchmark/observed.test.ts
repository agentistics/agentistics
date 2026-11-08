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
  const o = buildObserved({ items, sessions, filters: { fromMs: 0, toMs: 20 * DAY }, escaped: new Set(['d2']) })

  test('never carries a verdict, and says it is biased', () => {
    expect('verdict' in o).toBe(false)
    expect(JSON.stringify(o)).not.toMatch(/"verdict"/)
    expect(o.label).toBe('observed-biased')
  })

  test('coordination share is a range, not a point', () => {
    expect(o.metrics.coordinationShare.value).toBeNull()
    expect(o.coordinationShareRange.lo).toBeCloseTo(2 / 16, 10)
    expect(o.coordinationShareRange.hi).toBeCloseTo(4 / 16, 10)
  })

  test('missing is missing: an unpriced session leaves its delivery out and is named', () => {
    const c = o.metrics.costPerDelivery
    expect(c.missing).toEqual(['d4'])
    expect([c.n, c.total]).toEqual([2, 3])
    expect(c.value).toBeCloseTo((8 + 7) / 2, 10)
    expect(o.coverage.claude).toMatchObject({ sessions: 6, withCost: 5, withRole: 5, withLink: 6 })
  })

  test('QA rate, rounds, escape and waste', () => {
    expect(o.metrics.qaFirstRoundRejection.value).toBeCloseTo(2 / 3, 10)
    expect(o.metrics.qaRoundsMedian.value).toBe(2)
    expect(o.metrics.escapedDefectRate.value).toBeCloseTo(1 / 3, 10)
    expect(o.metrics.wastedCostShare.value).toBeCloseTo(5 / 16, 10)
  })

  test('escape links that are not recorded give null, not 0; unstructured items are counted', () => {
    const n = buildObserved({ items, sessions })
    expect(n.metrics.escapedDefectRate.value).toBeNull()
    expect(n.notStructured).toEqual({ qaVerdict: 4, escapedLink: 4 })
    const st = buildObserved({ items, sessions, structured: { qaVerdict: new Set(['d1', 'd2']), escapedLink: new Set() } })
    expect(st.notStructured).toEqual({ qaVerdict: 2, escapedLink: 4 })
  })

  test('a harness with no priced session is listed with zero cost coverage, not dropped', () => {
    const r = buildObserved({ items, sessions: [...sessions, sess('x', 'd1', 'worker', null, { harness: 'codex' })] })
    expect(r.coverage.codex).toMatchObject({ sessions: 1, withCost: 0 })
  })

  test('empty input yields nulls, never zeros', () => {
    const e = buildObserved({ items: [], sessions: [] })
    expect(e.deliveries).toBe(0)
    for (const m of Object.values(e.metrics)) expect(m.value).toBeNull()
    expect(e.coordinationShareRange).toEqual({ lo: null, hi: null })
  })
})
