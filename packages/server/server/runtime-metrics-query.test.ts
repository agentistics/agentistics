import { describe, expect, it } from 'bun:test'
import { CAPABILITY_STATES, type HarnessId } from '@agentistics/core'
import {
  compareKeys,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseMetricsQuery,
  runMetricsQuery,
  type CapabilityTable,
  type MetricsQuery,
} from './runtime-metrics-query'
import { costFact, fakeReader, runFact } from './runtime-metrics-fixtures'

function q(qs: string): MetricsQuery {
  const r = parseMetricsQuery(new URLSearchParams(qs))
  if (!r.ok) throw new Error(`refused: ${r.error.code} ${r.error.sentence}`)
  return r.query
}
function refusal(qs: string) {
  const r = parseMetricsQuery(new URLSearchParams(qs))
  if (r.ok) throw new Error('expected a refusal')
  return r.error
}

describe('parseMetricsQuery — bad input is refused with a code, never ignored', () => {
  it('defaults', () => {
    const query = q('')
    expect(query.limit).toBe(DEFAULT_LIMIT)
    expect(query.metrics).toEqual(['cost', 'tokens', 'sessions', 'runs'])
    expect(query.groupBy).toEqual([])
  })
  it.each([
    ['bogus=1', 'unknown_param'],
    ['groupBy=colour', 'unknown_dimension'],
    ['groupBy=day,day', 'duplicate_dimension'],
    ['groupBy=day,harness,model,repo', 'too_many_dimensions'],
    ['metrics=cost,vibes', 'unknown_metric'],
    ['metrics=', 'empty_metrics'],
    ['harness=cursor', 'unknown_harness'],
    ['provider=acme', 'unknown_provider'],
    ['from=2026-13-01', 'bad_date'],
    ['from=2026-02-30', 'bad_date'],
    ['from=2026-09-02&to=2026-09-01', 'bad_range'],
    ['limit=0', 'bad_limit'],
    ['limit=abc', 'bad_limit'],
    [`limit=${MAX_LIMIT + 1}`, 'limit_too_large'],
    ['limit=1&limit=2', 'repeated_param'],
    ['cursor=garbage', 'bad_cursor'],
    ['tag=t1', 'unsupported_filter'],
    ['machine=m1', 'unsupported_filter'],
    ['member=alice', 'unsupported_filter'],
  ])('%s → %s', (qs, code) => {
    const e = refusal(qs)
    expect(e.code).toBe(code)
    expect(e.sentence.length).toBeGreaterThan(5)
  })
  it('multi-valued filters: comma lists and repetition, but a project path keeps its comma', () => {
    const query = q('harness=claude,codex&harness=kimi&project=/a,b&project=/c')
    expect(query.filters.harness).toEqual(['claude', 'codex', 'kimi'])
    expect(query.filters.project).toEqual(['/a,b', '/c'])
  })
  it('an empty provider value selects the unnamed bucket', () => {
    expect(q('provider=').filters.provider).toEqual([''])
  })
})

