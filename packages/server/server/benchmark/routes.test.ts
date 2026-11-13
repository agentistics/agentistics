import { describe, expect, test } from 'bun:test'
import type { MetricFilters, MetricItem, TimeBucket } from '@agentistics/core'
import { calcCost } from '@agentistics/core'
import { buildObserved, type Observed, type ObservedSession } from '@agentistics/core/benchmark'
import { buildObservedFromSources, handleBenchmarkRequest, type BenchmarkSources } from './routes'

describe('benchmark HTTP read routes', () => {
  const observed = { label: 'observed-biased' as const, deliveries: 1 } as never
  const deps = { observed: async () => observed, experiments: () => [] as [] }

  test('returns the observed contract without inventing experiments', async () => {
    const out = await handleBenchmarkRequest(new Request('http://localhost/api/benchmark/observed'), new URL('http://localhost/api/benchmark/observed'), deps)
    expect(out.status).toBe(200)
    expect(await out.json()).toEqual(observed)
  })

  test('returns an empty experiment list', async () => {
    const out = await handleBenchmarkRequest(new Request('http://localhost/api/benchmark/experiments'), new URL('http://localhost/api/benchmark/experiments'), deps)
    expect(out.status).toBe(200)
    expect(await out.json()).toEqual([])
  })

  test('with the default dependencies the experiment list is empty — nothing is invented', async () => {
    const url = new URL('http://localhost/api/benchmark/experiments')
    const out = await handleBenchmarkRequest(new Request(url), url)
    expect(await out.json()).toEqual([])
  })

  test('does not accept writes in the read-only slice', async () => {
    const out = await handleBenchmarkRequest(new Request('http://localhost/api/benchmark/observed', { method: 'POST' }), new URL('http://localhost/api/benchmark/observed'), deps)
    expect(out.status).toBe(405)
  })
})

// ------------------------------------------------------------------------------- the live read model, over a synthetic store

const H = 3600_000
const T0 = Date.parse('2026-11-01T00:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 500_000 }
const sonnetCost = calcCost({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 2_000_000, cacheCreationInputTokens: 500_000, webSearchRequests: 0, costUSD: 0 }, 'claude-sonnet-5')
const meta = (session_id: string, o: Record<string, unknown> = {}) => ({ session_id, harness: 'claude', model: 'claude-sonnet-5', ...usage, ...o })
const row = (id: string, subtaskId: string | undefined, o: Record<string, unknown> = {}) => ({
  id, harness: 'claude', cwd: '/x', createdAt: iso(T0), ...(subtaskId ? { subtaskId, taskId: 'T1' } : {}), ...o,
})
const sub = (id: string, status: string, o: Record<string, unknown> = {}) => ({ id, taskId: 'T1', title: id, status, createdAt: iso(T0), ...o })
const mv = (from: string, to: string, atMs: number) => ({ from, to, at: iso(atMs), actor: 'x', detail: '', revision: 1 })

function sources(): BenchmarkSources {
  return {
    nowMs: T0 + 30 * 24 * H,
    book: {
      tasks: [{ id: 'T1', title: 'Task one' }],
      subtasks: [
        sub('A', 'done', { deliveredAt: iso(T0 + 10 * H) }),        // delivery record + priced claude session + a leader
        sub('B', 'done', { deliveredAt: iso(T0 + 20 * H) }),        // board only (no phase history); codex session, model has no price
        sub('C', 'abandoned'),                                       // abandoned: its session is wasted cost
        sub('D', 'todo'),                                            // never started: not a delivery
        sub('E', 'ideias_adiado'),                                   // deferred idea: not a delivery
        sub('F', 'done', { deliveredAt: iso(T0 + 30 * H) }),        // board only; session whose tokens are all zero
      ],
      historicalSessions: [{ conversationId: 'c-hist', harness: 'claude', subtaskId: 'A', linkedAt: iso(T0 + H) }],
    },
    registry: [
      row('m-lead', 'A', { conversationId: 'c-lead', leader: true }),
      row('m-work', 'A', { conversationId: 'c-work', model: 'claude-sonnet-5' }),
      row('m-codex', 'B', { harness: 'codex', conversationId: 'c-codex' }),
      row('m-aband', 'C', { conversationId: 'c-aband' }),
      row('m-zero', 'F', { conversationId: 'c-zero' }),
      row('m-nolink', 'F'),                                          // no conversation id: nothing to read tokens from
      row('m-nosub', undefined, { conversationId: 'c-nosub' }),      // filed under no subtask: ignored
    ] as never,
    metas: new Map([
      ['c-lead', meta('c-lead')],                                    // model only on the meta (fallback)
      ['c-work', meta('c-work')],
      ['c-hist', meta('c-hist')],
      ['c-codex', meta('c-codex', { harness: 'codex', model: 'no-such-model-xyz' })],
      ['c-aband', meta('c-aband')],
      ['c-zero', meta('c-zero', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })],
      ['c-nosub', meta('c-nosub')],
      // a meta keyed by a MANAGED id must never be joined to that row
      ['m-lead', meta('m-lead', { input_tokens: 9, output_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 })],
    ]) as never,
    deliveries: {
      A: { subtaskId: 'A', taskId: 'T1', phase: 'publicado', revision: 3, createdAt: iso(T0),
        leaderSessionId: 'm-lead', authorSessionId: 'm-work',
        history: [mv('fila', 'executando', T0 + 1 * H), mv('executando', 'ci', T0 + 7 * H), mv('ci', 'publicado', T0 + 10 * H)] },
    } as never,
  }
}

