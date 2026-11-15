import { describe, expect, test } from 'bun:test'
import { AGENT_TOOL_POLICY } from '@agentistics/core'
import { benchmarkObservedTool } from './benchmark-tool'
import { buildObservedFromSources } from '../server/server/benchmark/routes'
import { handleBenchmarkRequest } from '../server/server/benchmark/routes'

const T0 = Date.parse('2026-11-01T00:00:00.000Z')
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()
const store = () => ({
  nowMs: T0 + 30 * 24 * H,
  book: { tasks: [{ id: 'T1', title: 't' }], subtasks: [{ id: 'A', taskId: 'T1', title: 'A', status: 'done', createdAt: iso(T0), deliveredAt: iso(T0 + 4 * H) }], historicalSessions: [] },
  registry: [{ id: 'm1', harness: 'claude', createdAt: iso(T0), conversationId: 'c1', subtaskId: 'A', taskId: 'T1', model: 'claude-sonnet-5' }],
  metas: new Map([['c1', { session_id: 'c1', harness: 'claude', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]]),
  deliveries: { A: { subtaskId: 'A', phase: 'publicado', createdAt: iso(T0), history: [{ from: 'fila', to: 'executando', at: iso(T0), detail: '' }, { from: 'executando', to: 'publicado', at: iso(T0 + 4 * H), detail: '' }] } },
}) as never

describe('agentistics_benchmark_observed', () => {
  test('is a read-only tool in the policy table, over the benchmark route', () => {
    const p = AGENT_TOOL_POLICY.agentistics_benchmark_observed
    expect(p.risk).toBe('R')
    expect(p.routes).toEqual(['GET /api/benchmark/observed'])
  })

  test('MCP and HTTP return identical numbers for the same store', async () => {
    const direct = buildObservedFromSources(store())
    const url = new URL('http://localhost/api/benchmark/observed')
    const http = await (await handleBenchmarkRequest(new Request(url), url, { observed: async f => buildObservedFromSources(store(), f), experiments: () => [] })).json()
    const mcp = benchmarkObservedTool(http as never)
    // the same numbers; only the id lists (`missing`) are withheld from the tool answer
    const stripped = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(direct.metrics))).map(([k, m]) => { const { missing: _m, ...rest } = m as Record<string, unknown>; return [k, rest] }))
    expect(mcp.metrics).toEqual(stripped)
    expect(mcp.deliveries).toBe(direct.deliveries)
    expect(mcp.coverage).toEqual(JSON.parse(JSON.stringify(direct.coverage)))
  })

  test('r4 F19: the tool answer carries the period the route was asked for', async () => {
    const fromMs = T0, toMs = T0 + 10 * H
    const url = new URL(`http://localhost/api/benchmark/observed?from=${fromMs}&to=${toMs}`)
    const http = await (await handleBenchmarkRequest(new Request(url), url, { observed: async f => buildObservedFromSources(store(), f), experiments: () => [] })).json()
    expect(benchmarkObservedTool(http as never).period).toEqual({ from: iso(fromMs), to: iso(toMs) })
  })

  test('carries no session or subtask id (ids stay behind the guarded route)', () => {
    const out = JSON.stringify(benchmarkObservedTool(buildObservedFromSources(store()) as never))
    expect(out).not.toContain('"missing"')
    expect(out).not.toContain('m1')
  })

  test('says the numbers are observed and biased, never a verdict', () => {
    const out = benchmarkObservedTool(buildObservedFromSources(store()) as never)
    expect(out.label).toBe('observed-biased')
    const { notStructured: _ns, ...rest } = out   // `notStructured.qaVerdict` is a COUNT of deliveries without a structured QA verdict
    expect(JSON.stringify(rest)).not.toMatch(/verdict/i)
  })
})