describe('runMetricsQuery — filters, grouping, provider and run', () => {
  const cost = [
    costFact({ sessionId: 's1', runId: 'r1', harness: 'claude', provider: 'anthropic', costUSD: 2 }),
    costFact({ sessionId: 's2', runId: 'r2', harness: 'codex', provider: 'openai', model: 'gpt-5', costUSD: 3, day: '2026-09-02' }),
    costFact({ sessionId: 's3', runId: 'r3', harness: 'kimi', provider: 'anthropic', model: 'claude-haiku-5', costUSD: 0.5 }),
    costFact({ sessionId: 's3', runId: null, harness: 'kimi', provider: null, model: null, costUSD: null, costSource: null, confidence: 'inferred' }),
  ]
  const runs = [runFact({ runId: 'r1', sessionId: 's1' }), runFact({ runId: 'r2', sessionId: 's2', harness: 'codex', day: '2026-09-02' })]

  it('provider filter spans harnesses (Claude the provider ≠ Claude Code the harness)', async () => {
    const r = await runMetricsQuery(fakeReader(cost, runs), q('provider=anthropic&metrics=cost'))
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]!.metrics.cost!.usd).toBeCloseTo(2.5)
  })
  it('run filter', async () => {
    const r = await runMetricsQuery(fakeReader(cost, runs), q('run=r2&metrics=cost,runs,sessions'))
    expect(r.groups[0]!.metrics.cost!.usd).toBe(3)
    expect(r.groups[0]!.metrics.runs!.count).toBe(1)
  })
  it('the unnamed provider bucket is reachable and not zero-filled', async () => {
    const r = await runMetricsQuery(fakeReader(cost, runs), q('provider=&metrics=cost'))
    expect(r.groups[0]!.metrics.cost).toBeUndefined()
    expect(r.groups[0]!.absent.cost!.reason).toContain('could be priced')
  })
  it('groupBy harness,day is ordered deterministically by key', async () => {
    const r = await runMetricsQuery(fakeReader(cost, runs), q('groupBy=harness,day&metrics=sessions'))
    expect(r.groups.map(g => [g.key.harness, g.key.day])).toEqual([
      ['claude', '2026-09-01'], ['codex', '2026-09-02'], ['kimi', '2026-09-01'],
    ])
  })
  it('from/to filter by the fact day', async () => {
    const r = await runMetricsQuery(fakeReader(cost, runs), q('from=2026-09-02&metrics=cost'))
    expect(r.groups[0]!.metrics.cost!.usd).toBe(3)
  })
  it('sessions are distinct sessionIds and runs distinct runIds, across both streams', async () => {
    const r = await runMetricsQuery(fakeReader(cost, runs), q('metrics=sessions,runs'))
    expect(r.groups[0]!.metrics.sessions!.count).toBe(3)
    expect(r.groups[0]!.metrics.runs!.count).toBe(3)
  })
  it('reads only the streams the metrics need', async () => {
    const reader = fakeReader(cost, runs)
    await runMetricsQuery(reader, q('metrics=cost'))
    expect(reader.reads).toEqual({ cost: 1, run: 0, status: 1 })
  })
})

describe('tokens — all four counters, and an absent counter is absent', () => {
  it('sums all four through totalTokens', async () => {
    const r = await runMetricsQuery(fakeReader([costFact()], []), q('metrics=tokens'))
    expect(r.groups[0]!.metrics.tokens!.total).toBe(370)
    expect(r.groups[0]!.metrics.tokens!.absentCounters).toEqual([])
  })
  it('a counter no row reported is absent, not 0; a partly reported one is flagged', async () => {
    const f = costFact({ tokens: { input: 5, output: 7 }, partialCounters: ['output'] })
    const r = await runMetricsQuery(fakeReader([f], []), q('metrics=tokens'))
    const t = r.groups[0]!.metrics.tokens!
    expect(t.cacheRead).toBeUndefined()
    expect(t.absentCounters).toEqual(['cacheRead', 'cacheWrite'])
    expect(t.partialCounters).toEqual(['output'])
    expect(t.total).toBe(12)
    expect(r.basis.unmeasured.partialCounterRows).toBe(1)
  })
  it('no counter at all → tokens absent with a reason', async () => {
    const r = await runMetricsQuery(fakeReader([costFact({ tokens: {} })], []), q('metrics=tokens'))
    expect(r.groups[0]!.metrics.tokens).toBeUndefined()
    expect(r.groups[0]!.absent.tokens).toBeDefined()
  })
})

describe('capability-aware: absent with a reason, never 0', () => {
  // The real table has no harness that cannot produce cost/tokens/tools/activeTime today (every
  // legacy false there is refined to partial), so the table is injected with one that cannot.
  const caps: CapabilityTable = structuredClone(CAPABILITY_STATES)
  caps.gemini = { ...caps.gemini, cost: { state: 'not_supported', reason: 'gemini states no price', source: 'test' } }

  it('a group whose only harness cannot produce the metric has it absent, not 0', async () => {
    const r = await runMetricsQuery(
      fakeReader([costFact({ harness: 'gemini', costUSD: 0 })], []),
      q('metrics=cost,sessions'),
      caps,
    )
    const g = r.groups[0]!
    expect(g.metrics.cost).toBeUndefined()
    expect(g.absent.cost!.excluded).toEqual([{ harness: 'gemini', reason: 'not_supported: gemini states no price' }])
    expect(g.metrics.sessions!.count).toBe(1)
    expect(r.basis.unmeasured.capabilityExcludedRows).toBe(1)
  })
  it('a mixed group sums only the capable harnesses and names the excluded ones', async () => {
    const r = await runMetricsQuery(
      fakeReader([costFact({ harness: 'claude', costUSD: 4 }), costFact({ harness: 'gemini', costUSD: 100, sessionId: 's9' })], []),
      q('metrics=cost'),
      caps,
    )
    const c = r.groups[0]!.metrics.cost!
    expect(c.usd).toBe(4)
    expect(c.excluded!.map(e => e.harness)).toEqual(['gemini' as HarnessId])
  })
  it('an unpriced row is left out of the sum and makes it partial', async () => {
    const r = await runMetricsQuery(
      fakeReader([costFact({ costUSD: 2 }), costFact({ costUSD: null, costSource: null })], []),
      q('metrics=cost'),
    )
    const c = r.groups[0]!.metrics.cost!
    expect(c).toMatchObject({ usd: 2, pricedRows: 1, unpricedRows: 1, partial: true })
    expect(r.basis.unmeasured.unpricedCostRows).toBe(1)
  })
  it('messages/activeMinutes with no measured run are absent', async () => {
    const r = await runMetricsQuery(
      fakeReader([], [runFact({ messages: null, activeMinutes: null })]),
      q('metrics=messages,activeMinutes'),
    )
    expect(r.groups[0]!.absent.messages).toBeDefined()
    expect(r.groups[0]!.absent.activeMinutes).toBeDefined()
    expect(r.basis.unmeasured.runsWithoutMessages).toBe(1)
  })
})

