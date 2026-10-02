/**
 * projections/session-meta.ts — the rules a legacy-parity differential cannot carry here.
 *
 * The ORIGINAL version of this file (deleted by ES.4, `git show <parent-of-293f708a>:…`) opened with
 * a byte-for-byte parity section: fold the Claude replay fixtures' events and compare field by field
 * with `parseSessionJsonl`'s `SessionMeta` over the SAME real transcripts — plus a "turn time (D25)"
 * section that replayed tiny synthetic transcripts through `emptyClaudeReplay`/`foldClaudeReplay` and
 * compared against `emptyClaudeParse`/`finishClaudeSession` side by side. Both halves import
 * `../integrations/claude` (directly, or via `replay-core.ts`/`replay.ts`) and the real fixture
 * directories, and both are now FROZEN engine code absent from the public tree (CLAUDE.md "FROZEN
 * PATHS" — a public PR may not touch `packages/runtime`, the provider clients or the differentials).
 * A byte-for-byte comparison against the Claude integration's own replay genuinely belongs in the
 * engine repo, which owns that integration; it is not ported here.
 *
 * DROPPED, and why each belongs in the engine instead of a synthetic rewrite here:
 * - `describe('parity with the legacy SessionMeta over a real transcript structure', …)` — the whole
 *   point is "the projection equals the legacy parser over the SAME real transcript", which needs a
 *   real transcript on both sides.
 * - the first two tests of `describe('compactions', …)` — same reason, over `claude-replay-compact`.
 * - `describe('rules the fixture does not reach', …)` → `'the agent rollup…'`,
 *   `'FIXED (M-1): legacy now counts the LAST line…'`, `'an invocation whose usage never streamed
 *   differently…'` — these specifically assert the projection against `LEGACY` (the real fixture's
 *   `parseSessionJsonl` output) and `legacyFirstWinsGate`/`dedupeUsage` read straight off the
 *   fixture's raw subagent files.
 * - the `describe('turn time (D25) …', …)` block's trailing `both()`/`TRANSCRIPTS` section, which
 *   replays synthetic jsonl LINES through the real `emptyClaudeReplay`/`foldClaudeReplay` pair
 *   exactly to compare against `emptyClaudeParse`/`finishClaudeSession` — the comparison itself is
 *   the thing under test, and it needs the real replay.
 *
 * Everything below either never depended on the fixture (the "rules the fixture does not reach",
 * D21 and D25 describe blocks already built their own synthetic events) or depended only on a
 * REASONABLY SHAPED event stream, for which `synthetic-events.ts`'s hand-built stream — several
 * models, tool calls, a subagent, human turns — serves exactly as well as a real transcript for a
 * property test (chunk independence, order independence, idempotency; "no projected key is also
 * declared not projectable").
 */
import { describe, expect, test } from 'bun:test'
import {
  project,
  type AgentisticsEvent, type AnyAgentisticsEvent, type EventData, type EventType,
} from '@agentistics/core'
import { fixtureEvents, groupBy, shuffled } from './synthetic-events'
import {
  NOT_PROJECTABLE, PARTIAL_FIELDS, sessionMetaProjection, type SessionMetaProjection,
} from './session-meta'

// One rich synthetic session (two models, tool calls, a subagent, human turns) stands in for the
// real transcript the deleted parity section replayed — see the header for why that section is gone.
const ALL = await fixtureEvents()
const EVENTS = (await groupBy(ALL, e => e.sessionId ?? null)).get('ses_c3')!
const PROJ = project(sessionMetaProjection, EVENTS)

