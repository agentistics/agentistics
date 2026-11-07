import { describe, expect, test } from 'bun:test'
import {
  NONE_KEY, brtDayBounds, brtWeekStart, buildGroups, buildMetricItems, buildMetrics, computeMetrics, effectiveGroupBy, filterMetricItems, lifeSegments, percentile,
  type MetricInput, type MetricMove,
} from './deliveryMetrics'

const H = 3_600_000
const NOW = Date.parse('2026-11-07T15:00:00Z')
const T0 = Date.parse('2026-11-01T12:00:00Z')

const mv = (from: string, to: string, hours: number, detail = '', base = T0): MetricMove => ({ from, to, atMs: base + hours * H, detail })

/** A delivery that walked the whole line; `qaBack` sends it back once from QA. */
function shipped(id: string, o: Partial<MetricInput> & { base?: number; qaBack?: boolean } = {}): MetricInput {
  const base = o.base ?? T0
  const history: MetricMove[] = [
    mv('fila', 'executando', 2, '', base), mv('executando', 'qa', 14, '', base),
    ...(o.qaBack ? [mv('qa', 'ajuste', 20, '', base), mv('ajuste', 'qa', 23, '', base)] : []),
    mv('qa', 'revisao_lider', o.qaBack ? 25 : 21, '', base), mv('revisao_lider', 'pr_merge', o.qaBack ? 26 : 22, '', base),
    mv('pr_merge', 'ci', o.qaBack ? 27 : 23, '', base), mv('ci', 'publicado', o.qaBack ? 28 : 24, '', base),
  ]
  const end = history[history.length - 1]!.atMs
  return {
    subtaskId: id, taskId: 'T-' + id, taskTitle: 'Task ' + id, title: 'Piece ' + id, priority: 'high', version: '2.201.0', phase: 'publicado',
    createdAtMs: base, requestedAtMs: null, publishedAtMs: end, authorModel: 'claude-opus-5', qaModel: 'gpt', harness: 'claude',
    history, costUSD: 10, tokens: 1000, ...o,
  }
}

describe('lifeSegments / buildMetricItems', () => {
  test('each stage gets the time between the record moves; QA sent back once', () => {
    const [it] = buildMetricItems([shipped('a', { qaBack: true })], NOW)
    expect(it!.stageMs.queue).toBe(2 * H)
    expect(it!.stageMs.running).toBe(12 * H)
    expect(it!.stageMs.qa).toBe(6 * H + 2 * H)
    expect(it!.stageMs.adjust).toBe(3 * H)
    expect(it!.stageMs.leader).toBe(1 * H)
    expect(it!.stageMs.merge).toBe(1 * H)
    expect(it!.stageMs.ci).toBe(1 * H)
    expect(it!.leadMs).toBe(28 * H)
    expect(it!.qaRejections).toBe(1)
    expect(it!.adjustRounds).toBe(1)
    expect(it!.qaResult).toBe('rejected_once')
    expect(it!.stage).toBe('published')
  })

  test('a delivery QA approved at once is first_pass; one still in QA is pending', () => {
    const [ok] = buildMetricItems([shipped('a')], NOW)
    expect(ok!.qaResult).toBe('first_pass')
    const pending = buildMetricItems([{ ...shipped('b'), phase: 'qa', publishedAtMs: null, history: [mv('fila', 'executando', 1), mv('executando', 'qa', 5)] }], NOW)[0]!
    expect(pending.qaResult).toBe('pending')
    expect(pending.stage).toBe('qa')
    // the open stage runs to now
    expect(pending.stageMs.qa).toBe(NOW - (T0 + 5 * H))
    expect(pending.leadMs).toBeNull()
  })

  test('two or more rejections is rejected_many', () => {
    const base = shipped('a')
    const history = [mv('fila', 'executando', 1), mv('executando', 'qa', 3), mv('qa', 'ajuste', 4), mv('ajuste', 'qa', 5), mv('qa', 'ajuste', 6), mv('ajuste', 'qa', 7), mv('qa', 'revisao_lider', 8), mv('revisao_lider', 'publicado', 9)]
    const [it] = buildMetricItems([{ ...base, history, publishedAtMs: T0 + 9 * H }], NOW)
    expect(it!.qaResult).toBe('rejected_many')
    expect(it!.qaRejections).toBe(2)
  })

  test('a block is its own bucket, with the recorded reason, and an open block runs to now', () => {
    const i: MetricInput = {
      ...shipped('a'), phase: 'bloqueado', publishedAtMs: null,
      history: [mv('fila', 'executando', 1), mv('executando', 'bloqueado', 3, 'limite: conta sem janela'), mv('bloqueado', 'executando', 7), mv('executando', 'bloqueado', 9, 'dependencia: espera a outra')],
    }
    const [it] = buildMetricItems([i], NOW)
    expect(it!.stageMs.running).toBe(2 * H + 2 * H)
    expect(it!.blocks.map(b => [b.reason, b.open])).toEqual([['limite', false], ['dependencia', true]])
    expect(it!.blocks[0]!.ms).toBe(4 * H)
    expect(it!.blocks[1]!.ms).toBe(NOW - (T0 + 9 * H))
    expect(it!.stage).toBe('blocked')
  })

  test('a block detail with no recorded reason reads as unknown, never a made-up one', () => {
    const segs = lifeSegments({ ...shipped('a'), publishedAtMs: null, phase: 'bloqueado', history: [mv('fila', 'bloqueado', 1, 'sem motivo')] }, NOW)
    expect(segs.find(s => s.bucket === 'blocked')!.reason).toBe('unknown')
  })

  test('the owner request starts the clock earlier than the record, and the wait counts as queue', () => {
    const [it] = buildMetricItems([shipped('a', { requestedAtMs: T0 - 5 * H })], NOW)
    expect(it!.startBasis).toBe('owner')
    expect(it!.leadMs).toBe(24 * H + 5 * H)
    expect(it!.stageMs.queue).toBe(2 * H + 5 * H)
    const [q] = buildMetricItems([shipped('b', { requestedAtMs: T0 + 3 * H })], NOW)
    expect(q!.startBasis).toBe('queue') // a request after the record is not a request for it
    expect(q!.leadMs).toBe(24 * H)
  })

  test('a record with no history is in its current phase since it was created', () => {
    const [it] = buildMetricItems([{ ...shipped('a'), phase: 'executando', publishedAtMs: null, history: [] }], NOW)
    expect(it!.stageMs.running).toBe(NOW - T0)
  })
})

