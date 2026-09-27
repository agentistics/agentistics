/**
 * The five P3 projections (P3 §2) as PURE folds, over real event streams: the redacted Claude and
 * Codex replay fixtures, replayed by their own integrations. The properties are P1 §8's — chunk
 * independence (fold 1..n then n+1..m == fold 1..m), order independence, idempotency by `eventId` —
 * plus P3's own: the weakest confidence wins (D17), absent counters stay absent (D21), and money
 * comes from core's `calcCost` at each model's own rate (§41).
 */
import { describe, expect, test } from 'bun:test'
import {
  calcCost, project,
  type AgentisticsEvent, type AnyAgentisticsEvent, type Confidence, type Projection,
} from '@agentistics/core'
import { agentMetricsProjection } from './agent-metrics'
import { costByDimensionProjection } from './cost-by-dimension'
import { STORED_PROJECTIONS, planProjection, type StoredMeta } from './catalog'
import { fixtureEvents, groupBy, shuffled } from './p3-fixture-events'
import { runMetricsProjection } from './run-metrics'
import { sessionMetaProjection } from './session-meta'
import { decodeState, encodeState } from './state-codec'
import { taskRollupProjection } from './task-rollup'
import { toolMetricsProjection } from './tool-metrics'

const EVENTS = await fixtureEvents()
const BY_SESSION = groupBy(EVENTS, e => e.sessionId ?? null)
const BY_RUN = groupBy(EVENTS, e => e.runId ?? null)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROJECTIONS: [Projection<any, any>, Map<string, AnyAgentisticsEvent[]>][] = [
  [runMetricsProjection, BY_RUN],
  [agentMetricsProjection, BY_RUN],
  [toolMetricsProjection, BY_RUN],
  [costByDimensionProjection, BY_SESSION],
]

