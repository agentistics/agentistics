import { describe, expect, test } from 'bun:test'
import {
  agentContext, agentIdOf, kimiEventId, lineRef, makeEvent, numOrUndef, runIdOf, sessionIdOf,
  stateRef, str, timeOf, toolExecutionIdOf, KIMI_ADAPTER_VERSION,
} from './replay-core'

describe('kimi replay-core', () => {
  test('entity ids are deterministic and derived from the harness record', () => {
    expect(sessionIdOf('abc')).toBe(sessionIdOf('abc'))
    expect(sessionIdOf('abc')).not.toBe(sessionIdOf('def'))
    expect(runIdOf('abc')).not.toBe(sessionIdOf('abc'))
    expect(agentIdOf('abc', 'main')).toBe(agentIdOf('abc', 'main'))
    expect(agentIdOf('abc', 'main')).not.toBe(agentIdOf('abc', 'worker'))
    expect(toolExecutionIdOf('abc', 'call_1')).toBe(toolExecutionIdOf('abc', 'call_1'))
    expect(toolExecutionIdOf('abc', 'call_1')).not.toBe(toolExecutionIdOf('abc', 'call_2'))
  })

  test('ids carry a type prefix', () => {
    expect(sessionIdOf('x')).toMatch(/^ses_/)
    expect(runIdOf('x')).toMatch(/^run_/)
    expect(agentIdOf('x', 'main')).toMatch(/^agt_/)
    expect(toolExecutionIdOf('x', 'y')).toMatch(/^tex_/)
  })

  test('kimiEventId is stable and distinguishes distinct source records', () => {
    const a = kimiEventId({ sourceKind: 'harness', sourceId: 'kimi', sourceRef: 'kimi:x/agents/main:1', type: 'tool.requested' })
    const b = kimiEventId({ sourceKind: 'harness', sourceId: 'kimi', sourceRef: 'kimi:x/agents/main:2', type: 'tool.requested' })
    expect(a).toBe(kimiEventId({ sourceKind: 'harness', sourceId: 'kimi', sourceRef: 'kimi:x/agents/main:1', type: 'tool.requested' }))
    expect(a).not.toBe(b)
    expect(a).toHaveLength(32)
  })

  test('lineRef and stateRef', () => {
    const ctx = agentContext('sess', 'main', '2026-01-01T00:00:00.000Z')
    expect(lineRef(ctx, 5)).toBe('kimi:sess/agents/main:5')
    expect(stateRef('sess')).toBe('kimi:sess/state')
  })

  test('makeEvent stamps the envelope, including adapterVersion and mode', () => {
    const ctx = agentContext('sess', 'main', '2026-01-01T00:00:00.000Z')
    const ev = makeEvent(ctx, 'session.started', { origin: 'adapter' }, {
      sourceRef: stateRef('sess'), occurredAt: '2025-01-01T00:00:00.000Z', confidence: 'exact', agentId: null,
    })
    expect(ev.provenance.adapterVersion).toBe(KIMI_ADAPTER_VERSION)
    expect(ev.provenance.mode).toBe('replayed')
    expect(ev.provenance.confidence).toBe('exact')
    expect(ev.source).toEqual({ kind: 'harness', id: 'kimi' })
    expect(ev.agentId).toBeUndefined()
    expect(ev.sessionId).toBe(ctx.sessionId)
    expect(ev.runId).toBe(ctx.runId)
  })

  test('makeEvent defaults agentId to the context agent when not overridden', () => {
    const ctx = agentContext('sess', 'worker', '2026-01-01T00:00:00.000Z')
    const ev = makeEvent(ctx, 'tool.requested',
      { toolExecutionId: toolExecutionIdOf('sess', 'call_1'), name: 'Bash', canonicalName: 'Bash', kind: 'shell' },
      { sourceRef: lineRef(ctx, 1), occurredAt: '2025-01-01T00:00:00.000Z', confidence: 'exact' },
    )
    expect(ev.agentId).toBe(ctx.agentId)
  })

  test('numOrUndef: absent, never a 0, for anything but a finite non-negative number', () => {
    expect(numOrUndef(5)).toBe(5)
    expect(numOrUndef(0)).toBe(0)
    expect(numOrUndef(-1)).toBeUndefined()
    expect(numOrUndef(NaN)).toBeUndefined()
    expect(numOrUndef(undefined)).toBeUndefined()
    expect(numOrUndef('5')).toBeUndefined()
  })

  test('str: a non-empty string, else undefined', () => {
    expect(str('x')).toBe('x')
    expect(str('')).toBeUndefined()
    expect(str(5)).toBeUndefined()
    expect(str(undefined)).toBeUndefined()
  })

  test('timeOf reads entry.time as an ISO instant, or is absent', () => {
    expect(timeOf({ time: 1700000000000 })).toBe(new Date(1700000000000).toISOString())
    expect(timeOf({ time: 0 })).toBeUndefined()
    expect(timeOf({ time: -1 })).toBeUndefined()
    expect(timeOf({})).toBeUndefined()
  })
})
