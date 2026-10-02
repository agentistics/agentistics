/**
 * projections/synthetic-events.ts — TEST SUPPORT. A hand-built, deterministic canonical event
 * stream standing in for what `agentop journal import` would produce from real transcripts.
 *
 * This replaces the deleted `p3-fixture-events.ts`, which replayed the checked-in, redacted
 * Claude/Codex fixtures through `../integrations/claude` and `../integrations/codex` — both of
 * which are now FROZEN engine code and absent from the public tree (see CLAUDE.md "FROZEN PATHS").
 * A public test may not import an integration, so this module builds the same SHAPE of stream
 * directly from `@agentistics/core`'s canonical event vocabulary: several sessions, two harness
 * labels, subagents, tool calls and several models — with no IO and no dependency on any adapter.
 *
 * Anything that genuinely needs the REAL replay — e.g. a byte-for-byte parity check between a
 * projection and the legacy jsonl parser over one real transcript — belongs in the engine repo,
 * which owns the integrations. This module is for the P1 §8 property tests (chunk independence,
 * order independence, idempotency) and the P3 projection/store tests, none of which care whether
 * an event came from a real transcript or was built by hand — only that the STREAM is internally
 * consistent (every id resolves, every event is well-typed).
 */
import { CANONICAL_EVENT_SCHEMA, deriveEventId, type AgentisticsEvent, type AnyAgentisticsEvent, type EventData, type EventType } from '@agentistics/core'

function push<T extends EventType>(
  out: AnyAgentisticsEvent[],
  type: T,
  data: EventData[T],
  o: {
    occurredAt: string
    sourceRef: string
    harness: 'claude' | 'codex'
    adapterVersion: string
    sessionId?: string
    runId?: string
    agentId?: string
    taskId?: string
  },
): void {
  const e: AgentisticsEvent<T> = {
    eventId: deriveEventId({ sourceKind: 'harness', sourceId: o.harness, sourceRef: o.sourceRef, type, ordinal: 0 }),
    schema: CANONICAL_EVENT_SCHEMA,
    type,
    occurredAt: o.occurredAt,
    recordedAt: '2026-09-26T00:00:00.000Z',
    source: { kind: 'harness', id: o.harness, version: o.adapterVersion },
    provenance: { mode: 'replayed', confidence: 'exact', adapterVersion: o.adapterVersion, sourceRef: o.sourceRef },
    data,
  }
  if (o.sessionId !== undefined) e.sessionId = o.sessionId
  if (o.runId !== undefined) e.runId = o.runId
  if (o.agentId !== undefined) e.agentId = o.agentId
  if (o.taskId !== undefined) e.taskId = o.taskId
  out.push(e as unknown as AnyAgentisticsEvent)
}

const ADAPTER_VERSION: Record<'claude' | 'codex', string> = { claude: '1.5.0', codex: '1.0.0' }

interface SessionSpec {
  conv: string
  harness: 'claude' | 'codex'
  startMinute: number
  models: string[]
  tools: { name: string; kind: 'shell' | 'file' | 'search' }[]
  subagent: boolean
}

const SESSIONS: SessionSpec[] = [
  { conv: 'c1', harness: 'claude', startMinute: 0, models: ['claude-opus-4-7'], tools: [{ name: 'Bash', kind: 'shell' }, { name: 'Edit', kind: 'file' }], subagent: true },
  { conv: 'c2', harness: 'claude', startMinute: 20, models: ['claude-sonnet-4-6'], tools: [{ name: 'Read', kind: 'file' }], subagent: false },
  { conv: 'c3', harness: 'claude', startMinute: 40, models: ['claude-opus-4-7', 'claude-haiku-4-5'], tools: [{ name: 'Bash', kind: 'shell' }, { name: 'Grep', kind: 'search' }], subagent: true },
  { conv: 'c4', harness: 'claude', startMinute: 60, models: ['claude-sonnet-4-6'], tools: [{ name: 'Bash', kind: 'shell' }], subagent: false },
  { conv: 'c5', harness: 'claude', startMinute: 80, models: ['claude-haiku-4-5'], tools: [{ name: 'Edit', kind: 'file' }, { name: 'Bash', kind: 'shell' }], subagent: false },
  { conv: 'k1', harness: 'codex', startMinute: 100, models: ['gpt-5.3-codex'], tools: [{ name: 'shell', kind: 'shell' }], subagent: false },
  { conv: 'k2', harness: 'codex', startMinute: 120, models: ['gpt-5.3-codex'], tools: [{ name: 'shell', kind: 'shell' }, { name: 'apply_patch', kind: 'file' }], subagent: true },
  { conv: 'k3', harness: 'codex', startMinute: 140, models: ['gpt-5.3-codex'], tools: [{ name: 'read_file', kind: 'file' }], subagent: false },
]

