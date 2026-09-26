/**
 * projections/session-meta.ts against the legacy walk over the SAME bytes — A2.2's redacted real
 * transcripts (`test/fixtures/claude-replay*`), replayed to events by the Claude integration and
 * projected here, then compared field by field with `parseSessionJsonl`'s `SessionMeta`.
 *
 * Equal, not close: a counter that differs is a bug on one side or the other. The properties of P1 §8
 * (chunk independence, idempotency, order independence) are checked over the same event stream.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sessionCostUSD,
  project,
  type AgentisticsEvent, type AnyAgentisticsEvent, type EventData, type EventType, type SessionMeta,
} from '@agentistics/core'
import { parseSessionJsonl } from '../jsonl'
import { countUsage, dedupeUsage } from '../usage-dedupe'
import { createClaudeReplay } from '../integrations/claude'
import { CLAUDE_ADAPTER_VERSION, mainAgentIdOf, subagentIdOf } from '../integrations/claude/replay-core'
import {
  NOT_PROJECTABLE, PARTIAL_FIELDS, sessionMetaProjection, type SessionMetaProjection,
} from './session-meta'

const FIXTURES = join(import.meta.dir, '../../test/fixtures')
const CONV = '00000000-0000-4000-8000-000000000001'
const CONV2 = '00000000-0000-4000-8000-000000000002'

async function replayOf(dir: string, conv: string): Promise<AnyAgentisticsEvent[]> {
  const projectsDir = join(FIXTURES, dir)
  const batch = await createClaudeReplay({ projectsDir, settledMs: 0 })
    .replay({ sessionId: conv, sourceRef: `claude:${conv}` }, null)
  return batch.events as AnyAgentisticsEvent[]
}

const legacyOf = (dir: string, conv: string): Promise<SessionMeta> =>
  parseSessionJsonl(join(FIXTURES, dir, 'proj', `${conv}.jsonl`), conv, '/x', 'jsonl')

const EVENTS = await replayOf('claude-replay', CONV)
const LEGACY = await legacyOf('claude-replay', CONV)
const PROJ = project(sessionMetaProjection, EVENTS)

// ---- a tiny deterministic shuffle: order independence must not depend on a lucky seed ---------------
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('parity with the legacy SessionMeta over a real transcript structure', () => {
  test('the fixture is the shape it claims (subagents, tools, several responses)', () => {
    expect(EVENTS.filter(e => e.type === 'model.completed').length).toBeGreaterThan(10)
    expect(PROJ.meta.agentMetrics!.invocations.length).toBeGreaterThanOrEqual(3)
  })

  test('the four token counters are EQUAL', () => {
    expect(PROJ.meta.input_tokens).toBe(LEGACY.input_tokens)
    expect(PROJ.meta.output_tokens).toBe(LEGACY.output_tokens)
    expect(PROJ.meta.cache_read_input_tokens).toBe(LEGACY.cache_read_input_tokens ?? 0)
    expect(PROJ.meta.cache_creation_input_tokens).toBe(LEGACY.cache_creation_input_tokens ?? 0)
  })

  test('the TTL split is both-or-neither, and equal when present', () => {
    expect(PROJ.meta.cache_creation_1h_input_tokens).toBe(LEGACY.cache_creation_1h_input_tokens)
    expect(PROJ.meta.cache_creation_5m_input_tokens).toBe(LEGACY.cache_creation_5m_input_tokens)
  })

  test('the context gauge is the LAST response\'s level, equal to legacy', () => {
    expect(PROJ.meta.context_tokens).toBe(LEGACY.context_tokens)
  })

  test('model, and cost priced through the same path — costSource is the table', () => {
    expect(PROJ.meta.model).toBe(LEGACY.model)
    expect(PROJ.costUSD).toBe(sessionCostUSD(LEGACY))
    expect(PROJ.costSource).toBe('table')
  })

  test('tool_counts by the harness\'s own name equal legacy; the derived flags follow', () => {
    expect(PROJ.meta.tool_counts).toEqual(LEGACY.tool_counts)
    expect(PROJ.meta.uses_task_agent).toBe(LEGACY.uses_task_agent)
    expect(PROJ.meta.uses_mcp).toBe(LEGACY.uses_mcp)
    expect(PROJ.meta.uses_web_search).toBe(LEGACY.uses_web_search)
    expect(PROJ.meta.uses_web_fetch).toBe(LEGACY.uses_web_fetch)
  })

  test('tool_errors and their categories equal legacy when nothing was interrupted', () => {
    const interrupted = PROJ.caveats.some(c => c.field === 'tool_errors')
    if (interrupted) return // stated, not compared: see the caveat test below
    expect(PROJ.meta.tool_errors).toBe(LEGACY.tool_errors)
    expect(PROJ.meta.tool_error_categories).toEqual(LEGACY.tool_error_categories)
  })

  test('start, end and duration equal legacy', () => {
    expect(PROJ.meta.start_time).toBe(LEGACY.start_time)
    expect(PROJ.meta.end_time).toBe(LEGACY.end_time)
    expect(PROJ.meta.duration_minutes).toBe(LEGACY.duration_minutes)
    expect(PROJ.meta.session_id).toBe(CONV)
    expect(PROJ.meta.harness).toBe('claude')
  })

  test('daily tokens equal legacy daily, per day and per counter', () => {
    const legacy = LEGACY.daily ?? {}
    const days = Object.keys(legacy).filter(d => {
      const u = legacy[d]!
      return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens > 0
    })
    expect(Object.keys(PROJ.meta.daily_tokens ?? {}).sort()).toEqual(days.sort())
    for (const d of days) {
      const u = legacy[d]!
      expect(PROJ.meta.daily_tokens![d]).toEqual({
        input: u.input_tokens, output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
      })
    }
  })

  test('the agent rollup: one row per top-level invocation, counts and shape equal legacy', () => {
    const legacy = LEGACY.agentMetrics!
    const rows = PROJ.meta.agentMetrics!
    expect(rows.totalInvocations).toBe(legacy.totalInvocations)
    expect(rows.unmeasuredInvocations).toBe(legacy.unmeasuredInvocations ?? 0)

    // Rows are paired by rank: same launches, same order of size (tokens differ only by the
    // EXPLAINED streamed-usage rule below, which cannot reorder these three).
    const mine = [...rows.invocations].sort((x, y) => x.totalTokens - y.totalTokens)
    const theirs = [...legacy.invocations].sort((x, y) => x.totalTokens - y.totalTokens)
    for (let i = 0; i < mine.length; i++) {
      const r = mine[i]!, l = theirs[i]!
      expect(r.agentType).toBe(l.agentType)
      expect(r.description ?? '').toBe(l.description ?? '')
      expect(r.unmeasured).toBe(l.unmeasured)
      expect(r.totalToolUseCount).toBe(l.totalToolUseCount)
      expect(r.toolStats.readCount).toBe(l.toolStats.readCount)
      expect(r.toolStats.searchCount).toBe(l.toolStats.searchCount)
      expect(r.toolStats.bashCount).toBe(l.toolStats.bashCount)
      expect(r.toolStats.editFileCount).toBe(l.toolStats.editFileCount)
      expect(r.toolStats.otherToolCount).toBe(l.toolStats.otherToolCount)
      // input and cache counters never change between a partial usage and the final one
      expect(r.inputTokens).toBe(l.inputTokens)
      expect(r.cacheReadTokens).toBe(l.cacheReadTokens)
      expect(r.cacheWriteTokens).toBe(l.cacheWriteTokens)
    }
  })

  /**
   * EXPLAINED DIFFERENCE (P1 §8, the §40 vocabulary) — subagent tokens.
   *
   * Claude Code streams a response as several lines that share one `message.id`, and in a SUBAGENT
   * transcript the first line carries a PARTIAL usage (measured in this fixture: output 5, then 276).
   * `usage-dedupe.ts` documents "the LAST record for an id wins" and warns that taking the first
   * "would silently under-report in exactly that case" — but `countUsage`, which `subagent-parse.ts`
   * and `jsonl.ts` call, returns true for the FIRST occurrence. The main fixture has no differing
   * repeats, so the main counters agree; the subagent ones do not. The replay (A2.2) follows the
   * documented rule, and so does this projection. The reference below is computed independently
   * from the raw files with `dedupeUsage`, which really is last-wins.
   */
  test('EXPLAINED: subagent tokens follow last-wins; legacy counts the first (partial) line', () => {
    const dir = join(FIXTURES, 'claude-replay/proj', CONV, 'subagents')
    let lastWins = 0
    let firstWins = 0
    for (const f of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
      const entries: { id?: unknown; usage?: Record<string, number> }[] = []
      const firstSeen = new Set<string>()
      for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
        if (!line.trim()) continue
        const e = JSON.parse(line) as { type?: string; message?: { id?: string; usage?: Record<string, number> } }
        if (e.type !== 'assistant' || !e.message?.usage) continue
        entries.push({ id: e.message.id, usage: e.message.usage })
        if (countUsage(e.message.id, firstSeen)) {
          const u = e.message.usage
          firstWins += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        }
      }
      const d = dedupeUsage(entries)
      lastWins += d.input_tokens! + d.output_tokens! + d.cache_read_input_tokens! + d.cache_creation_input_tokens!
    }
    const rows = PROJ.meta.agentMetrics!
    expect(rows.totalTokens).toBe(lastWins)
    expect(LEGACY.agentMetrics!.totalTokens).toBe(firstWins)
    expect(lastWins).toBeGreaterThan(firstWins) // the partial first line under-reports, never over
    expect(rows.totalTokens - LEGACY.agentMetrics!.totalTokens).toBe(lastWins - firstWins)
  })

  test('an invocation whose usage never streamed differently costs exactly what legacy says', () => {
    const same = PROJ.meta.agentMetrics!.invocations.find(i =>
      LEGACY.agentMetrics!.invocations.some(l => l.totalTokens === i.totalTokens))!
    const l = LEGACY.agentMetrics!.invocations.find(x => x.totalTokens === same.totalTokens)!
    expect(same.costUSD).toBeCloseTo(l.costUSD, 9)
  })

  test('the mains counters exclude the subagents\' (they are counted in the rollup, once)', () => {
    const sub = PROJ.meta.agentMetrics!.invocations.reduce((n, i) => n + i.totalTokens, 0)
    expect(sub).toBeGreaterThan(0)
    // legacy counts the main transcript only, and so does the projection
    expect(PROJ.meta.input_tokens).toBe(LEGACY.input_tokens)
  })
})