describe('confidence', () => {
  it('the group carries the WEAKEST confidence and the basis the mix', async () => {
    const r = await runMetricsQuery(
      fakeReader([costFact(), costFact({ confidence: 'estimated' }), costFact({ confidence: 'exact' })], [runFact({ confidence: 'inferred' })]),
      q('metrics=cost,runs'),
    )
    expect(r.groups[0]!.confidence).toBe('inferred')
    expect(r.basis.confidence.rows).toBe(4)
    expect(r.basis.confidence.exact).toEqual({ count: 2, share: 0.5 })
    expect(r.basis.confidence.estimated.count).toBe(1)
    expect(r.basis.confidence.inferred.count).toBe(1)
    expect(r.basis.confidence.weakest).toBe('inferred')
  })
})

describe('basis block', () => {
  it('states the day rule, the api cost basis (no plan), unmeasured counts and freshness', async () => {
    const r = await runMetricsQuery(
      fakeReader([], [runFact({ unmeasuredAgents: 2, tools: { Bash: { calls: 1, errors: 0, durationMs: null } } })],
        { cursor: 7, journalHead: 10, versions: { runMetrics: 3 }, rebuilding: false }),
      q('metrics=tools'),
    )
    expect(r.basis.dayRule).toContain('occurredAt.slice(0,10)')
    expect(r.basis.costBasis.basis).toBe('api')
    expect(r.basis.costBasis.planApplied).toBe(false)
    expect(r.basis.unmeasured.unmeasuredAgents).toBe(2)
    expect(r.basis.unmeasured.toolEntriesWithoutDuration).toBe(1)
    expect(r.basis.freshness).toMatchObject({ lag: 3, fresh: false, versions: { runMetrics: 3 } })
    expect(r.groups[0]!.metrics.tools!.durationMs).toBeNull()
  })
})