/** `finish` of the fold over `slices`, in order, each slice passed through the state codec first. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function foldSlices(p: Projection<any, any>, slices: AnyAgentisticsEvent[][], viaCodec: boolean): unknown {
  let st = p.empty()
  for (const s of slices) {
    if (viaCodec) st = decodeState(encodeState(st))
    p.fold(st, s)
  }
  return p.finish(st)
}

describe('the fixtures are the streams the tests claim', () => {
  test('several sessions, two harnesses, subagents, tools and several models', () => {
    expect(BY_SESSION.size).toBeGreaterThanOrEqual(8)
    const harnesses = new Set(EVENTS.filter(e => e.type === 'run.started').map(e => (e as AgentisticsEvent<'run.started'>).data.harness))
    expect([...harnesses].sort()).toEqual(['claude', 'codex'])
    expect(EVENTS.some(e => e.type === 'agent.started' && (e as AgentisticsEvent<'agent.started'>).data.kind !== 'main')).toBe(true)
    expect(EVENTS.filter(e => e.type === 'tool.requested').length).toBeGreaterThan(20)
  })

  test('loading twice gives the same stream in the same order (no dependence on directory listing)', async () => {
    const again = await fixtureEvents()
    expect(again.map(e => e.eventId)).toEqual(EVENTS.map(e => e.eventId))
  })
})

describe('P1 §8 properties, per projection, per key', () => {
  for (const [p, groups] of PROJECTIONS) {
    test(`${p.name}: every split point, through the state codec, equals folding whole`, () => {
      for (const [, evs] of groups) {
        const whole = project(p, evs)
        for (const cut of [1, Math.floor(evs.length / 3), Math.floor(evs.length / 2), evs.length - 1]) {
          if (cut <= 0 || cut >= evs.length) continue
          expect(foldSlices(p, [evs.slice(0, cut), evs.slice(cut)], true)).toEqual(whole)
        }
      }
    })

    test(`${p.name}: shuffled arrival order changes nothing`, () => {
      for (const [, evs] of groups) {
        const whole = project(p, evs)
        for (const seed of [1, 7, 42]) expect(project(p, shuffled(evs, seed))).toEqual(whole)
      }
    })

    test(`${p.name}: folding every event twice changes nothing (idempotent by eventId)`, () => {
      for (const [, evs] of groups) {
        const whole = project(p, evs)
        expect(foldSlices(p, [evs, evs, shuffled(evs, 3)], true)).toEqual(whole)
      }
    })
  }

  test('taskRollup: the same three properties over a task spanning several sessions', () => {
    const tagged = EVENTS.map(e => ({ ...e, taskId: 'task-A' }) as AnyAgentisticsEvent)
    const whole = project(taskRollupProjection, tagged)
    expect(whole.sessions).toBe(BY_SESSION.size)
    expect(foldSlices(taskRollupProjection, [tagged.slice(0, 100), tagged.slice(100)], true)).toEqual(whole)
    expect(project(taskRollupProjection, shuffled(tagged, 9))).toEqual(whole)
    expect(foldSlices(taskRollupProjection, [tagged, tagged], true)).toEqual(whole)
  })
})

describe('costByDimension', () => {
  test('its tokens sum EXACTLY to sessionMeta\'s main counters plus the measured agent rollup', () => {
    for (const [, evs] of BY_SESSION) {
      const facts = project(costByDimensionProjection, evs).facts
      const sm = project(sessionMetaProjection, evs).meta
      const factTokens = facts.reduce((n, f) => n + (f.tokens.input ?? 0) + (f.tokens.output ?? 0) + (f.tokens.cacheRead ?? 0) + (f.tokens.cacheWrite ?? 0), 0)
      const smTokens = sm.input_tokens + sm.output_tokens + (sm.cache_read_input_tokens ?? 0) + (sm.cache_creation_input_tokens ?? 0) + (sm.agentMetrics?.totalTokens ?? 0)
      expect(factTokens).toBe(smTokens)
    }
  })

  test('§37 "what did the subagents cost?": subagent cells sum to the agent rollup, the rest to the main agent', () => {
    let withSubagents = 0
    for (const [, evs] of BY_SESSION) {
      const facts = project(costByDimensionProjection, evs).facts
      const sm = project(sessionMetaProjection, evs).meta
      const sum = (fs: typeof facts) => fs.reduce((n, f) => n + (f.tokens.input ?? 0) + (f.tokens.output ?? 0) + (f.tokens.cacheRead ?? 0) + (f.tokens.cacheWrite ?? 0), 0)
      const sub = facts.filter(f => f.subagent)
      if (sub.length > 0) withSubagents++
      expect(sum(sub)).toBe(sm.agentMetrics?.totalTokens ?? 0)
      expect(sum(facts.filter(f => !f.subagent))).toBe(sm.input_tokens + sm.output_tokens + (sm.cache_read_input_tokens ?? 0) + (sm.cache_creation_input_tokens ?? 0))
      for (const f of facts) expect(f.agentId).not.toBeNull()
    }
    expect(withSubagents).toBeGreaterThanOrEqual(1)
  })

  test('each model is priced at ITS OWN rate by calcCost — on a one-model session that is the legacy price', () => {
    let singleModel = 0
    for (const [, evs] of BY_SESSION) {
      const r = project(costByDimensionProjection, evs)
      const models = new Set(r.facts.map(f => f.model))
      if (models.size !== 1 || evs.some(e => e.type === 'agent.started' && (e as AgentisticsEvent<'agent.started'>).data.kind !== 'main')) continue
      singleModel++
      const sm = project(sessionMetaProjection, evs)
      const sum = r.facts.reduce((n, f) => n + (f.costUSD ?? 0), 0)
      expect(sum).toBeCloseTo(sm.costUSD ?? NaN, 9)
      expect(r.facts.every(f => f.costSource === 'table')).toBe(true)
    }
    expect(singleModel).toBeGreaterThanOrEqual(3)
  })

  test('every fact carries its UTC day, its harness and the "no linked repository" bucket as a real value', () => {
    for (const [, evs] of BY_SESSION) {
      for (const f of project(costByDimensionProjection, evs).facts) {
        expect(f.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(['claude', 'codex']).toContain(f.harness)
        expect(f.repo).toBe('')
        // Codex reports no cache-WRITE counter at all (D21): absent from the sum and named as partial,
        // never a 0. Claude reports all four.
        if (f.harness === 'claude') expect(f.partialCounters).toEqual([])
        else {
          expect(f.partialCounters).toContain('cacheWrite')
          expect('cacheWrite' in f.tokens).toBe(false)
        }
      }
    }
  })

  const base = (over: Partial<AgentisticsEvent<'model.completed'>['data']>, id: string, conf: Confidence = 'exact'): AnyAgentisticsEvent => ({
    eventId: id, schema: 1, type: 'model.completed', occurredAt: '2026-09-01T10:00:00.000Z', recordedAt: '2026-09-01T10:00:00.000Z',
    sessionId: 'ses_x', runId: 'run_x', agentId: 'agt_x',
    source: { kind: 'harness', id: 'claude' },
    provenance: { mode: 'replayed', confidence: conf, adapterVersion: '1.5.0', sourceRef: `x:${id.length}` },
    data: { provider: 'anthropic', model: 'claude-opus-5', usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, status: 'completed', ...over },
  }) as AnyAgentisticsEvent
  const runStarted: AnyAgentisticsEvent = {
    eventId: 'rs', schema: 1, type: 'run.started', occurredAt: '2026-09-01T09:00:00.000Z', recordedAt: '2026-09-01T09:00:00.000Z',
    sessionId: 'ses_x', runId: 'run_x', source: { kind: 'harness', id: 'claude' },
    provenance: { mode: 'replayed', confidence: 'exact', adapterVersion: '1.5.0', sourceRef: 'x:0' },
    data: { harness: 'claude', conversationLink: 'observed' },
  } as AnyAgentisticsEvent

  test('D21: a counter no response reported is ABSENT, and one some response left out is named partial', () => {
    const r = project(costByDimensionProjection, [runStarted,
      base({ usage: { input: 5, output: 6 } }, 'a1'),
      base({ usage: { input: 1, output: 2, cacheRead: 3 } }, 'a2'),
    ])
    expect(r.facts).toHaveLength(1)
    expect(r.facts[0]!.tokens).toEqual({ input: 6, output: 8, cacheRead: 3 })
    expect('cacheWrite' in r.facts[0]!.tokens).toBe(false)
    expect(r.facts[0]!.partialCounters).toEqual(['cacheRead', 'cacheWrite'])
  })

  test('§41: a stated cost is used as stated; a mix of stated and table is "mixed"; a local model is never priced', () => {
    const stated = project(costByDimensionProjection, [runStarted, base({ costUSD: 0.5, costSource: 'provider' }, 'b1')])
    expect(stated.facts[0]!.costUSD).toBe(0.5)
    expect(stated.facts[0]!.costSource).toBe('provider')

    const mixed = project(costByDimensionProjection, [runStarted, base({ costUSD: 0.5, costSource: 'harness' }, 'c1'), base({}, 'c2')])
    const tableHalf = calcCost({ inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, webSearchRequests: 0, costUSD: 0 }, 'claude-opus-5')
    expect(mixed.facts[0]!.costSource).toBe('mixed')
    expect(mixed.facts[0]!.costUSD).toBeCloseTo(0.5 + tableHalf, 12)

    const local = project(costByDimensionProjection, [runStarted, base({ provider: 'openai-compatible', model: 'ollama/llama3' }, 'd1')])
    expect(local.facts[0]!.costUSD).toBeNull()
    expect(local.facts[0]!.costSource).toBeNull()
  })

  test('D20: the model that PRICES a response is modelServed when the provider named one', () => {
    const r = project(costByDimensionProjection, [runStarted, base({ model: 'claude-opus-5', modelServed: 'claude-haiku-4-5-20251001' }, 'e1')])
    expect(r.facts[0]!.model).toBe('claude-haiku-4-5-20251001')
  })

  test('D17: the fact is as certain as its WEAKEST event — a response or the lifecycle that attributed it', () => {
    const one = project(costByDimensionProjection, [runStarted, base({}, 'f1'), base({}, 'f2', 'estimated')])
    expect(one.facts[0]!.confidence).toBe('estimated')
    const inferredRun = { ...runStarted, provenance: { ...runStarted.provenance, confidence: 'inferred' as const } } as AnyAgentisticsEvent
    const two = project(costByDimensionProjection, [inferredRun, base({}, 'g1')])
    expect(two.facts[0]!.confidence).toBe('inferred')
  })

  test('a session whose harness nobody named is WITHHELD with a reason, never filed under a guess', () => {
    const noRun = [{ ...base({}, 'h1'), source: { kind: 'runtime', id: 'agentistics' } } as AnyAgentisticsEvent]
    const r = project(costByDimensionProjection, noRun)
    expect(r.facts).toEqual([])
    expect(r.withheld?.responses).toBe(1)
  })

  test('the native runtime is a RunHarness: its run.started names it and its facts are filed under it', () => {
    const nativeRun = { ...runStarted, data: { harness: 'agentistics', conversationLink: 'assigned' } } as AnyAgentisticsEvent
    const r = project(costByDimensionProjection, [nativeRun, { ...base({}, 'n1'), source: { kind: 'runtime', id: 'agentistics' } } as AnyAgentisticsEvent])
    expect(r.facts).toHaveLength(1)
    expect(r.facts[0]!.harness).toBe('agentistics')
    expect(project(runMetricsProjection, [nativeRun]).fact!.harness).toBe('agentistics')
  })
})

describe('runMetrics / toolMetrics / agentMetrics', () => {
  test('runMetrics reads turns, active time, model and unmeasured agents OFF sessionMeta — never a second rule', () => {
    for (const [, evs] of BY_RUN) {
      const fact = project(runMetricsProjection, evs).fact!
      const sm = project(sessionMetaProjection, evs).meta
      expect(fact.messages).toBe(sm.user_message_count ?? null)
      expect(fact.activeMinutes).toBe(sm.active_minutes ?? null)
      expect(fact.model).toBe(sm.model ?? null)
      expect(fact.unmeasuredAgents).toBe(sm.agentMetrics?.unmeasuredInvocations ?? 0)
    }
  })

  test('tool DURATION: summed only over calls with both ends, and durationCalls says how many that is', () => {
    const claudeRun = [...BY_RUN.values()].find(evs => evs.some(e => e.type === 'tool.requested' && e.source.id === 'claude'))!
    const tools = project(toolMetricsProjection, claudeRun).tools
    const bash = tools.Bash!
    expect(bash.calls).toBeGreaterThan(0)
    expect(bash.durationCalls).toBeLessThanOrEqual(bash.calls)
    expect(bash.durationMs).not.toBeNull()
    expect(bash.maxDurationMs!).toBeLessThanOrEqual(bash.durationMs!)
    // A tool with calls but no measurable duration says null, never 0.
    for (const f of Object.values(tools)) if (f.durationCalls === 0) expect(f.durationMs).toBeNull()
  })

  test('tool duration prefers the harness\'s own measurement over the request→result wall time', () => {
    const mk = (type: string, id: string, at: string, data: object): AnyAgentisticsEvent => ({
      eventId: id, schema: 1, type, occurredAt: at, recordedAt: at, sessionId: 's', runId: 'r', agentId: 'a',
      source: { kind: 'harness', id: 'claude' }, provenance: { mode: 'replayed', confidence: 'exact', adapterVersion: '1.5.0' }, data,
    }) as AnyAgentisticsEvent
    const evs = [
      mk('tool.requested', 't1', '2026-01-01T00:00:00.000Z', { toolExecutionId: 'x', name: 'Bash', canonicalName: 'Bash', kind: 'shell' }),
      mk('tool.completed', 't2', '2026-01-01T00:00:10.000Z', { toolExecutionId: 'x', durationMs: 1234 }),
      mk('tool.requested', 't3', '2026-01-01T00:00:00.000Z', { toolExecutionId: 'y', name: 'Bash', canonicalName: 'Bash', kind: 'shell' }),
      mk('tool.failed', 't4', '2026-01-01T00:00:02.000Z', { toolExecutionId: 'y', status: 'failed' }),
      mk('tool.requested', 't5', '2026-01-01T00:00:00.000Z', { toolExecutionId: 'z', name: 'Bash', canonicalName: 'Bash', kind: 'shell' }),
    ]
    const f = project(toolMetricsProjection, evs).tools.Bash!
    expect(f).toMatchObject({ calls: 3, errors: 1, finished: 2, durationMs: 1234 + 2000, durationCalls: 2, maxDurationMs: 2000 })
  })

  test('agentMetrics: a harness that cannot produce agents says so (null + reason), never an empty rollup', () => {
    const codexRun = [...BY_RUN.values()].find(evs => evs.some(e => e.source.id === 'codex'))!
    const r = project(agentMetricsProjection, codexRun)
    expect(r.harness).toBe('codex')
    expect(r.agentMetrics).toBeNull()
    expect(r.reason).toContain('codex')
    const claudeRun = [...BY_RUN.values()].find(evs => evs.some(e => e.type === 'agent.started' && (e as AgentisticsEvent<'agent.started'>).data.kind !== 'main'))!
    const c = project(agentMetricsProjection, claudeRun)
    expect(c.agentMetrics!.totalInvocations).toBeGreaterThanOrEqual(3)
    expect(c.agentMetrics).toEqual(project(sessionMetaProjection, claudeRun).meta.agentMetrics!)
  })

  test('D17 on a run: one inferred event makes the whole RunFact inferred', () => {
    const evs = [...BY_RUN.values()][0]!
    expect(project(runMetricsProjection, evs).fact!.confidence).toBe('exact')
    const weak = evs.map((e, i) => (i === 3 ? { ...e, provenance: { ...e.provenance, confidence: 'inferred' } } : e) as AnyAgentisticsEvent)
    expect(project(runMetricsProjection, weak).fact!.confidence).toBe('inferred')
  })
})

describe('taskRollup (§41 costMeasured)', () => {
  test('rounds and active time are sessionMeta\'s, summed; table-priced sessions are ESTIMATED, not measured', () => {
    const tagged = EVENTS.map(e => ({ ...e, taskId: 'task-A' }) as AnyAgentisticsEvent)
    const r = project(taskRollupProjection, tagged)
    let rounds = 0
    for (const [, evs] of BY_SESSION) rounds += project(sessionMetaProjection, evs).meta.user_message_count ?? 0
    expect(r.rounds).toBe(rounds)
    expect(r.costMeasuredSessions).toBe(0)
    expect(r.costEstimatedSessions + r.costUnpricedSessions).toBeLessThanOrEqual(r.sessions)
    expect(r.costEstimatedSessions).toBeGreaterThan(0)
    const byHarness = Object.values(r.costByHarness!).reduce((a, b) => a + b, 0)
    expect(byHarness).toBeCloseTo(r.costUSD!, 9)
  })

  test('a session whose every response carries a STATED cost is measured', () => {
    const one = [...BY_SESSION.values()][0]!.map(e => {
      const t = { ...e, taskId: 'task-B' } as AnyAgentisticsEvent
      if (t.type === 'model.completed') return { ...t, data: { ...t.data, costUSD: 0.01, costSource: 'provider' } } as AnyAgentisticsEvent
      return t
    })
    const r = project(taskRollupProjection, one)
    expect(r.costMeasuredSessions).toBe(1)
    expect(r.costEstimatedSessions).toBe(0)
  })

  test('a task nobody could price reports null cost, never zero', () => {
    const r = project(taskRollupProjection, [])
    expect(r.costUSD).toBeNull()
    expect(r.tokens).toBeNull()
    expect(r.rounds).toBeNull()
  })
})

describe('catalog', () => {
  test('six materialised projections, distinct table ids, each with its own version', () => {
    expect(STORED_PROJECTIONS.map(d => d.projection.name).sort()).toEqual(
      ['agent-metrics', 'cost-by-dimension', 'run-metrics', 'session-meta', 'task-rollup', 'tool-metrics'])
    expect(new Set(STORED_PROJECTIONS.map(d => d.id)).size).toBe(6)
    for (const d of STORED_PROJECTIONS) expect(Number.isInteger(d.projection.version)).toBe(true)
  })

  const meta = (over: Partial<StoredMeta> = {}): StoredMeta => ({ id: 'x', version: 1, cursor: 50, adapterVersions: { claude: '1.5.0' }, rebuilding: false, reason: null, ...over })

  test('planProjection: resume, version bump, adapter bump, interrupted rebuild, journal replaced, never built', () => {
    expect(planProjection(meta(), { version: 1 }, { claude: '1.5.0' })).toEqual({ mode: 'resume', from: 50 })
    const v = planProjection(meta(), { version: 2 }, { claude: '1.5.0' })
    expect(v).toMatchObject({ mode: 'rebuild', fresh: true, from: 0 })
    expect(v.mode === 'rebuild' && v.reason).toContain('1 → 2')
    const a = planProjection(meta(), { version: 1 }, { claude: '1.6.0' })
    expect(a.mode === 'rebuild' && a.reason).toContain('claude 1.5.0 → 1.6.0')
    expect(planProjection(meta(), { version: 1 }, null)).toEqual({ mode: 'resume', from: 50 })
    expect(planProjection(meta({ rebuilding: true, reason: 'why' }), { version: 1 }, { claude: '1.5.0' }))
      .toEqual({ mode: 'rebuild', fresh: false, from: 50, reason: 'why' })
    expect(planProjection(meta(), { version: 1 }, { claude: '1.5.0' }, 'first event differs')).toMatchObject({ mode: 'rebuild', fresh: true, from: 0 })
    expect(planProjection(undefined, { version: 1 }, null)).toMatchObject({ mode: 'rebuild', fresh: true, from: 0 })
  })
})