describe('live read model over a synthetic store', () => {
  const o = buildObservedFromSources(sources())
  const byHarness = (h: string) => o.coverage[h]!

  test('F1: sessions join the token store by CONVERSATION id (a managed-id meta is never used), model falls back to the meta', () => {
    // A holds c-lead (meta model fallback), c-work and the historical c-hist: three priced sessions
    expect(byHarness('claude')).toMatchObject({ withCost: 4, withTokens: 4 })
    expect(o.metrics.costPerDelivery.value).toBeCloseTo(3 * sonnetCost, 6)
  })

  test('cost per delivery is the mean over deliveries whose every session is priced', () => {
    const c = o.metrics.costPerDelivery
    expect(c.n).toBe(1)                // only A is fully priced
    expect(c.total).toBe(3)            // A, B, F are the deliveries in scope
    expect(c.gaps).toContainEqual({ code: 'no_price', count: 1 })    // B: codex model has no price row
    expect(c.gaps).toContainEqual({ code: 'no_tokens', count: 1 })   // F: all-zero tokens + a session with no conversation link
  })

  test('a harness whose model has no price is NOT MEASURED, never 0 and never estimated', () => {
    expect(byHarness('codex')).toMatchObject({ sessions: 1, withCost: 0, status: 'not measured' })
    expect(byHarness('codex').reason).toContain('0 of 1')
  })

  test('all-zero tokens are not a usage record', () => {
    expect(byHarness('claude').sessions).toBe(6)        // c-lead, c-work, c-hist, c-aband, c-zero, m-nolink
    expect(byHarness('claude').withTokens).toBe(4)
  })

  test('sessions with no subtask are not in the numbers', () => {
    expect(JSON.stringify(o)).not.toContain('c-nosub')
    expect(byHarness('claude').sessions).toBe(6)
  })

  test('F12: roles come from the delivery record; the rest is "unknown" and said so', () => {
    expect(o.roleUnknownSessions).toBeGreaterThan(0)
    const r = o.coordinationShareRange
    expect(r.lo).toBeCloseTo(sonnetCost / (4 * sonnetCost), 6)       // 1 leader of 4 priced (A:3 + aband:1)
    expect(r.hi!).toBeGreaterThan(r.lo!)
  })

  test('scope: only real deliveries; abandoned work feeds wasted cost only', () => {
    expect(o.deliveries).toBe(3)
    expect(o.scope).toMatchObject({ published: 3, open: 0, withPhaseHistory: 1, abandonedWithSessions: 1 })
    expect(o.metrics.wastedCostShare.value).toBeCloseTo(sonnetCost / (4 * sonnetCost), 6)
  })

  test('F2: active time is read from the delivery record history, never 0 for the rest', () => {
    const a = o.metrics.activeMedian
    expect(a.value).toBe(9 * H)                                       // executando 6h + ci 3h
    expect(a.n).toBe(1)
    expect(a.gaps).toContainEqual({ code: 'no_phase_history', count: 2 })
  })

  test('F2: QA is not measured when the history never shows a QA stage', () => {
    const q = o.metrics.qaFirstRoundRejection
    expect(q.value).toBeNull()
    expect(q.gaps).toContainEqual({ code: 'no_qa_stage', count: 1 })
    expect(q.gaps).toContainEqual({ code: 'no_phase_history', count: 2 })
  })

  test('lead time uses the record start for A and the subtask creation for board-only deliveries', () => {
    expect(o.metrics.wallMedian.value).toBe(20 * H)                   // 10h, 20h, 30h
    expect(o.metrics.wallMedian.n).toBe(3)
  })

  test('a QA round recorded in the history is read (qa → ajuste is a rejection)', () => {
    const s = sources()
    ;(s.deliveries as Record<string, unknown>).A = { ...(s.deliveries as never as Record<string, Record<string, unknown>>).A!,
      history: [mv('fila', 'executando', T0 + H), mv('executando', 'qa', T0 + 3 * H), mv('qa', 'ajuste', T0 + 4 * H), mv('ajuste', 'qa', T0 + 5 * H), mv('qa', 'ci', T0 + 6 * H), mv('ci', 'publicado', T0 + 10 * H)] }
    const q = buildObservedFromSources(s).metrics
    expect(q.qaFirstRoundRejection.value).toBe(1)
    expect(q.qaFirstRoundRejection.n).toBe(1)
    expect(q.qaRoundsMedian.value).toBe(2)
  })

  test('the period filter reaches the read model', () => {
    const f = buildObservedFromSources(sources(), { fromMs: T0 + 15 * H })
    expect(f.deliveries).toBe(2)
  })

  test('over HTTP the same figures are served', async () => {
    const url = new URL('http://localhost/api/benchmark/observed')
    const res = await handleBenchmarkRequest(new Request(url), url, { observed: async f => buildObservedFromSources(sources(), f), experiments: () => [] })
    const body = await res.json() as Observed
    expect(body.metrics.activeMedian.value).toBe(9 * H)
    expect(body.coverage.codex!.status).toBe('not measured')
  })
})