describe('computeMetrics', () => {
  test('percentile interpolates and is null for nothing', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25)
    expect(percentile([10, 20, 30, 40], 0.9)).toBeCloseTo(37, 5)
  })

  test('lead time, throughput and QA rate come only from what was measured', () => {
    const items = buildMetricItems([
      shipped('a'), shipped('b', { qaBack: true }), shipped('c', { qaBack: true }),
      { ...shipped('d'), phase: 'qa', publishedAtMs: null, history: [mv('fila', 'executando', 1), mv('executando', 'qa', 5)] },
    ], NOW)
    const m = computeMetrics(items)
    expect(m.n).toBe(4)
    expect(m.published).toBe(3)
    expect(m.leadP50Ms).toBe(28 * H)
    expect(m.qaN).toBe(3) // d is still in QA: no verdict yet, not counted as an approval
    expect(m.qaRejected).toBe(2)
    expect(m.qaRejectionRate).toBeCloseTo(2 / 3, 5)
    expect(m.adjustAvg).toBeCloseTo(2 / 3, 5)
  })

  test('the ETA hit rate scores only deliveries with a recorded prediction', () => {
    const made = T0
    const items = buildMetricItems([
      shipped('hit', { eta: { madeAtMs: made, predictedAtMs: made + 26 * H, confidence: 'high' } }),   // actual 24h vs 26h: within 25%
      shipped('miss', { eta: { madeAtMs: made, predictedAtMs: made + 10 * H, confidence: 'medium' } }), // actual 24h vs 10h
      shipped('none'),
    ], NOW)
    const m = computeMetrics(items)
    expect(m.etaN).toBe(2)
    expect(m.etaHits).toBe(1)
    expect(m.etaRate).toBe(0.5)
    expect(m.noEta).toBe(1)
    const none = computeMetrics(buildMetricItems([shipped('x')], NOW))
    expect(none.etaRate).toBeNull()
    expect(none.noEta).toBe(1)
  })

  test('cost is null when nothing was priced, and the per-delivery average ignores the unpriced', () => {
    const none = computeMetrics(buildMetricItems([shipped('a', { costUSD: null, tokens: null })], NOW))
    expect(none.costUSD).toBeNull()
    expect(none.costPerPublishedUSD).toBeNull()
    expect(none.tokens).toBeNull()
    const some = computeMetrics(buildMetricItems([shipped('a', { costUSD: 10 }), shipped('b', { costUSD: 30 }), shipped('c', { costUSD: null })], NOW))
    expect(some.costUSD).toBe(40)
    expect(some.costPerPublishedUSD).toBe(20)
    expect(some.costKnown).toBe(2)
  })

  test('an empty set has no invented numbers', () => {
    const m = computeMetrics([])
    expect(m.leadP50Ms).toBeNull()
    expect(m.qaRejectionRate).toBeNull()
    expect(m.etaRate).toBeNull()
    expect(m.costPerPublishedUSD).toBeNull()
    expect(m.adjustAvg).toBeNull()
    expect(m.published).toBe(0)
  })

  test('blocked counts', () => {
    const blockedNow: MetricInput = { ...shipped('a'), phase: 'bloqueado', publishedAtMs: null, history: [mv('fila', 'bloqueado', 1, 'limite: x')] }
    const m = computeMetrics(buildMetricItems([blockedNow, shipped('b')], NOW))
    expect(m.blockedNow).toBe(1)
    expect(m.blockedAny).toBe(1)
    expect(m.blockMs).toBe(NOW - (T0 + H))
  })
})

