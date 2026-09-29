/**
 * runtime-metrics-fixtures.ts — an in-memory `ProjectionReader` and fact builders for the
 * `/api/runtime/metrics` tests. Test support only; nothing in the product imports it.
 */
import type { CostFact, ProjectionReader, RunFact } from './projections/facts'

type Status = Awaited<ReturnType<ProjectionReader['status']>>

export function fakeReader(
  cost: CostFact[],
  runs: RunFact[],
  status: Status = { cursor: 10, journalHead: 10, versions: { costByDimension: 1, runMetrics: 1 }, rebuilding: false },
): ProjectionReader & { reads: { cost: number; run: number; status: number } } {
  const reads = { cost: 0, run: 0, status: 0 }
  const inRange = (day: string, r: { from?: string; to?: string }) =>
    (!r.from || day >= r.from) && (!r.to || day <= r.to)
  return {
    reads,
    async *costFacts(r) { reads.cost++; for (const f of cost) if (inRange(f.day, r)) yield f },
    async *runFacts(r) { reads.run++; for (const f of runs) if (inRange(f.day, r)) yield f },
    async status() { reads.status++; return status },
  }
}

export function costFact(p: Partial<CostFact> = {}): CostFact {
  return {
    day: '2026-09-01',
    harness: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    repo: 'github.com/org/app',
    project: '/home/u/app',
    sessionId: 's1',
    runId: 'r1',
    agentId: 'main',
    subagent: false,
    taskId: null,
    tokens: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 },
    partialCounters: [],
    costUSD: 1,
    costSource: 'table',
    responses: 1,
    confidence: 'exact',
    ...p,
  }
}

export function runFact(p: Partial<RunFact> = {}): RunFact {
  return {
    runId: 'r1',
    sessionId: 's1',
    harness: 'claude',
    day: '2026-09-01',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    repo: 'github.com/org/app',
    project: '/home/u/app',
    taskId: null,
    messages: 3,
    activeMinutes: 12,
    tools: { Bash: { calls: 2, errors: 0, durationMs: 1000 } },
    unmeasuredAgents: 0,
    confidence: 'exact',
    ...p,
  }
}