describe('paging', () => {
  const cost = Array.from({ length: 25 }, (_, i) => costFact({ runId: `r${String(i).padStart(2, '0')}`, sessionId: `s${i}` }))

  it('walks every group exactly once, in key order, with a stable cursor', async () => {
    const reader = fakeReader(cost, [])
    const seen: string[] = []
    let qs = 'groupBy=run&metrics=cost&limit=10'
    let cursor: string | null = null
    let pages = 0
    do {
      const r = await runMetricsQuery(reader, q(cursor ? `${qs}&cursor=${cursor}` : qs))
      seen.push(...r.groups.map(g => g.key.run as string))
      expect(r.page.totalGroups).toBe(25)
      cursor = r.page.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(seen).toEqual([...seen].sort())
    expect(new Set(seen).size).toBe(25)
  })
  it('the same cursor yields the same page on a second call', async () => {
    const reader = fakeReader(cost, [])
    const first = await runMetricsQuery(reader, q('groupBy=run&metrics=cost&limit=10'))
    const a = await runMetricsQuery(reader, q(`groupBy=run&metrics=cost&limit=10&cursor=${first.page.nextCursor}`))
    const b = await runMetricsQuery(reader, q(`groupBy=run&metrics=cost&limit=10&cursor=${first.page.nextCursor}`))
    expect(a.groups).toEqual(b.groups)
  })
  it('a cursor from another query is refused', async () => {
    const first = await runMetricsQuery(fakeReader(cost, []), q('groupBy=run&metrics=cost&limit=10'))
    expect(refusal(`groupBy=run&metrics=cost,tokens&cursor=${first.page.nextCursor}`).code).toBe('cursor_mismatch')
    expect(refusal(`groupBy=day&metrics=cost&cursor=${first.page.nextCursor}`).code).toBe('cursor_mismatch')
  })
  it('no parameter returns more than MAX_LIMIT groups', async () => {
    const many = Array.from({ length: MAX_LIMIT + 5 }, (_, i) => costFact({ runId: `r${i}` }))
    const r = await runMetricsQuery(fakeReader(many, []), q(`groupBy=run&metrics=cost&limit=${MAX_LIMIT}`))
    expect(r.groups).toHaveLength(MAX_LIMIT)
    expect(r.page.nextCursor).not.toBeNull()
  })
  it('null sorts before strings', () => {
    expect(compareKeys([null], ['a'])).toBeLessThan(0)
    expect(compareKeys(['a', null], ['a', 'b'])).toBeLessThan(0)
  })
})

describe('the §37 questions over a small fact set', () => {
  const cost = [
    // Claude Code on Anthropic models, one run filed on task t1.
    costFact({ harness: 'claude', provider: 'anthropic', costUSD: 10, sessionId: 'c1', runId: 'c1r', taskId: 't1' }),
    // Kimi routing to an Anthropic model: Claude-the-provider, not Claude-Code-the-harness.
    costFact({ harness: 'kimi', provider: 'anthropic', costUSD: 1, sessionId: 'k1', runId: 'k1r' }),
    // Codex on OpenAI, also filed on t1.
    costFact({ harness: 'codex', provider: 'openai', model: 'gpt-5', costUSD: 5, sessionId: 'x1', runId: 'x1r', taskId: 't1' }),
  ]
  const runs = [
    runFact({ runId: 'c1r', sessionId: 'c1', tools: { Bash: { calls: 3, errors: 0, durationMs: 9000 }, Read: { calls: 10, errors: 0, durationMs: 500 } } }),
    runFact({ runId: 'x1r', sessionId: 'x1', harness: 'codex', tools: { Bash: { calls: 1, errors: 1, durationMs: 1000 }, Edit: { calls: 2, errors: 0, durationMs: null } } }),
  ]
  const reader = () => fakeReader(cost, runs)

  it('spend on Claude, the provider', async () => {
    const r = await runMetricsQuery(reader(), q('provider=anthropic&metrics=cost'))
    expect(r.groups[0]!.metrics.cost!.usd).toBe(11)
  })
  it('spend on Claude Code, the harness', async () => {
    const r = await runMetricsQuery(reader(), q('harness=claude&metrics=cost'))
    expect(r.groups[0]!.metrics.cost!.usd).toBe(10)
  })
  it('what Codex cost', async () => {
    const r = await runMetricsQuery(reader(), q('harness=codex&metrics=cost'))
    expect(r.groups[0]!.metrics.cost!.usd).toBe(5)
  })
  it('what a task cost, per harness', async () => {
    const r = await runMetricsQuery(reader(), q('task=t1&groupBy=harness&metrics=cost'))
    expect(r.groups.map(g => [g.key.harness, g.metrics.cost!.usd])).toEqual([['claude', 10], ['codex', 5]])
  })
  it('which tools took the most time', async () => {
    const r = await runMetricsQuery(reader(), q('metrics=tools'))
    const t = r.groups[0]!.metrics.tools!
    expect(t.byTool.map(x => [x.name, x.durationMs])).toEqual([['Bash', 10000], ['Read', 500], ['Edit', null]])
    expect(t.durationMs).toBe(10500)
  })
  it('what the subagents cost, and by which agent', async () => {
    const facts = [
      costFact({ costUSD: 10, agentId: 'main', subagent: false }),
      costFact({ costUSD: 2, agentId: 'a1', subagent: true }),
      costFact({ costUSD: 3, agentId: 'a2', subagent: true, harness: 'kimi' }),
    ]
    const all = await runMetricsQuery(fakeReader(facts, runs), q('subagent=true&metrics=cost,sessions'))
    expect(all.groups[0]!.metrics.cost!.usd).toBe(5)
    const byAgent = await runMetricsQuery(fakeReader(facts, runs), q('subagent=true&groupBy=agent&metrics=cost'))
    expect(byAgent.groups.map(g => [g.key.agent, g.metrics.cost!.usd])).toEqual([['a1', 2], ['a2', 3]])
  })
  it('Claude through the native harness: counted, and an unknown capability is absent-with-reason, never 0', async () => {
    const facts = [
      costFact({ harness: 'agentistics', provider: 'anthropic', costUSD: 7, sessionId: 'n1', runId: 'n1r' }),
      costFact({ harness: 'claude', provider: 'anthropic', costUSD: 10 }),
    ]
    const r = await runMetricsQuery(fakeReader(facts, []), q('harness=agentistics&provider=anthropic&metrics=cost,tokens,responses,sessions'))
    const g = r.groups[0]!
    expect(g.metrics.sessions!.count).toBe(1)
    expect(g.metrics.responses!.count).toBe(1)
    // NATIVE.SURF declared the native harness's capabilities: its cost is counted, and only its own.
    expect(g.metrics.cost!.usd).toBe(7)
  })
  it('Claude through the native harness, once its capability is declared', async () => {
    const caps = structuredClone(CAPABILITY_STATES) as CapabilityTable & Record<string, unknown>
    ;(caps as Record<string, unknown>).agentistics = caps.claude
    const r = await runMetricsQuery(
      fakeReader([costFact({ harness: 'agentistics', costUSD: 7 })], []),
      q('harness=agentistics&metrics=cost'),
      caps,
    )
    expect(r.groups[0]!.metrics.cost!.usd).toBe(7)
  })
})

describe('agent dimension', () => {
  it('per-run metrics cannot be split by agent and are refused', () => {
    expect(refusal('groupBy=agent&metrics=tools').code).toBe('metric_dimension_mismatch')
    expect(refusal('subagent=true&metrics=messages').code).toBe('metric_dimension_mismatch')
    expect(refusal('subagent=maybe').code).toBe('bad_boolean')
  })
  it('A4.7 decision 2: subagent=false|true splits the TOOL figures by the run facts\' subagent share', async () => {
    const reader = () => fakeReader([], [
      runFact({ runId: 'r1', tools: { Bash: { calls: 3, errors: 1, durationMs: 300, durationCalls: 3, subagent: { calls: 1, errors: 1, durationMs: 100, durationCalls: 1 } } } }),
      runFact({ runId: 'r2', sessionId: 's2', tools: { Read: { calls: 2, errors: 0, durationMs: null } } }),
    ])
    const main = await runMetricsQuery(reader(), q('subagent=false&metrics=tools'))
    expect(main.groups[0]!.metrics.tools!.byTool.map(t => [t.name, t.calls, t.errors])).toEqual([['Bash', 2, 0], ['Read', 2, 0]])
    expect(main.groups[0]!.metrics.tools!.byTool.find(t => t.name === 'Bash')!.durationMs).toBe(200)
    const sub = await runMetricsQuery(reader(), q('subagent=true&metrics=tools'))
    expect(sub.groups[0]!.metrics.tools!.byTool.map(t => [t.name, t.calls, t.errors])).toEqual([['Bash', 1, 1]])
    const all = await runMetricsQuery(reader(), q('metrics=tools'))
    expect(all.groups[0]!.metrics.tools!.calls).toBe(5)
  })
  it('the tool split is per run fact only: the agent dimension still refuses tools, and subagent still refuses messages', () => {
    expect(refusal('groupBy=agent&subagent=false&metrics=tools').code).toBe('metric_dimension_mismatch')
    expect(refusal('subagent=false&metrics=tools,messages').code).toBe('metric_dimension_mismatch')
  })
  it('with an agent dimension the run stream is not read', async () => {
    const reader = fakeReader([costFact()], [runFact()])
    await runMetricsQuery(reader, q('groupBy=agent&metrics=cost,sessions,runs'))
    expect(reader.reads.run).toBe(0)
  })
})

describe('tool duration coverage', () => {
  it('durationCalls below calls marks the duration partial', async () => {
    const r = await runMetricsQuery(
      fakeReader([], [runFact({ tools: { Bash: { calls: 4, errors: 0, durationMs: 800, durationCalls: 2 }, Read: { calls: 1, errors: 0, durationMs: 5, durationCalls: 1 } } })]),
      q('metrics=tools'),
    )
    const t = r.groups[0]!.metrics.tools!.byTool
    expect(t.find(x => x.name === 'Bash')!.durationPartial).toBe(true)
    expect(t.find(x => x.name === 'Read')!.durationPartial).toBe(false)
    expect(r.basis.unmeasured.toolEntriesWithPartialDuration).toBe(1)
  })
})
