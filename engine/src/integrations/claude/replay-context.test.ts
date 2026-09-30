import { describe, expect, test } from 'bun:test'
import type { AgentisticsEvent } from '@agentistics/core'
import { deriveEventId } from '@agentistics/core'
import { CLAUDE_ADAPTER_VERSION, mainContext } from './replay-core'
import { cloneContextFold, emptyContextFold, foldContextEntry } from './replay-context'

const ctx = mainContext('conv-1', '2026-09-25T00:00:00.000Z')

const boundary = (meta: Record<string, unknown> | undefined, ts = '2026-09-25T01:00:00.000Z') => ({
  type: 'system', subtype: 'compact_boundary', timestamp: ts, version: '2.1.300',
  ...(meta ? { compactMetadata: meta } : {}),
})

function run(entries: Record<string, unknown>[]): AgentisticsEvent<'context.compacted'>[] {
  const out: AgentisticsEvent<'context.compacted'>[] = []
  const s = emptyContextFold()
  entries.forEach((e, i) => foldContextEntry(s, ctx, e, i + 1, ev => out.push(ev as AgentisticsEvent<'context.compacted'>)))
  return out
}

describe('context.compacted from compact_boundary lines', () => {
  test('the gate is foldCompactEntry\'s: a system compact_boundary WITH compactMetadata, nothing else', () => {
    expect(run([
      boundary(undefined),
      { type: 'system', subtype: 'turn_duration', compactMetadata: { durationMs: 5 } },
      { type: 'user', subtype: 'compact_boundary', compactMetadata: { durationMs: 5 } },
    ])).toEqual([])
    expect(run([boundary({ durationMs: 5 })])).toHaveLength(1)
  })

  test('droppedTokens is the INCREMENT over the running total, so the events sum to the largest total', () => {
    const ev = run([
      boundary({ cumulativeDroppedTokens: 954_238, durationMs: 100, trigger: 'auto' }),
      boundary({ cumulativeDroppedTokens: 1_910_306, durationMs: 200, trigger: 'manual' }),
      boundary({ cumulativeDroppedTokens: 4_785_215, durationMs: 300 }),
    ])
    expect(ev.map(e => e.data.droppedTokens)).toEqual([954_238, 956_068, 2_874_909])
    expect(ev.reduce((a, e) => a + (e.data.droppedTokens ?? 0), 0)).toBe(4_785_215)
    expect(ev.map(e => e.data.durationMs)).toEqual([100, 200, 300])
    expect(ev.map(e => e.data.trigger)).toEqual(['auto', 'manual', undefined])
    expect(ev.every(e => e.provenance.confidence === 'exact')).toBe(true)
  })

  test('an absent total is absent, never 0 — and the next increment, which may include it, is estimated', () => {
    const ev = run([
      boundary({ cumulativeDroppedTokens: 100 }),
      boundary({ durationMs: 7 }),
      boundary({ cumulativeDroppedTokens: 350 }),
    ])
    expect('droppedTokens' in ev[1]!.data).toBe(false)
    expect(ev[1]!.data.durationMs).toBe(7)
    expect(ev[2]!.data.droppedTokens).toBe(250)
    expect(ev.map(e => e.provenance.confidence)).toEqual(['exact', 'exact', 'estimated'])
  })

  test('a total that goes backwards yields 0, never a negative, and the maximum stands', () => {
    const ev = run([
      boundary({ cumulativeDroppedTokens: 500 }),
      boundary({ cumulativeDroppedTokens: 300 }),
      boundary({ cumulativeDroppedTokens: 800 }),
    ])
    expect(ev.map(e => e.data.droppedTokens)).toEqual([500, 0, 300])
  })

  test('an unknown trigger and junk numbers are dropped rather than copied', () => {
    const [e] = run([boundary({ trigger: 'sideways', durationMs: -1, cumulativeDroppedTokens: 'many' })])
    expect(e!.data).toEqual({})
  })

  test('the envelope: keyed on the line, stamped with the adapter, occurredAt from the record', () => {
    const [e] = run([boundary({ durationMs: 1 }, '2026-09-25T03:04:05.000Z')])
    expect(e!.eventId).toBe(deriveEventId({
      sourceKind: 'harness', sourceId: 'claude', sourceRef: 'claude:conv-1:1', type: 'context.compacted',
    }))
    expect(e!.provenance.adapterVersion).toBe(CLAUDE_ADAPTER_VERSION)
    expect(e!.provenance.sourceRef).toBe('claude:conv-1:1')
    expect(e!.occurredAt).toBe('2026-09-25T03:04:05.000Z')
    expect(e!.agentId).toBe(ctx.agentId)
  })

  test('chunk independence: folding a clone mid-stream emits what one fold emits', () => {
    const entries = [
      boundary({ cumulativeDroppedTokens: 100 }),
      boundary({ durationMs: 3 }),
      boundary({ cumulativeDroppedTokens: 400 }),
      boundary({ cumulativeDroppedTokens: 900 }),
    ]
    const whole = run(entries)
    for (let cut = 1; cut < entries.length; cut++) {
      const out: AgentisticsEvent[] = []
      let s = emptyContextFold()
      entries.slice(0, cut).forEach((e, i) => foldContextEntry(s, ctx, e, i + 1, ev => out.push(ev)))
      s = cloneContextFold(s)
      entries.slice(cut).forEach((e, i) => foldContextEntry(s, ctx, e, cut + i + 1, ev => out.push(ev)))
      expect(out.map(e => [e.eventId, e.data, e.provenance.confidence]))
        .toEqual(whole.map(e => [e.eventId, e.data, e.provenance.confidence]))
    }
  })

  test('a clone is independent of the state it was taken from', () => {
    const s = emptyContextFold()
    foldContextEntry(s, ctx, boundary({ cumulativeDroppedTokens: 10 }), 1, () => {})
    const c = cloneContextFold(s)
    foldContextEntry(c, ctx, boundary({}), 2, () => {})
    expect(s).toEqual({ maxDropped: 10, sawUnreported: false })
  })
})