describe('agentistics_benchmark_observed — per-piece history (same source as the page)', () => {
  const histStore = () => {
    const s = store() as unknown as { book: { subtasks: unknown[]; tasks: unknown[] }; registry: unknown[]; metas: Map<string, unknown> }
    s.book.tasks = [{ id: 'T1', title: 'Task one' }]
    s.book.subtasks = [{ id: 'A', taskId: 'T1', title: 'A', status: 'done', createdAt: iso(T0), startedAt: iso(T0), deliveredAt: iso(T0 + 4 * H) }]
    s.metas = new Map([['c1', { session_id: 'c1', harness: 'claude', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, lines_added: 80, lines_removed: 40 }]])
    return s as never
  }
  const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'id' ? undefined : x)))

  test('HTTP and MCP carry the same rows, buckets and coverage; the tool drops only the ids', async () => {
    const url = new URL('http://localhost/api/benchmark/observed')
    const http = await (await handleBenchmarkRequest(new Request(url), url, { observed: async f => buildObservedFromSources(histStore(), f), experiments: () => [] })).json() as { history: { tasks: unknown[]; buckets: unknown[]; coverage: unknown; pieces: number } }
    const mcp = benchmarkObservedTool(http as never) as unknown as { history: { tasks: unknown[]; buckets: unknown[]; coverage: unknown; pieces: number; tasksTotal: number } }
    expect(http.history.pieces).toBe(1)
    expect(mcp.history.pieces).toBe(1)
    expect(mcp.history.buckets).toEqual(http.history.buckets)
    expect(mcp.history.coverage).toEqual(http.history.coverage)
    expect(mcp.history.tasks).toEqual(strip(http.history.tasks) as unknown[])
    expect(mcp.history.tasksTotal).toBe(http.history.tasks.length)
  })

  test('the piece is measured from the board: lines give the size, cost is tokens × price, wall time is start → delivery', () => {
    const h = buildObservedFromSources(histStore()).history!
    const t = h.tasks[0]!
    expect([t.title, t.pieces, t.sessions, t.size, t.lines]).toEqual(['Task one', 1, 1, 'M', 120])
    expect(t.costUSD).toBeGreaterThan(0)
    expect(t.wallMs).toBe(4 * H)
    expect(h.buckets.find(b => b.label === '1')!.pieces).toBe(1)
    expect(h.coverage.pctWithCost).toBe(100)
  })

  test('without a recorded QA the rework figure is absent, not zero', () => {
    const h = buildObservedFromSources(histStore()).history!
    expect(h.tasks[0]!.qaRounds).toBeNull()
    expect(h.buckets.find(b => b.label === '1')!.reworkRate).toBeNull()
  })
})