describe('session-meta over a synthetic multi-model, multi-tool, subagent session', () => {
  test('the stream is the shape it claims (a subagent, tools, several responses)', () => {
    expect(EVENTS.filter(e => e.type === 'model.completed').length).toBeGreaterThan(2)
    expect(PROJ.meta.agentMetrics!.invocations.length).toBeGreaterThanOrEqual(1)
  })

  test('what is NOT projected is said, and is absent', () => {
    const declared = new Set(NOT_PROJECTABLE.map(n => n.field))
    for (const k of Object.keys(PROJ.meta)) expect(declared.has(k)).toBe(false)
  })

  test('what the turn events cannot reach stays absent, each reason naming the fact or the decision', () => {
    const facts: Record<string, string> = {
      message_hours: 'decision D25',
      daily: 'every user- and assistant-role LINE',
    }
    for (const [f, fact] of Object.entries(facts)) {
      expect(f in PROJ.meta).toBe(false)
      expect(NOT_PROJECTABLE.find(x => x.field === f)?.reason).toContain(fact)
    }
    expect(NOT_PROJECTABLE.find(x => x.field === 'message_hours')!.reason).toContain('EVERY timestamped transcript line')
  })

  test('the turn-time pair (D25) is projectable on an adapter that records it', () => {
    for (const f of ['active_minutes', 'user_response_times']) {
      expect(NOT_PROJECTABLE.some(x => x.field === f)).toBe(false)
      expect(f in PROJ.meta).toBe(true)
    }
  })

  test('the turn counters are no longer declared absent', () => {
    for (const f of ['rounds', 'user_message_count', 'user_interruptions', 'user_message_timestamps']) {
      expect(NOT_PROJECTABLE.some(x => x.field === f)).toBe(false)
    }
  })

  test('every declared entry carries a reason, and partial fields are present in meta', () => {
    for (const n of [...NOT_PROJECTABLE, ...PARTIAL_FIELDS]) expect(n.reason.length).toBeGreaterThan(10)
    for (const n of PARTIAL_FIELDS) expect(n.field in PROJ.meta).toBe(true)
  })

  test('the projection carries no conversation text or text sizes', () => {
    for (const k of ['first_prompt', 'title', 'user_chars', 'assistant_chars']) expect(k in PROJ.meta).toBe(false)
  })
})

describe('P1 §8 properties', () => {
  const whole = (p: SessionMetaProjection): unknown => ({ ...p })

  test('chunk independence: split at every boundary, the same projection', () => {
    const expected = whole(PROJ)
    for (let i = 1; i < EVENTS.length; i += 3) {
      const s = sessionMetaProjection.empty()
      sessionMetaProjection.fold(s, EVENTS.slice(0, i))
      sessionMetaProjection.fold(s, EVENTS.slice(i))
      expect(whole(sessionMetaProjection.finish(s))).toEqual(expected)
    }
  })

  test('order independence: shuffled ingestion order, the same projection', () => {
    const expected = whole(PROJ)
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(whole(project(sessionMetaProjection, shuffled(EVENTS, seed)))).toEqual(expected)
    }
  })

  test('idempotency: the same stream folded twice (or interleaved with itself) changes nothing', () => {
    const expected = whole(PROJ)
    expect(whole(project(sessionMetaProjection, [...EVENTS, ...EVENTS]))).toEqual(expected)
    expect(whole(project(sessionMetaProjection, shuffled([...EVENTS, ...EVENTS], 9)))).toEqual(expected)
  })

  test('finish does not end the walk, and hands out nothing it will later mutate', () => {
    const cut = Math.max(1, Math.floor(EVENTS.length / 2))
    const s = sessionMetaProjection.empty()
    sessionMetaProjection.fold(s, EVENTS.slice(0, cut))
    const early = sessionMetaProjection.finish(s)
    const earlyJson = JSON.stringify(early)
    ;(early.meta.tool_counts as Record<string, number>).Bash = 999_999
    sessionMetaProjection.fold(s, EVENTS.slice(cut))
    expect(whole(sessionMetaProjection.finish(s))).toEqual(whole(PROJ))
    expect(JSON.stringify(sessionMetaProjection.finish(sessionMetaProjection.empty()))).not.toBe(earlyJson)
  })

  test('name and version are the contract\'s', () => {
    expect(sessionMetaProjection.name).toBe('session-meta')
    expect(sessionMetaProjection.version).toBe(2)
  })
})

// ---- synthetic events: the rules a real transcript does not happen to reach -------------------------

let seq = 0
const CONV = 'c'
const mainAgentIdOf = (c: string) => `agt_${c}_main`
const subagentIdOf = (c: string, s: string) => `agt_${c}_sub_${s}`
// High enough to clear every version gate in session-meta.ts (COMPACTION_SINCE / TURNS_SINCE /
// TURN_END_SINCE) by default; individual tests override `adapter` to probe the gates themselves.
const CURRENT_ADAPTER_VERSION = '9.9.9'