describe('compactions — the main agent only, and "not recorded" is never zero', () => {
  test('a compacting session equals legacy count, ms and dropped tokens', async () => {
    const events = await replayOf('claude-replay-compact', CONV2)
    const legacy = await legacyOf('claude-replay-compact', CONV2)
    const p = project(sessionMetaProjection, events)
    expect(legacy.compact_count).toBeGreaterThan(0)
    expect(p.meta.compact_count).toBe(legacy.compact_count!)
    expect(p.meta.compact_ms).toBe(legacy.compact_ms!)
    expect(p.meta.compact_dropped_tokens).toBe(legacy.compact_dropped_tokens)
  })

  test('a session that never compacted says 0 (a measurement), not absent', () => {
    expect(PROJ.meta.compact_count).toBe(LEGACY.compact_count!)
    expect(PROJ.meta.compact_count).toBe(0)
  })

  test('events replayed at adapter 1.0.0 record no compactions: ABSENT with a caveat, never 0', async () => {
    const events = await replayOf('claude-replay-compact', CONV2)
    const old = events.map(e => ({ ...e, provenance: { ...e.provenance, adapterVersion: '1.0.0' } })) as AnyAgentisticsEvent[]
    const p = project(sessionMetaProjection, old)
    expect(p.meta.compact_count).toBeUndefined()
    expect(p.meta.compact_ms).toBeUndefined()
    expect(p.caveats.some(c => c.field === 'compact_count')).toBe(true)
  })

  test('a subagent\'s compaction is not the session\'s', () => {
    const sub = subagentIdOf(CONV, 'abc')
    const events = [
      ...syntheticSession(),
      ev('agent.started', { kind: 'subagent', parentAgentId: mainAgentIdOf('c') }, { agentId: sub, ref: 'r:meta' }),
      ev('context.compacted', { droppedTokens: 10 }, { agentId: sub, ref: 'r:7' }),
    ]
    const p = project(sessionMetaProjection, events)
    expect(p.meta.compact_count).toBe(0)
  })
})