// ------------------------------------------------------------------------------- the figures are recomputable from records

const DAY = 24 * 3600 * 1000
const stage = (running: number): Record<TimeBucket, number> => ({ queue: 0, running, qa: 0, adjust: 0, leader: 0, merge: 0, ci: 0, blocked: 0 })
const item = (id: string, publishedAtMs: number, leadMs: number, qaResult: MetricItem['qaResult'], qaRejections: number): MetricItem => ({
  subtaskId: id, taskId: 'task-fixture', taskTitle: 'Fixture task', title: id, priority: null, version: null, stage: 'published', harness: 'claude', authorModel: null,
  startMs: 0, startBasis: 'queue', publishedAtMs, refMs: publishedAtMs, leadMs, stageMs: stage(leadMs), qaResult, qaRejections, adjustRounds: 0, blocks: [], costUSD: null, tokens: null, eta: null, hasEta: false, queueMs: 0,
})
const fixtureItems = [item('d1', 10 * DAY, 10, 'first_pass', 0), item('d2', 20 * DAY, 20, 'rejected_once', 1)]
const priced = (costUSD: number) => ({ costUSD, basis: 'table×tokens' as const, priceTable: 'fixture' })
const fixtureSessions: ObservedSession[] = [
  { id: 's1', subtaskId: 'd1', harness: 'claude', role: 'leader', cost: priced(1) },
  { id: 's2', subtaskId: 'd1', harness: 'claude', role: 'worker', cost: priced(3) },
  { id: 's3', subtaskId: 'd2', harness: 'claude', role: 'leader', cost: priced(2) },
  { id: 's4', subtaskId: 'd2', harness: 'claude', role: 'worker', cost: priced(4), wasted: true },
]
const fixtureObserved = (filters: MetricFilters = { fromMs: DAY, toMs: 30 * DAY }) => buildObserved({
  items: fixtureItems, sessions: fixtureSessions, historyKnown: new Set(['d1', 'd2']), abandoned: new Set(), filters, escaped: new Set(['d2']),
})
async function fixtureRoute(): Promise<Observed> {
  const url = new URL('http://localhost/api/benchmark/observed?from=86400000&to=2592000000')
  const response = await handleBenchmarkRequest(new Request(url), url, { observed: async filters => fixtureObserved(filters), experiments: () => [] })
  return await response.json() as Observed
}

