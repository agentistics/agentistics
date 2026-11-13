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