describe('what is NOT projected is said, and is absent', () => {
  test('no projected key is also declared not projectable', () => {
    const declared = new Set(NOT_PROJECTABLE.map(n => n.field))
    for (const k of Object.keys(PROJ.meta)) expect(declared.has(k)).toBe(false)
  })

  test('the human-turn fields are absent, each with the human-turn reason', () => {
    for (const f of ['user_message_count', 'user_response_times', 'message_hours', 'active_minutes', 'rounds']) {
      expect(f in PROJ.meta).toBe(false)
      const n = NOT_PROJECTABLE.find(x => x.field === f)
      expect(n?.reason).toContain('human-turn')
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
    for (let i = 1; i < EVENTS.length; i += 7) {
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
    const s = sessionMetaProjection.empty()
    sessionMetaProjection.fold(s, EVENTS.slice(0, 40))
    const early = sessionMetaProjection.finish(s)
    const earlyJson = JSON.stringify(early)
    ;(early.meta.tool_counts as Record<string, number>).Bash = 999_999
    sessionMetaProjection.fold(s, EVENTS.slice(40))
    expect(whole(sessionMetaProjection.finish(s))).toEqual(whole(PROJ))
    expect(JSON.stringify(sessionMetaProjection.finish(sessionMetaProjection.empty()))).not.toBe(earlyJson)
  })

  test('name and version are the contract\'s', () => {
    expect(sessionMetaProjection.name).toBe('session-meta')
    expect(sessionMetaProjection.version).toBe(1)
  })
})

// ---- synthetic events: the rules the fixture does not reach -----------------------------------------

let seq = 0
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
      mode: 'replayed', confidence: 'exact', adapterVersion: o.adapter ?? CLAUDE_ADAPTER_VERSION,
      sourceRef: o.ref ?? `claude:c:${seq}`,
    },
    data,
  }
  if (o.agentId !== null) e.agentId = o.agentId ?? mainAgentIdOf('c')
  return e
}
const anyEv = (e: unknown) => e as AnyAgentisticsEvent

