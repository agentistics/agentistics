/**
 * P3 §6 budget: `/api/runtime/metrics` p95 < 300 ms over a store of 100k sessions, measured on
 * generated data. This measures the PURE query over an in-memory fake reader (the real store's IO is
 * A4.1's to measure). The printed p95 is the evidence; the assertion is looser than the budget so a
 * loaded CI box does not turn a measurement into a flake.
 */
import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER, type Confidence, type ProviderId } from '@agentistics/core'
import type { CostFact, RunFact } from './projections/facts'
import { parseMetricsQuery, runMetricsQuery } from './runtime-metrics-query'
import { fakeReader } from './runtime-metrics-fixtures'

const SESSIONS = 100_000

function generate(): { cost: CostFact[]; runs: RunFact[] } {
  const cost: CostFact[] = []
  const runs: RunFact[] = []
  const providers: ProviderId[] = ['anthropic', 'openai', 'google', 'moonshot']
  const confs: Confidence[] = ['exact', 'exact', 'estimated', 'inferred']
  let seed = 42
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < SESSIONS; i++) {
    const harness = HARNESS_ORDER[i % HARNESS_ORDER.length]!
    const provider = providers[i % providers.length]!
    const day = `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`
    const base = {
      harness, provider, day,
      model: `${provider}-m${i % 5}`,
      repo: `github.com/org/r${i % 200}`,
      project: `/home/u/p${i % 300}`,
      sessionId: `s${i}`,
      runId: `r${i}`,
      taskId: i % 10 === 0 ? `t${i % 500}` : null,
      confidence: confs[i % confs.length]!,
    }
    // Two cost cells per session (two models / two days on average in real stores).
    for (let k = 0; k < 2; k++) {
      cost.push({
        ...base,
        tokens: { input: Math.floor(rnd() * 1000), output: Math.floor(rnd() * 1000), cacheRead: Math.floor(rnd() * 100000), cacheWrite: Math.floor(rnd() * 5000) },
        agentId: k === 0 ? 'main' : `a${i % 3}`,
        subagent: k === 1,
        partialCounters: [],
        costUSD: i % 50 === 0 ? null : rnd() * 3,
        costSource: i % 50 === 0 ? null : 'table',
        responses: 1 + (i % 7),
      })
    }
    runs.push({
      ...base,
      runId: `r${i}`,
      messages: i % 13 === 0 ? null : 1 + (i % 20),
      activeMinutes: i % 17 === 0 ? null : i % 90,
      tools: { Bash: { calls: 1 + (i % 5), errors: 0, durationMs: i % 4 === 0 ? null : 100 * (i % 30) }, Read: { calls: 2, errors: 0, durationMs: 40 } },
      unmeasuredAgents: i % 100 === 0 ? 1 : 0,
    })
  }
  return { cost, runs }
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!
}

describe('performance (P3 §6)', () => {
  it(`p95 of the pure query over ${SESSIONS} generated sessions`, async () => {
    const { cost, runs } = generate()
    const reader = fakeReader(cost, runs)
    const queries = [
      'metrics=cost,tokens,sessions,runs',
      'groupBy=harness,day&metrics=cost,tokens,sessions,runs,messages,activeMinutes,tools',
      'groupBy=provider&provider=anthropic,openai&metrics=cost,tokens',
      'groupBy=repo&metrics=cost,sessions&limit=100',
      'groupBy=run&metrics=cost,runs&limit=1000',
      'metrics=tools',
      'subagent=true&groupBy=agent&metrics=cost,tokens',
    ]
    const report: string[] = []
    let worst = 0
    for (const qs of queries) {
      const parsed = parseMetricsQuery(new URLSearchParams(qs))
      if (!parsed.ok) throw new Error(parsed.error.code)
      await runMetricsQuery(reader, parsed.query) // warm-up
      const times: number[] = []
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now()
        await runMetricsQuery(reader, parsed.query)
        times.push(performance.now() - t0)
      }
      const p = p95(times)
      worst = Math.max(worst, p)
      const med = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!
      report.push(`p95 ${p.toFixed(1).padStart(7)} ms  median ${med.toFixed(1).padStart(7)} ms  ${qs}`)
    }
    console.log(`[runtime-metrics perf] ${SESSIONS} sessions, ${cost.length} cost facts, ${runs.length} run facts\n` + report.join('\n'))
    expect(worst).toBeLessThan(1500)
  }, 120_000)
})