describe('agentistics_benchmark_observed — the comparisons are built on the server (parity)', () => {
  // 8 pieces of one size: 4 with one QA session (1 round), 4 with two (2 rounds); a 9th has no duration (start = delivery)
  const cmpStore = () => {
    const s = store() as unknown as { book: { subtasks: unknown[]; tasks: unknown[] }; registry: unknown[]; metas: Map<string, unknown> }
    const registry: unknown[] = [], metas = new Map<string, unknown>(), subtasks: unknown[] = []
    for (let i = 0; i < 9; i++) {
      const id = `P${i}`, again = i >= 4 && i < 8, zero = i === 8
      subtasks.push({ id, taskId: 'T1', title: id, status: 'done', createdAt: iso(T0), startedAt: iso(T0), deliveredAt: iso(zero ? T0 : T0 + (again ? 8 : 2) * H) })
      const labels = ['Implementar', 'QA · ' + id, ...(again ? ['QA · ' + id + ' rodada 2'] : [])]
      labels.forEach((label, j) => {
        const cid = `c${i}-${j}`
        registry.push({ id: `m${i}-${j}`, harness: 'claude', createdAt: iso(T0), conversationId: cid, subtaskId: id, taskId: 'T1', model: 'claude-sonnet-5', label })
        metas.set(cid, { session_id: cid, harness: 'claude', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, lines_added: j === 0 ? 200 : 0, lines_removed: 0 })
      })
    }
    s.book.tasks = [{ id: 'T1', title: 'Task one' }]; s.book.subtasks = subtasks; s.registry = registry; s.metas = metas
    return s as never
  }

  test('HTTP and the MCP tool carry the SAME comparisons (key, n, ratios, per-size pairs), computed once in core', async () => {
    const url = new URL('http://localhost/api/benchmark/observed')
    const http = await (await handleBenchmarkRequest(new Request(url), url, { observed: async f => buildObservedFromSources(cmpStore(), f), experiments: () => [] })).json() as { history: { comparisons: { key: string; nA: number; nB: number; wall: { ratio: number; sizes: unknown[] } | null }[] } }
    const mcp = benchmarkObservedTool(http as never) as unknown as { history: { comparisons: unknown[] } }
    expect(http.history.comparisons.map(c => c.key)).toContain('qa')
    expect(mcp.history.comparisons).toEqual(http.history.comparisons)    // the `key` survives the id-stripping
    const qa = http.history.comparisons.find(c => c.key === 'qa')!
    expect(qa.wall!.ratio).toBe(4)                                        // 8 h against 2 h; the zero-length piece is out
    expect(qa.wall!.sizes).toEqual([{ size: 'M', medA: 2 * H, medB: 8 * H, ratio: 4, nA: 4, nB: 4 }])   // the pair's own ratio travels: no division in the browser
  })

  test('HTTP and the MCP tool carry the SAME per-task pairs (the prototype\'s "um → outro"), computed once in core', async () => {
    const url = new URL('http://localhost/api/benchmark/observed')
    const http = await (await handleBenchmarkRequest(new Request(url), url, { observed: async f => buildObservedFromSources(cmpStore(), f), experiments: () => [] })).json() as { history: { tasks: { sides: Record<string, { nA: number; nB: number; wallMs: [number | null, number | null]; defects: unknown[] }> }[] } }
    const mcp = benchmarkObservedTool(http as never) as unknown as { history: { tasks: { sides: unknown }[] } }
    const sides = http.history.tasks[0]!.sides
    expect(Object.keys(sides).sort()).toEqual(['qa', 'sessions'])
    expect(sides.qa!.wallMs).toEqual([2 * H, 8 * H])
    expect(sides.qa!.defects).toEqual([null, null])
    expect(mcp.history.tasks[0]!.sides).toEqual(sides)
  })

  test('the piece with no duration is a count in the coverage, not a "0 min"', () => {
    const h = buildObservedFromSources(cmpStore()).history!
    expect(h.coverage.withoutDuration).toBe(1)
    expect(h.tasks[0]!.subtasks.find(s => s.title === 'P8')!.wallMs).toBeNull()
  })

  test('the tool answer is not capped like the task list: comparisons stay whole when tasks are cut', () => {
    const body = JSON.parse(JSON.stringify(buildObservedFromSources(cmpStore())))
    body.history.tasks = Array.from({ length: 150 }, (_, i) => ({ ...body.history.tasks[0], id: `t${i}` }))
    const mcp = benchmarkObservedTool(body) as unknown as { history: { comparisons: unknown[]; tasks: unknown[]; tasksTotal: number } }
    expect(mcp.history.tasks.length).toBe(100)
    expect(mcp.history.comparisons).toEqual(body.history.comparisons)
  })
})

describe('history: QA rounds from QA session labels', () => {
  test('a piece with a QA-labelled session reports a round count; one without stays unknown', () => {
    const s = store() as unknown as { book: { subtasks: unknown[] }; registry: { id: string; harness: string; createdAt: string; conversationId: string; subtaskId: string; taskId: string; label?: string }[]; metas: Map<string, unknown> }
    s.book.subtasks = [{ id: 'A', taskId: 'T1', title: 'A', status: 'done', createdAt: iso(T0), deliveredAt: iso(T0 + 4 * H) }, { id: 'B', taskId: 'T1', title: 'B', status: 'done', createdAt: iso(T0), deliveredAt: iso(T0 + 4 * H) }]
    s.registry = [
      { id: 'm1', harness: 'claude', createdAt: iso(T0), conversationId: 'c1', subtaskId: 'A', taskId: 'T1', label: 'Implementar A' },
      { id: 'm2', harness: 'codex', createdAt: iso(T0), conversationId: 'c2', subtaskId: 'A', taskId: 'T1', label: 'QA · A (Codex)' },
      { id: 'm3', harness: 'codex', createdAt: iso(T0), conversationId: 'c3', subtaskId: 'A', taskId: 'T1', label: 'QA · A rodada 2 (Codex)' },
      { id: 'm4', harness: 'claude', createdAt: iso(T0), conversationId: 'c4', subtaskId: 'B', taskId: 'T1', label: 'Implementar B' },
    ]
    const h = buildObservedFromSources(s as never).history!
    const rows = h.tasks[0]!.subtasks
    expect(rows.find(r => r.title === 'A')!.qaRounds).toBe(2)
    expect(rows.find(r => r.title === 'A')!.reworked).toBe(true)
    expect(rows.find(r => r.title === 'B')!.qaRounds).toBeNull()
  })
})