function syntheticSession(): AnyAgentisticsEvent[] {
  return [
    anyEv(ev('session.started', { origin: 'adapter', projectPath: '/p' }, { agentId: null, at: '2026-01-01T00:00:00.000Z' })),
    anyEv(ev('run.started', { harness: 'claude', conversationId: 'c', conversationLink: 'observed' }, { agentId: null })),
    anyEv(ev('agent.started', { kind: 'main' })),
  ]
}

function completed(agentId: string, model: string, usage: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>, at?: string) {
  return anyEv(ev('model.completed', {
    provider: 'anthropic', model, status: 'completed',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage },
  }, { agentId, ...(at ? { at } : {}) }))
}

describe('rules the fixture does not reach', () => {
  const main = mainAgentIdOf('c')

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
    const sub1 = subagentIdOf('c', 'a'), sub2 = subagentIdOf('c', 'b')
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
    const root = subagentIdOf('c', 'r'), child = subagentIdOf('c', 'k')
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

  test('an empty walk projects zeros for counters and nothing else', () => {
    const p = project(sessionMetaProjection, [])
    expect(p.meta.input_tokens).toBe(0)
    expect(p.meta.agentMetrics).toBeUndefined()
    expect(p.meta.start_time).toBeUndefined()
    expect(p.costUSD).toBeNull()
  })
})