describe('filters', () => {
  const day = (n: number) => T0 + n * 24 * H
  const base = [
    shipped('a', { base: day(0), version: '2.200.0', authorModel: 'opus', harness: 'claude', priority: 'urgent' }),
    shipped('b', { base: day(2), version: '2.201.0', authorModel: 'sol', harness: 'codex', priority: 'low', qaBack: true }),
    shipped('c', { base: day(3), version: null, authorModel: null, harness: null, priority: null }),
    { ...shipped('d', { base: day(4), version: '2.201.0', authorModel: 'opus', harness: 'claude', priority: 'high' }), phase: 'ci', publishedAtMs: null, history: [mv('fila', 'executando', 1, '', day(4)), mv('executando', 'qa', 3, '', day(4)), mv('qa', 'revisao_lider', 4, '', day(4)), mv('revisao_lider', 'pr_merge', 5, '', day(4)), mv('pr_merge', 'ci', 6, '', day(4))] } as MetricInput,
  ]
  const items = buildMetricItems(base, NOW)
  const ids = (f: Parameters<typeof filterMetricItems>[1]) => filterMetricItems(items, f).map(i => i.subtaskId)

  test('version, harness, author model, priority, stage, QA result, task', () => {
    expect(ids({ versions: ['2.201.0'] })).toEqual(['b', 'd'])
    expect(ids({ versions: [NONE_KEY] })).toEqual(['c'])
    expect(ids({ harnesses: ['codex'] })).toEqual(['b'])
    expect(ids({ harnesses: [NONE_KEY, 'codex'] })).toEqual(['b', 'c'])
    expect(ids({ authorModels: ['opus'] })).toEqual(['a', 'd'])
    expect(ids({ priorities: ['urgent', 'low'] })).toEqual(['a', 'b'])
    expect(ids({ stages: ['ci'] })).toEqual(['d'])
    expect(ids({ stages: ['published'] })).toEqual(['a', 'b', 'c'])
    expect(ids({ qa: ['rejected_once'] })).toEqual(['b'])
    expect(ids({ qa: ['first_pass'] })).toEqual(['a', 'c', 'd'])
    expect(ids({ task: 'T-c' })).toEqual(['c'])
    expect(ids({ task: 'task b' })).toEqual(['b'])
  })

  test('the period is applied to the publication instant, or the request while the piece is open', () => {
    const f = { fromMs: day(2), toMs: day(3) + 23 * H }
    expect(ids(f)).toEqual(['b'])
    expect(ids({ fromMs: day(4), toMs: day(5) })).toEqual(['c', 'd'])
    expect(brtDayBounds('2026-11-02', '2026-11-03')).toEqual({ fromMs: Date.parse('2026-11-02T03:00:00Z'), toMs: Date.parse('2026-11-04T03:00:00Z') - 1 })
  })

  test('filters combine as AND', () => {
    expect(ids({ versions: ['2.201.0'], harnesses: ['claude'] })).toEqual(['d'])
  })
})