describe('benchmark HTTP figures are recomputable from fixture records', () => {
  test('cost per delivery recomputes Σ session cost / deliveries', async () => {
    const o = await fixtureRoute(); expect(o.metrics.costPerDelivery.value).toBe((4 + 6) / 2); expect(o.metrics.costPerDelivery.origin.formula).toContain('Σ session cost')
  })
  test('wall median recomputes median lead time', async () => {
    const o = await fixtureRoute(); expect(o.metrics.wallMedian.value).toBe(15); expect(o.metrics.wallMedian.origin.n).toBe(2)
  })
  test('active median recomputes median active stage time', async () => {
    const o = await fixtureRoute(); expect(o.metrics.activeMedian.value).toBe(15); expect(o.metrics.activeMedian.origin.coverage).toContain('2 of 2')
  })
  test('coordination figure remains a range when role records are known', async () => {
    const o = await fixtureRoute(); expect(o.coordinationShareRange).toEqual({ lo: 3 / 10, hi: 3 / 10 }); expect(o.metrics.coordinationShare.value).toBeNull()
  })
  test('QA rejection rate recomputes rejected deliveries / decided deliveries', async () => {
    const o = await fixtureRoute(); expect(o.metrics.qaFirstRoundRejection.value).toBe(0.5)
  })
  test('QA rounds recompute median rejections plus one', async () => {
    const o = await fixtureRoute(); expect(o.metrics.qaRoundsMedian.value).toBe(1.5)
  })
  test('escaped defect rate recomputes linked escaped deliveries / published deliveries', async () => {
    const o = await fixtureRoute(); expect(o.metrics.escapedDefectRate.value).toBe(0.5)
  })
  test('wasted cost share recomputes wasted session cost / total session cost', async () => {
    const o = await fixtureRoute(); expect(o.metrics.wastedCostShare.value).toBe(4 / 10)
  })
  test('throughput recomputes published deliveries / filtered weeks', async () => {
    const o = await fixtureRoute(); expect(o.metrics.throughputPerWeek.value).toBeCloseTo(2 / (29 / 7), 10)
  })
})

// ------------------------------------------------------------------------------- r3: the QA r2 blockers

/** A one-subtask store: a delivery record `rec` and the registry rows given. */
function mini(subs: Record<string, unknown>[], deliveries: Record<string, unknown>, registry: unknown[] = [], metas: [string, unknown][] = []): BenchmarkSources {
  return {
    nowMs: T0 + 30 * 24 * H,
    book: { tasks: [{ id: 'T1', title: 'Task one' }], subtasks: subs as never, historicalSessions: [] },
    registry: registry as never,
    metas: new Map(metas) as never,
    deliveries: deliveries as never,
  }
}
const ADOPTED = 'adotada: a subtarefa já estava em executando no quadro quando o fluxo a recebeu'
const rec = (subtaskId: string, createdAt: number, history: ReturnType<typeof mv>[], detail0 = '') => ({
  subtaskId, taskId: 'T1', phase: 'publicado', revision: 1, createdAt: iso(createdAt),
  history: history.map((m, k) => (k === 0 && detail0 ? { ...m, detail: detail0 } : m)),
})