const at = (baseMin: number, offsetSec: number): string =>
  new Date(Date.UTC(2026, 8, 25, 10, 0, 0, 0) + baseMin * 60_000 + offsetSec * 1000).toISOString()

function buildSession(spec: SessionSpec): AnyAgentisticsEvent[] {
  const out: AnyAgentisticsEvent[] = []
  const { conv, harness } = spec
  const sessionId = `ses_${conv}`
  const runId = `run_${conv}`
  const mainAgentId = `agt_${conv}_main`
  const adapterVersion = ADAPTER_VERSION[harness]
  const ref = (n: number) => `${harness}:${conv}:${n}`
  let t = 0
  const common = { harness, adapterVersion, sessionId, runId }

  push(out, 'session.started', { origin: 'adapter', projectPath: `/work/${conv}` }, { ...common, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
  push(out, 'run.started', { harness, conversationId: conv, conversationLink: 'observed' }, { ...common, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
  push(out, 'agent.started', { kind: 'main' }, { ...common, agentId: mainAgentId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
  push(out, 'turn.started', { by: 'user' }, { ...common, agentId: mainAgentId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })

  for (const model of spec.models) {
    push(out, 'model.invoked', { provider: harness === 'claude' ? 'anthropic' : 'openai', model }, { ...common, agentId: mainAgentId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
    for (const tool of spec.tools) {
      const tex = `tex_${conv}_${t}`
      push(out, 'tool.requested', { toolExecutionId: tex, name: tool.name, canonicalName: tool.name, kind: tool.kind }, { ...common, agentId: mainAgentId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
      push(out, 'tool.completed', { toolExecutionId: tex, durationMs: 120 }, { ...common, agentId: mainAgentId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
    }
    // Codex states no cache-write counter at all (D21): absent, never a 0. Claude states all four.
    const usage = harness === 'claude'
      ? { input: 1000 + t, output: 200 + t, cacheRead: 50, cacheWrite: 10 }
      : { input: 1000 + t, output: 200 + t, cacheRead: 50 }
    push(out, 'model.completed', {
      provider: harness === 'claude' ? 'anthropic' : 'openai', model, status: 'completed', usage,
    }, { ...common, agentId: mainAgentId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
  }

  if (spec.subagent) {
    const subId = `agt_${conv}_sub`
    push(out, 'agent.started', { kind: 'subagent', parentAgentId: mainAgentId, agentType: 'explore' }, { ...common, agentId: subId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
    const subUsage = harness === 'claude' ? { input: 300, output: 60, cacheRead: 0, cacheWrite: 0 } : { input: 300, output: 60, cacheRead: 0 }
    push(out, 'model.completed', {
      provider: harness === 'claude' ? 'anthropic' : 'openai', model: spec.models[0]!, status: 'completed',
      usage: subUsage,
    }, { ...common, agentId: subId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
    push(out, 'agent.ended', { status: 'completed' }, { ...common, agentId: subId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
  }

  push(out, 'turn.ended', { close: 'last-line' }, { ...common, agentId: mainAgentId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
  push(out, 'agent.ended', { status: 'completed' }, { ...common, agentId: mainAgentId, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
  push(out, 'run.ended', { status: 'completed' }, { ...common, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
  push(out, 'session.ended', {}, { ...common, occurredAt: at(spec.startMinute, t), sourceRef: ref(t++) })
  return out
}

/** Every event of the synthetic fixture, in a deterministic order — a drop-in for the old `fixtureEvents()`. */
export async function fixtureEvents(): Promise<AnyAgentisticsEvent[]> {
  const out: AnyAgentisticsEvent[] = []
  for (const spec of SESSIONS) out.push(...buildSession(spec))
  return out
}

/** A deterministic shuffle — order independence must not depend on a lucky seed. */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** Group events by a key function, dropping unkeyed ones. */
export function groupBy(events: readonly AnyAgentisticsEvent[], key: (e: AnyAgentisticsEvent) => string | null): Map<string, AnyAgentisticsEvent[]> {
  const m = new Map<string, AnyAgentisticsEvent[]>()
  for (const e of events) {
    const k = key(e)
    if (k === null) continue
    const g = m.get(k)
    if (g) g.push(e)
    else m.set(k, [e])
  }
  return m
}
