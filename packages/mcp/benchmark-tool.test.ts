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