describe('B4: the cache-write TTL split reaches the price', () => {
  test('a session with 1 h cache writes costs what calcCost says with the split', () => {
    const u = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 1_000_000, cacheCreation1hInputTokens: 1_000_000, cacheCreation5mInputTokens: 0, webSearchRequests: 0, costUSD: 0 }
    const withSplit = calcCost(u, 'claude-sonnet-5')
    const flat = calcCost({ ...u, cacheCreation1hInputTokens: undefined, cacheCreation5mInputTokens: undefined }, 'claude-sonnet-5')
    expect(withSplit).toBeGreaterThan(flat)
    const s = mini([sub('A', 'done', { deliveredAt: iso(T0 + H) })], { A: rec('A', T0, [mv('fila', 'executando', T0), mv('executando', 'publicado', T0 + H)]) },
      [row('m1', 'A', { conversationId: 'c1' })],
      [['c1', meta('c1', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation_1h_input_tokens: 1_000_000, cache_creation_5m_input_tokens: 0 })]])
    expect(buildObservedFromSources(s).metrics.costPerDelivery.value).toBeCloseTo(withSplit, 8)
  })
})

describe('B2: time to publish starts at the request for an adopted record', () => {
  const s = mini(
    [sub('G', 'done', { deliveredAt: iso(T0 + 60 * H) }), sub('N', 'done', { createdAt: iso(T0), deliveredAt: iso(T0 + 15 * H) })],
    {
      G: rec('G', T0 + 50 * H, [mv('executando', 'ci', T0 + 55 * H), mv('ci', 'publicado', T0 + 60 * H)], ADOPTED),
      N: rec('N', T0 + 5 * H, [mv('fila', 'executando', T0 + 5 * H), mv('executando', 'ci', T0 + 12 * H), mv('ci', 'publicado', T0 + 15 * H)], 'sessão x aberta pelo pré-dispatch'),
    },
  )
  const o = buildObservedFromSources(s)
  test('adopted: from the subtask creation (60 h), born in the flow: from the record (10 h)', () => {
    // sorted lead times: 10 h (N) and 60 h (G) -> median 35 h
    expect(o.metrics.wallMedian.n).toBe(2)
    expect(o.metrics.wallMedian.value).toBe(35 * H)
  })
  test('the formula text states which start is used', () => {
    expect(o.metrics.wallMedian.formula).toMatch(/adopted/i)
    expect(o.metrics.wallMedian.formula).toMatch(/subtask creation|request/i)
  })
  test('how many records used the request start is reported', () => {
    expect(o.metrics.wallMedian.gaps).toEqual([])
    expect(o.metrics.wallMedian.origin.coverage).toContain('1 adopted')
  })
})