function ev<T extends EventType>(
  type: T, data: EventData[T],
  o: { agentId?: string | null; ref?: string; at?: string; adapter?: string } = {},
): AgentisticsEvent<T> {
  seq++
  const e: AgentisticsEvent<T> = {
    eventId: `e${String(seq).padStart(6, '0')}`,
    schema: 1, type,
    occurredAt: o.at ?? `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    recordedAt: '2026-09-25T00:00:00.000Z',
    source: { kind: 'harness', id: 'claude' },
    provenance: {
      mode: 'replayed', confidence: 'exact', adapterVersion: o.adapter ?? CURRENT_ADAPTER_VERSION,
      sourceRef: o.ref ?? `claude:${CONV}:${seq}`,
    },
    data,
  }
  if (o.agentId !== null) e.agentId = o.agentId ?? mainAgentIdOf(CONV)
  return e
}
const anyEv = (e: unknown) => e as AnyAgentisticsEvent

function syntheticSession(): AnyAgentisticsEvent[] {
  return [
    anyEv(ev('session.started', { origin: 'adapter', projectPath: '/p' }, { agentId: null, at: '2026-01-01T00:00:00.000Z' })),
    anyEv(ev('run.started', { harness: 'claude', conversationId: CONV, conversationLink: 'observed' }, { agentId: null })),
    anyEv(ev('agent.started', { kind: 'main' })),
  ]
}

function completed(agentId: string, model: string, usage: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>, at?: string) {
  return anyEv(ev('model.completed', {
    provider: 'anthropic', model, status: 'completed',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage },
  }, { agentId, ...(at ? { at } : {}) }))
}

describe('a subagent\'s compaction is not the session\'s', () => {
  test('a subagent context.compacted never counts toward the main agent\'s compact_count', () => {
    const sub = subagentIdOf(CONV, 'abc')
    const events = [
      ...syntheticSession(),
      ev('agent.started', { kind: 'subagent', parentAgentId: mainAgentIdOf(CONV) }, { agentId: sub, ref: 'r:meta' }),
      ev('context.compacted', { droppedTokens: 10 }, { agentId: sub, ref: 'r:7' }),
    ]
    const p = project(sessionMetaProjection, events)
    expect(p.meta.compact_count).toBe(0)
  })

  test('events replayed at an adapter below COMPACTION_SINCE record no compactions: ABSENT with a caveat, never 0', () => {
    const events = [...syntheticSession(), ev('context.compacted', { droppedTokens: 5 })]
      .map(e => ({ ...e, provenance: { ...e.provenance, adapterVersion: '1.0.0' } })) as AnyAgentisticsEvent[]
    const p = project(sessionMetaProjection, events)
    expect(p.meta.compact_count).toBeUndefined()
    expect(p.meta.compact_ms).toBeUndefined()
    expect(p.caveats.some(c => c.field === 'compact_count')).toBe(true)
  })
})

describe('rules a real transcript does not happen to reach', () => {
  const main = mainAgentIdOf(CONV)

  test('an interrupted call is not counted as a tool error, and the caveat says so', () => {
    const req = ev('tool.requested', { toolExecutionId: 'tex_1', name: 'Bash', canonicalName: 'Bash', kind: 'shell' })
    const bad = ev('tool.failed', { toolExecutionId: 'tex_1', status: 'failed' })
    const cut = ev('tool.requested', { toolExecutionId: 'tex_2', name: 'Read', canonicalName: 'Read', kind: 'file' })
    const cancelled = ev('tool.failed', { toolExecutionId: 'tex_2', status: 'cancelled' })
    const p = project(sessionMetaProjection, [...syntheticSession(), anyEv(req), anyEv(bad), anyEv(cut), anyEv(cancelled)])
    expect(p.meta.tool_errors).toBe(1)
    expect(p.meta.tool_error_categories).toEqual({ Bash: 1 })
    expect(p.caveats.find(c => c.field === 'tool_errors')?.reason).toContain('1 interrupted')
  })

  test('a failure whose request was never seen is filed under `unknown`, as legacy does', () => {
    const p = project(sessionMetaProjection, [
      ...syntheticSession(), anyEv(ev('tool.failed', { toolExecutionId: 'tex_x', status: 'failed' })),
    ])
    expect(p.meta.tool_error_categories).toEqual({ unknown: 1 })
  })

  test('an unmeasured invocation is in the count and OUT of the totals', () => {
    const sub1 = subagentIdOf(CONV, 'a'), sub2 = subagentIdOf(CONV, 'b')
    const p = project(sessionMetaProjection, [
      ...syntheticSession(),
      anyEv(ev('agent.started', { kind: 'subagent', parentAgentId: main, agentType: 'x' }, { agentId: sub1, ref: 'r:meta' })),
      anyEv(ev('agent.started', { kind: 'subagent', parentAgentId: main, agentType: 'y' }, { agentId: sub2, ref: 'r:meta' })),
      anyEv(ev('agent.ended', { status: 'unmeasured' }, { agentId: sub2, ref: 'r:meta' })),
      completed(sub1, 'claude-haiku-4-5', { input: 100, output: 50 }),
      anyEv(ev('agent.ended', { status: 'completed' }, { agentId: sub1 })),
    ])
    const m = p.meta.agentMetrics!
    expect(m.totalInvocations).toBe(2)
    expect(m.unmeasuredInvocations).toBe(1)
    expect(m.totalTokens).toBe(150)
    const un = m.invocations.find(i => i.status === 'unmeasured')!
    expect(un.unmeasured).toBe(true)
    expect(un.totalTokens).toBe(0)
  })

  test('a nested subagent rolls into the invocation that spawned it, each model at its own rate', () => {
    const root = subagentIdOf(CONV, 'r'), child = subagentIdOf(CONV, 'k')
    const p = project(sessionMetaProjection, [
      ...syntheticSession(),
      anyEv(ev('agent.started', { kind: 'subagent', parentAgentId: main }, { agentId: root, ref: 'r:meta' })),
      anyEv(ev('agent.started', { kind: 'subagent', parentAgentId: root }, { agentId: child, ref: 'r:meta' })),
      completed(root, 'claude-opus-4-7', { input: 1_000_000 }),
      completed(child, 'claude-haiku-4-5', { input: 1_000_000 }),
    ])
    const m = p.meta.agentMetrics!
    expect(m.invocations.length).toBe(1)
    expect(m.invocations[0]!.inputTokens).toBe(2_000_000)
    // opus and haiku differ in price, so a single-rate answer would not equal the sum of the two
    const opus = project(sessionMetaProjection, [...syntheticSession(),
      anyEv(ev('agent.started', { kind: 'subagent', parentAgentId: main }, { agentId: root, ref: 'r:meta' })),
      completed(root, 'claude-opus-4-7', { input: 1_000_000 })]).meta.agentMetrics!.totalCostUSD
    const haiku = project(sessionMetaProjection, [...syntheticSession(),
      anyEv(ev('agent.started', { kind: 'subagent', parentAgentId: main }, { agentId: root, ref: 'r:meta' })),
      completed(root, 'claude-haiku-4-5', { input: 1_000_000 })]).meta.agentMetrics!.totalCostUSD
    expect(m.totalCostUSD).toBeCloseTo(opus + haiku, 9)
  })

  test('no model means no price: null, never a zero', () => {
    expect(project(sessionMetaProjection, syntheticSession()).costUSD).toBeNull()
  })

  test('the gauge is the LATEST response by source ordinal, whatever the arrival order', () => {
    const a = anyEv(ev('model.completed', { provider: 'anthropic', model: 'claude-opus-4-7', status: 'completed', contextTokens: 100,
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, { ref: 'claude:c:10' }))
    const b = anyEv(ev('model.completed', { provider: 'anthropic', model: 'claude-opus-4-7', status: 'completed', contextTokens: 900,
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, { ref: 'claude:c:20' }))
    const c = anyEv(ev('model.completed', { provider: 'anthropic', model: 'claude-opus-4-7', status: 'completed',
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, { ref: 'claude:c:30' }))
    for (const order of [[a, b, c], [c, b, a], [b, c, a]]) {
      expect(project(sessionMetaProjection, [...syntheticSession(), ...order]).meta.context_tokens).toBe(900)
    }
  })

  test('a session still open reports no end and says so', () => {
    const p = project(sessionMetaProjection, syntheticSession())
    expect(p.meta.end_time).toBeUndefined()
    expect(p.meta.duration_minutes).toBeUndefined()
    expect(p.caveats.some(c => c.field === 'end_time')).toBe(true)
  })

  test('human turns: counted, ordered by source line, interruptions = count - 1, rounds = count', () => {
    const at = (n: number) => `2026-01-01T00:0${n}:00.000Z`
    const t = (n: number, line: number) => anyEv(ev('turn.started', { by: 'user' }, { at: at(n), ref: `claude:c:${line}`, adapter: '1.3.0' }))
    const base = syntheticSession().map(e => ({ ...e, provenance: { ...e.provenance, adapterVersion: '1.3.0' } })) as AnyAgentisticsEvent[]
    const turns = [t(1, 5), t(4, 30), t(2, 12)]
    for (const order of [turns, [...turns].reverse(), [turns[1]!, turns[0]!, turns[2]!]]) {
      const p = project(sessionMetaProjection, [...base, ...order, ...order])
      expect(p.meta.user_message_count).toBe(3)
      expect(p.meta.rounds).toBe(3)
      expect(p.meta.user_interruptions).toBe(2)
      expect(p.meta.user_message_timestamps).toEqual([at(1), at(2), at(4)])
    }
  })

  test('an unstamped human line is a turn but not a timestamp (the emitter marks it estimated)', () => {
    const base = syntheticSession().map(e => ({ ...e, provenance: { ...e.provenance, adapterVersion: '1.3.0' } })) as AnyAgentisticsEvent[]
    const stamped = anyEv(ev('turn.started', { by: 'user' }, { at: '2026-01-01T00:01:00.000Z', ref: 'claude:c:3', adapter: '1.3.0' }))
    const unstamped = ev('turn.started', { by: 'user' }, { at: '2026-09-25T00:00:00.000Z', ref: 'claude:c:9', adapter: '1.3.0' })
    unstamped.provenance.confidence = 'estimated'
    const p = project(sessionMetaProjection, [...base, stamped, anyEv(unstamped)])
    expect(p.meta.user_message_count).toBe(2)
    expect(p.meta.user_message_timestamps).toEqual(['2026-01-01T00:01:00.000Z'])
  })

  test('a subagent\'s turn is not the session\'s', () => {
    const sub = subagentIdOf(CONV, 'abc')
    const base = syntheticSession().map(e => ({ ...e, provenance: { ...e.provenance, adapterVersion: '1.3.0' } })) as AnyAgentisticsEvent[]
    const p = project(sessionMetaProjection, [
      ...base,
      anyEv(ev('agent.started', { kind: 'subagent', parentAgentId: mainAgentIdOf(CONV) }, { agentId: sub, ref: 'r:meta', adapter: '1.3.0' })),
      anyEv(ev('turn.started', { by: 'user' }, { agentId: sub, adapter: '1.3.0' })),
    ])
    expect(p.meta.user_message_count).toBe(0)
    expect(p.meta.user_interruptions).toBe(0)
    expect(p.meta.user_message_timestamps).toEqual([])
  })

  test('a walk that could see turns and saw none says 0 (a measurement), not absent', () => {
    const base = syntheticSession().map(e => ({ ...e, provenance: { ...e.provenance, adapterVersion: '1.3.0' } })) as AnyAgentisticsEvent[]
    const p = project(sessionMetaProjection, base)
    expect(p.meta.user_message_count).toBe(0)
    expect(p.meta.user_interruptions).toBe(0)
  })

  test('events replayed before turn.started (adapter < 1.3.0): turn fields ABSENT with a caveat, never 0', () => {
    const base = syntheticSession().map(e => ({ ...e, provenance: { ...e.provenance, adapterVersion: '1.2.0' } })) as AnyAgentisticsEvent[]
    const p = project(sessionMetaProjection, base)
    for (const f of ['user_message_count', 'rounds', 'user_interruptions', 'user_message_timestamps']) expect(f in p.meta).toBe(false)
    expect(p.caveats.some(c => c.field === 'user_message_count')).toBe(true)
    // one old event among new ones is enough: the walk cannot vouch that it saw every turn
    const mixed = [...base.slice(0, 2), ...syntheticSession().slice(2).map(e => ({ ...e, provenance: { ...e.provenance, adapterVersion: '1.3.0' } })) as AnyAgentisticsEvent[]]
    expect('user_message_count' in project(sessionMetaProjection, mixed).meta).toBe(false)
  })

  test('an empty walk projects zeros for counters and nothing else', () => {
    const p = project(sessionMetaProjection, [])
    expect(p.meta.input_tokens).toBe(0)
    expect(p.meta.agentMetrics).toBeUndefined()
    expect(p.meta.start_time).toBeUndefined()
    expect(p.costUSD).toBeNull()
  })
})

// ---- D21 (2026-09-26): an absent counter is never a 0, and a sum over one is never presented as
// measured. `completed()` above always fills the four counters (its own callers do not care about
// this rule), so these use `ev('model.completed', …)` directly to state usage exactly as a source
// would: only the counters it actually reported.
describe('D21 — an absent usage counter is never folded in as a 0, and a sum over one is PARTIAL', () => {
  const main = mainAgentIdOf(CONV)

  test('every event carrying all four counters projects exactly as before: no caveat at all', () => {
    const p = project(sessionMetaProjection, [
      ...syntheticSession(),
      completed(main, 'claude-opus-4-7', { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }),
    ])
    expect(p.meta.input_tokens).toBe(100)
    expect(p.meta.output_tokens).toBe(50)
    expect(p.meta.cache_read_input_tokens).toBe(10)
    expect(p.meta.cache_creation_input_tokens).toBe(5)
    // no D21 caveat anywhere (the session-still-open `end_time` caveat is unrelated — this
    // synthetic fixture never emits session.ended — and is left alone here)
    expect(p.caveats.filter(c => c.field !== 'end_time')).toEqual([])
  })

  test('a cacheWrite the source never reported: the other three sum exactly, cacheWrite sums to 0 '
    + 'from what WAS reported (never a folded-in 0 for the missing one), and both it and the cost '
    + 'are named as partial', () => {
    const p = project(sessionMetaProjection, [
      ...syntheticSession(),
      anyEv(ev('model.completed', {
        provider: 'anthropic', model: 'claude-opus-4-7', status: 'completed',
        usage: { input: 100, output: 50, cacheRead: 10 }, // cacheWrite: absent, not 0
      }, { agentId: main })),
    ])
    expect(p.meta.input_tokens).toBe(100)
    expect(p.meta.output_tokens).toBe(50)
    expect(p.meta.cache_read_input_tokens).toBe(10)
    expect(p.meta.cache_creation_input_tokens).toBe(0)
    const tokenCaveat = p.caveats.find(c => c.field === 'cache_creation_input_tokens')
    expect(tokenCaveat).toBeDefined()
    expect(tokenCaveat!.reason).toContain('cacheWrite')
    expect(tokenCaveat!.reason).toContain('PARTIAL')
    // only the affected field gets its own caveat — the three fully-reported counters do not
    expect(p.caveats.some(c => c.field === 'input_tokens')).toBe(false)
    expect(p.caveats.some(c => c.field === 'output_tokens')).toBe(false)
    expect(p.caveats.some(c => c.field === 'cache_read_input_tokens')).toBe(false)
    // the cost was priced from that same partial token set, and is flagged rather than presented as measured
    const costCaveat = p.caveats.find(c => c.field === 'costUSD')
    expect(costCaveat).toBeDefined()
    expect(costCaveat!.reason).toContain('cacheWrite')
    expect(costCaveat!.reason.toLowerCase()).toContain('estimate')
    expect(p.costUSD).not.toBeNull() // still the best estimate over what WAS reported — just flagged
  })

  test('usage {} — nothing was reported: the event contributes nothing, and all four are named absent', () => {
    const p = project(sessionMetaProjection, [
      ...syntheticSession(),
      anyEv(ev('model.completed', {
        provider: 'anthropic', model: 'claude-opus-4-7', status: 'completed', usage: {},
      }, { agentId: main })),
    ])
    expect(p.meta.input_tokens).toBe(0)
    expect(p.meta.output_tokens).toBe(0)
    expect(p.meta.cache_read_input_tokens).toBe(0)
    expect(p.meta.cache_creation_input_tokens).toBe(0)
    const fields = p.caveats.map(c => c.field)
    expect(fields).toContain('input_tokens')
    expect(fields).toContain('output_tokens')
    expect(fields).toContain('cache_read_input_tokens')
    expect(fields).toContain('cache_creation_input_tokens')
    expect(fields).toContain('costUSD')
  })

  test('an absent counter under a SUBAGENT marks that invocation partial, and leaves the session totals alone', () => {
    const sub = subagentIdOf(CONV, 'p')
    const p = project(sessionMetaProjection, [
      ...syntheticSession(),
      completed(main, 'claude-opus-4-7', { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }),
      anyEv(ev('agent.started', { kind: 'subagent', parentAgentId: main }, { agentId: sub, ref: 'r:meta' })),
      anyEv(ev('model.completed', {
        provider: 'anthropic', model: 'claude-haiku-4-5', status: 'completed',
        usage: { input: 7, output: 3 }, // cacheRead and cacheWrite: absent
      }, { agentId: sub })),
      anyEv(ev('agent.ended', { status: 'completed' }, { agentId: sub })),
    ])
    const inv = p.meta.agentMetrics!.invocations[0]!
    expect(inv.inputTokens).toBe(7)
    expect(inv.outputTokens).toBe(3)
    const c = p.caveats.find(x => x.field === `agentMetrics.invocations[${sub}]`)
    expect(c).toBeDefined()
    expect(c!.reason).toContain('cacheRead, cacheWrite')
    expect(c!.reason).toContain('PARTIAL')
    // the main agent reported all four: no session-level token or cost caveat
    expect(p.caveats.some(x => x.field === 'costUSD' || x.field.endsWith('_tokens'))).toBe(false)
  })
})

// ---- D25 (A2.8): turn closes. `active_minutes` through activeMinutesOf, `user_response_times`
// through legacy's own arithmetic — over synthetic events only. The original file ALSO compared this
// against `emptyClaudeParse`/`finishClaudeSession` and `emptyClaudeReplay`/`foldClaudeReplay` side by
// side over tiny synthetic jsonl transcripts; that comparison needs the real Claude replay
// (`../integrations/claude/replay`), which is FROZEN engine code — see the file header.
describe('turn time (D25) — active_minutes and user_response_times', () => {
  const T0 = Date.parse('2026-01-01T00:00:00.000Z')
  const iso = (min: number, sec = 0) => new Date(T0 + min * 60_000 + sec * 1000).toISOString()
  const start = (line: number, at: string, o: { prev?: string; estimated?: boolean; adapter?: string } = {}) => {
    const e = ev('turn.started', { by: 'user', ...(o.prev ? { previousAssistantAt: o.prev } : {}) },
      { at, ref: `claude:c:${line}`, ...(o.adapter ? { adapter: o.adapter } : {}) })
    if (o.estimated) e.provenance.confidence = 'estimated'
    return anyEv(e)
  }
  const lastLine = (line: number, at: string) =>
    anyEv(ev('turn.ended', { close: 'last-line' }, { at, ref: `claude:c:${line}` }))
  const measured = (line: number, at: string, durationMs: number) =>
    anyEv(ev('turn.ended', { close: 'measured', durationMs }, { at, ref: `claude:c:${line}` }))

  test('a measured close wins over the reconstruction', () => {
    const p = project(sessionMetaProjection, [...syntheticSession(), start(2, iso(0)), measured(5, iso(3), 10 * 60_000)])
    expect(p.meta.active_minutes).toBe(10)
  })

  test('several closes for one turn (a resumed transcript): the LAST one wins, whatever the arrival order', () => {
    const evs = [
      start(2, iso(0)), lastLine(4, iso(2)), lastLine(8, iso(7)),
      start(10, iso(20)), lastLine(12, iso(25)),
    ]
    for (const order of [evs, [...evs].reverse(), shuffled(evs, 3)]) {
      const p = project(sessionMetaProjection, [...syntheticSession(), ...order, ...order])
      expect(p.meta.active_minutes).toBe(7 + 5)
    }
    // A later measurement replaces an earlier finish-time close of the same turn.
    const p = project(sessionMetaProjection, [...syntheticSession(), start(2, iso(0)), lastLine(3, iso(2)), measured(6, iso(4), 5 * 60_000)])
    expect(p.meta.active_minutes).toBe(5)
  })

  test('an estimated turn.started neither opens nor closes a turn, and gives no response time', () => {
    const p = project(sessionMetaProjection, [
      ...syntheticSession(),
      start(2, iso(0)),
      start(5, '2026-09-25T00:00:00.000Z', { estimated: true, prev: iso(1) }),
      lastLine(7, iso(4)),
    ])
    expect(p.meta.active_minutes).toBe(4)
    expect(p.meta.user_response_times).toEqual([])
  })

  test('a close on the prompt\'s OWN line belongs to that prompt (the final close of a prompt that was the last timed line)', () => {
    const p = project(sessionMetaProjection, [
      ...syntheticSession(),
      start(2, iso(0)), lastLine(2, iso(0)), // the next prompt closed turn 1 at its own (only) timed line
      start(5, iso(3)), lastLine(5, iso(3)), // the final finish closed turn 2 at ITS own line
    ])
    expect(p.meta.active_minutes).toBe(0)
    expect(p.caveats.some(c => c.field === 'active_minutes')).toBe(false)
  })

  test('no prompt: 0 when the walk saw a timed line (legacy sawTime), absent when it saw none', () => {
    const timed = project(sessionMetaProjection, syntheticSession())
    expect(timed.meta.active_minutes).toBe(0)
    expect(timed.meta.user_response_times).toEqual([])
    const untimed = project(sessionMetaProjection, [completed(mainAgentIdOf(CONV), 'claude-sonnet-4-6', { input: 1 })])
    expect('active_minutes' in untimed.meta).toBe(false)
    expect(untimed.caveats.some(c => c.field === 'active_minutes')).toBe(false)
  })

  test('an open last turn (no turn.ended yet): active_minutes ABSENT with a caveat, never a partial sum', () => {
    const p = project(sessionMetaProjection, [...syntheticSession(), start(2, iso(0)), lastLine(4, iso(3)), start(6, iso(10), { prev: iso(9) })])
    expect('active_minutes' in p.meta).toBe(false)
    expect(p.caveats.find(c => c.field === 'active_minutes')!.reason).toContain('turn.ended')
    expect(p.meta.user_response_times).toEqual([60])
  })

  test('response times: legacy arithmetic, source order, [0, 3600) after rounding the delta, negatives dropped', () => {
    const p = project(sessionMetaProjection, [
      ...syntheticSession(),
      start(40, iso(100), { prev: iso(100, -10) }), // 10
      start(10, iso(0)), // no assistant line before it: nothing
      start(20, iso(70), { prev: iso(10) }), // exactly 3600: dropped
      start(30, iso(90, 0), { prev: iso(30, 0.4) }), // 3599.6 < 3600: kept, rounds to 3600
      start(35, iso(95), { prev: iso(96) }), // negative: dropped
      lastLine(41, iso(101)),
    ].map(e => ({ ...e })) as AnyAgentisticsEvent[])
    expect(p.meta.user_response_times).toEqual([3600, 10])
  })

  test('events replayed before turn.ended (adapter below TURN_END_SINCE): both ABSENT with a caveat each, never 0 or []', () => {
    const old = [...syntheticSession(), start(2, iso(0), { prev: iso(0, -5) })]
      .map(e => ({ ...e, provenance: { ...e.provenance, adapterVersion: '1.4.0' } })) as AnyAgentisticsEvent[]
    const p = project(sessionMetaProjection, old)
    for (const f of ['active_minutes', 'user_response_times']) {
      expect(f in p.meta).toBe(false)
      expect(p.caveats.find(c => c.field === f)!.reason).toContain('not recorded')
    }
    expect(p.meta.user_message_count).toBe(1) // the 1.3.0-and-above half (turn.started) is still there
    const mixed = [old[0]!, ...syntheticSession().slice(1), start(2, iso(0)), lastLine(3, iso(1))]
    expect('active_minutes' in project(sessionMetaProjection, mixed).meta).toBe(false)
  })
})
