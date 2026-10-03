import { describe, expect, test } from 'bun:test'
import type { Filters, MetricsQueryFn } from '@agentistics/core'
// The server's own query over an in-memory reader (test-only import).
import { parseMetricsQuery, runMetricsQuery } from '../../../server/server/runtime-metrics-query'
import { costFact, fakeReader, runFact } from '../../../server/server/runtime-metrics-fixtures'
import { projectedDerived, projectedScope } from './projectedDerived'
import { inProjects } from '../hooks/useData'

const base: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
const all = { start: new Date(0), end: new Date('2026-09-30T23:59:59.999Z') }
const blended = () => ({ input: 3, cacheRead: 0.3, cacheWrite: 3.75 })

const query = (): MetricsQueryFn => {
  const r = fakeReader(
    [
      costFact({ sessionId: 's1', day: '2026-09-01' }),
      costFact({ sessionId: 's1', agentId: 'sub', subagent: true, costUSD: 5 }),
      costFact({ sessionId: 's2', harness: 'codex', model: 'gpt-5.5', project: '/home/u/other', costUSD: 2 }),
    ],
    [
      runFact({ sessionId: 's1', runId: 'r1', messages: 3, tools: { Bash: { calls: 2, errors: 0, durationMs: 10 } } }),
      runFact({ sessionId: 's2', runId: 'r2', harness: 'codex', model: 'gpt-5.5', project: '/home/u/other', messages: 1, tools: { Read: { calls: 5, errors: 0, durationMs: 1 } } }),
    ],
  )
  return async p => {
    const parsed = parseMetricsQuery(p)
    if (!parsed.ok) throw new Error(`bad query ${p}: ${JSON.stringify(parsed)}`)
    return { ok: true, body: await runMetricsQuery(r, parsed.query) }
  }
}

describe('projectedScope: the filters the API can express', () => {
  test('all time: only the upper bound', () => {
    expect(projectedScope(base, false, all)).toEqual({ to: '2026-09-30' })
  })

  test('harness, project (as its root), repo and model map to repeated parameters', () => {
    const s = projectedScope({ ...base, harnesses: ['codex'], harness: 'claude', projects: ['/p/app/.worktrees/x', '/p/app'], repos: [''], models: ['m'] }, false,
      { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-09-07T23:59:59Z') })
    expect(s).toEqual({ from: '2026-09-01', to: '2026-09-07', harness: ['codex', 'claude'], project: ['/p/app'], repo: [''], model: ['m'] })
  })

  test('a scope the API refuses is never approximated: null, and the legacy figures stay', () => {
    expect(projectedScope({ ...base, tags: ['t'] }, false, all)).toBeNull()
    expect(projectedScope({ ...base, users: ['u'] }, false, all)).toBeNull()
    expect(projectedScope({ ...base, machines: ['m'] }, false, all)).toBeNull()
    expect(projectedScope({ ...base, presence: 'online' }, false, all)).toBeNull()
    expect(projectedScope(base, true, all)).toBeNull()
  })
})

describe('projectedDerived (A4.7)', () => {
  test('sessions, and main-agent cost and tokens per model; tools and projects stay legacy', async () => {
    const d = await projectedDerived(query(), { to: '2026-09-30' }, blended)
    expect(d.figuresSource).toBe('projections')
    expect(d.totalSessions).toBe(2)
    expect(d.totalCostUSD).toBe(3)
    expect(Object.keys(d.modelUsage).sort()).toEqual(['claude-sonnet-5', 'gpt-5.5'])
    expect(d.modelUsage['claude-sonnet-5']).toMatchObject({ inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 1 })
    expect(d.tokenTotals).toMatchObject({ input: 20, output: 40, cacheRead: 600, cacheWrite: 80 })
    // Tools and projectStats are NOT overlaid: the projection's tool counts include subagents.
    expect('toolCounts' in d).toBe(false)
    expect('projectStats' in d).toBe(false)
    expect(d.cacheHitRate).toBeCloseTo(600 / (20 + 600 + 80), 10)
  })
})

describe('the legacy project filter follows the root rule', () => {
  test('choosing a root selects its worktrees; choosing a worktree selects only it', () => {
    expect(inProjects(new Set(['/p/app']), '/p/app/.worktrees/x')).toBe(true)
    expect(inProjects(new Set(['/p/app']), '/p/app')).toBe(true)
    expect(inProjects(new Set(['/p/app/.worktrees/x']), '/p/app')).toBe(false)
    expect(inProjects(new Set(['/p/app/.worktrees/x']), '/p/app/.worktrees/x')).toBe(true)
  })
})