describe('B3: active time counts only complete histories', () => {
  const s = mini(
    [sub('G', 'done', { deliveredAt: iso(T0 + 60 * H) }), sub('N', 'done', { deliveredAt: iso(T0 + 15 * H) })],
    {
      G: rec('G', T0 + 50 * H, [mv('executando', 'ci', T0 + 55 * H), mv('ci', 'publicado', T0 + 60 * H)], ADOPTED),
      N: rec('N', T0 + 5 * H, [mv('fila', 'executando', T0 + 5 * H), mv('executando', 'ci', T0 + 12 * H), mv('ci', 'publicado', T0 + 15 * H)], 'sessão x aberta pelo pré-dispatch'),
    },
  )
  const a = buildObservedFromSources(s).metrics.activeMedian
  test('the adopted record is a NAMED gap, never a truncated number', () => {
    expect(a.n).toBe(1)
    expect(a.value).toBe(10 * H)                    // N alone: executando 7 h + ci 3 h
    expect(a.gaps).toContainEqual({ code: 'incomplete_history', count: 1 })
  })
  test('with only adopted records the figure is not measured', () => {
    const only = buildObservedFromSources(mini([sub('G', 'done', { deliveredAt: iso(T0 + 60 * H) })],
      { G: rec('G', T0 + 50 * H, [mv('executando', 'ci', T0 + 55 * H), mv('ci', 'publicado', T0 + 60 * H)], ADOPTED) })).metrics.activeMedian
    expect(only.value).toBeNull()
    expect(only.n).toBe(0)
    expect(only.gaps).toContainEqual({ code: 'incomplete_history', count: 1 })
  })
})

describe('F16: a conversation belongs to the subtask of its NEWEST filing statement', () => {
  const subs = [sub('A', 'done', { deliveredAt: iso(T0 + H) }), sub('B', 'done', { deliveredAt: iso(T0 + H) })]
  const recs = { A: rec('A', T0, [mv('fila', 'executando', T0), mv('executando', 'publicado', T0 + H)]), B: rec('B', T0, [mv('fila', 'executando', T0), mv('executando', 'publicado', T0 + H)]) }
  const metas: [string, unknown][] = [['c1', meta('c1')]]
  const filedOn = (o: ReturnType<typeof buildObservedFromSources>) => o.metrics.costPerDelivery

  test('filed twice: the newest wins, whatever the order of the rows', () => {
    const older = row('m-old', 'A', { conversationId: 'c1', createdAt: iso(T0) })
    const newer = row('m-new', 'B', { conversationId: 'c1', createdAt: iso(T0 + 2 * H) })
    for (const registry of [[older, newer], [newer, older]]) {
      const c = filedOn(buildObservedFromSources(mini(subs, recs, registry, metas)))
      expect(c.n).toBe(1)
      expect(c.missing).toEqual([])
      expect(c.gaps).toContainEqual({ code: 'no_sessions', count: 1 })
      expect(c.value).toBeCloseTo(sonnetCost, 8)
      // and it is B, not A, that holds the session
      const onlyB = buildObservedFromSources(mini([subs[1]!], { B: recs.B }, registry, metas))
      expect(onlyB.metrics.costPerDelivery.n).toBe(1)
      const onlyA = buildObservedFromSources(mini([subs[0]!], { A: recs.A }, registry, metas))
      expect(onlyA.metrics.costPerDelivery.n).toBe(0)
    }
  })

  test('an explicit un-file (taskId "") later than the filing leaves the conversation in no delivery', () => {
    const filed = row('m-1', 'A', { conversationId: 'c1', createdAt: iso(T0) })
    const unfiled = { id: 'm-2', harness: 'claude', cwd: '/x', createdAt: iso(T0 + 2 * H), conversationId: 'c1', taskId: '' }
    for (const registry of [[filed, unfiled], [unfiled, filed]]) {
      const o = buildObservedFromSources(mini(subs, recs, registry, metas))
      expect(o.metrics.costPerDelivery.n).toBe(0)
      expect(o.metrics.costPerDelivery.gaps).toContainEqual({ code: 'no_sessions', count: 2 })
      expect(Object.keys(o.coverage)).toEqual([])
    }
  })

  test('an un-file OLDER than the filing does not undo it', () => {
    const unfiled = { id: 'm-2', harness: 'claude', cwd: '/x', createdAt: iso(T0), conversationId: 'c1', taskId: '' }
    const filed = row('m-1', 'A', { conversationId: 'c1', createdAt: iso(T0 + 2 * H) })
    const o = buildObservedFromSources(mini(subs, recs, [unfiled, filed], metas))
    expect(o.metrics.costPerDelivery.n).toBe(1)
  })
})