describe('groups, prior window and the reply', () => {
  test('day groups are continuous: a day with nothing is an empty bucket, not skipped', () => {
    const items = buildMetricItems([shipped('a', { base: Date.parse('2026-11-01T12:00:00Z') }), shipped('b', { base: Date.parse('2026-11-04T12:00:00Z') })], NOW)
    const groups = buildGroups(items, 'day', { fromMs: Date.parse('2026-11-02T03:00:00Z'), toMs: Date.parse('2026-11-07T03:00:00Z') })
    expect(groups.map(g => g.key)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'])
    expect(groups.find(g => g.key === '2026-11-02')!.metrics.published).toBe(1) // a: 11-01 12:00Z + 24h
    expect(groups.find(g => g.key === '2026-11-05')!.metrics.published).toBe(1)
    expect(groups.find(g => g.key === '2026-11-06')!.metrics.published).toBe(0)
    expect(groups.find(g => g.key === '2026-11-06')!.metrics.leadP50Ms).toBeNull()
  })

  test('week starts on Monday (BRT); version groups sort numerically; model groups by volume', () => {
    expect(brtWeekStart(Date.parse('2026-11-07T15:00:00Z'))).toBe('2026-11-02') // 7 Nov 2026 is a Saturday
    expect(brtWeekStart(Date.parse('2026-11-09T02:00:00Z'))).toBe('2026-11-02') // still Sunday night in BRT
    const items = buildMetricItems([
      shipped('a', { version: '2.9.0', authorModel: 'x' }), shipped('b', { version: '2.10.0', authorModel: 'y' }), shipped('c', { version: '2.10.0', authorModel: 'y' }), shipped('d', { version: null, authorModel: null }),
    ], NOW)
    const range = { fromMs: T0, toMs: NOW }
    expect(buildGroups(items, 'version', range).map(g => g.key)).toEqual(['2.9.0', '2.10.0', NONE_KEY])
    expect(buildGroups(items, 'model', range).map(g => g.key)).toEqual(['y', 'x', NONE_KEY])
  })

  test('a day axis too long falls back to weeks', () => {
    expect(effectiveGroupBy('day', 30)).toBe('day')
    expect(effectiveGroupBy('day', 400)).toBe('week')
    expect(effectiveGroupBy('model', 400)).toBe('model')
  })

  const set = buildMetricItems([
    shipped('a', { base: Date.parse('2026-10-20T12:00:00Z') }), shipped('b', { base: Date.parse('2026-10-22T12:00:00Z'), qaBack: true }),
    shipped('c', { base: Date.parse('2026-11-03T12:00:00Z') }), shipped('d', { base: Date.parse('2026-11-04T12:00:00Z'), qaBack: true, authorModel: 'sol' }),
  ], NOW)

  test('the prior window is the same length just before, and absent when the period is open or a version is chosen', () => {
    const f = { fromMs: Date.parse('2026-10-28T03:00:00Z'), toMs: Date.parse('2026-11-08T03:00:00Z') - 1 }
    const r = buildMetrics(set, f, NOW)
    expect(r.summary.published).toBe(2) // c and d shipped in the window
    expect(r.prior!.published).toBe(2) // a and b shipped in the 11 days before it
    expect(buildMetrics(set, {}, NOW).prior).toBeNull()
    expect(buildMetrics(set, { ...f, versions: ['2.201.0'] }, NOW).prior).toBeNull()
  })

  test('funnel, bottleneck and QA by author model are measured on the filtered set', () => {
    const r = buildMetrics(set, {}, NOW)
    expect(r.bottleneck!.stage).toBe('running')
    expect(r.bottleneck!.share).toBeGreaterThan(0.3)
    expect(r.funnel.find(f => f.stage === 'queue')!.reached).toBe(4)
    expect(r.funnel.find(f => f.stage === 'adjust')!.reached).toBe(2) // only the ones that went back
    const opus = r.qaByAuthor.find(a => a.model === 'claude-opus-5')!
    expect(opus.n).toBe(3)
    expect(opus.rejected).toBe(1)
    expect(r.qaByAuthor.find(a => a.model === 'sol')!.rate).toBe(1)
    expect(r.options.authorModels).toEqual(['claude-opus-5', 'sol'])
  })

  test('the rows are the deliveries behind the numbers, newest first, and carry the count', () => {
    const r = buildMetrics(set, { authorModels: ['claude-opus-5'] }, NOW)
    expect(r.rowsTotal).toBe(3)
    expect(r.rows.map(x => x.subtaskId)).toEqual(['c', 'b', 'a'])
    expect(r.rows[0]!.leadMs).toBe(24 * H)
  })

  test('cost slices ignore unpriced deliveries; blocks aggregate by reason', () => {
    const items = buildMetricItems([
      shipped('a', { costUSD: 10, harness: 'claude' }), shipped('b', { costUSD: 5, harness: 'codex' }), shipped('c', { costUSD: null, harness: 'codex' }),
      { ...shipped('d'), phase: 'bloqueado', publishedAtMs: null, history: [mv('fila', 'bloqueado', 1, 'limite: x'), mv('bloqueado', 'executando', 3), mv('executando', 'bloqueado', 4, 'limite: y')] },
    ], NOW)
    const r = buildMetrics(items, {}, NOW)
    expect(r.costByHarness.find(s => s.key === 'claude')!.costUSD).toBe(20) // a + d (both claude)
    expect(r.costByHarness.find(s => s.key === 'codex')!.deliveries).toBe(1)
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]!.reason).toBe('limite')
    expect(r.blocks[0]!.count).toBe(1)
  })

  test('with no data at all the reply says so', () => {
    const r = buildMetrics([], {}, NOW)
    expect(r.anyData).toBe(false)
    expect(r.rows).toEqual([])
    expect(r.bottleneck).toBeNull()
    expect(r.perWeek).toBeNull()
    expect(Number.isFinite(r.range.days)).toBe(true)
  })

  test('data exists but the filters leave nothing: anyData stays true', () => {
    const r = buildMetrics(set, { versions: ['9.9.9'] }, NOW)
    expect(r.anyData).toBe(true)
    expect(r.rowsTotal).toBe(0)
    expect(r.summary.leadP50Ms).toBeNull()
  })
})
