import { describe, expect, test } from 'bun:test'
import type { AgentisticsEvent } from '@agentistics/core'
import { deriveEventId } from '@agentistics/core'
import { CLAUDE_ADAPTER_VERSION, mainContext, subagentContext } from './replay-core'
import { cloneTurnFold, emptyTurnFold, foldTurnEntry } from './replay-turns'

const ctx = mainContext('conv-1', '2026-09-26T00:00:00.000Z')
const subCtx = subagentContext('conv-1', 'agent-1', '2026-09-26T00:00:00.000Z')

const humanLine = (content: unknown, ts?: string) => ({
  type: 'user', ...(ts ? { timestamp: ts } : {}), message: { role: 'user', content },
})

function run(
  entries: Record<string, unknown>[], role: 'main' | 'subagent' = 'main', c = ctx,
): AgentisticsEvent<'turn.started'>[] {
  const out: AgentisticsEvent<'turn.started'>[] = []
  const s = emptyTurnFold()
  entries.forEach((e, i) => foldTurnEntry(s, c, role, e, i + 1, ev => out.push(ev as AgentisticsEvent<'turn.started'>)))
  return out
}

describe('turn.started from human user lines (D22)', () => {
  test('a plain human prompt, string content, becomes a turn', () => {
    expect(run([humanLine('fix the bug', '2026-09-26T01:00:00.000Z')])).toHaveLength(1)
  })

  test('a human prompt with array text content becomes a turn', () => {
    expect(run([humanLine([{ type: 'text', text: 'fix the bug' }], '2026-09-26T01:00:00.000Z')])).toHaveLength(1)
  })

  test('a pure tool_result user line is never a turn', () => {
    const line = humanLine([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }], '2026-09-26T01:00:00.000Z')
    expect(run([line])).toEqual([])
  })

  test('an isMeta user line is never a turn', () => {
    const line = { ...humanLine('<local-command-caveat>x</local-command-caveat>', '2026-09-26T01:00:00.000Z'), isMeta: true }
    expect(run([line])).toEqual([])
  })

  test('an isCompactSummary user line is never a turn', () => {
    const line = { ...humanLine('This session is being continued…', '2026-09-26T01:00:00.000Z'), isCompactSummary: true }
    expect(run([line])).toEqual([])
  })

  test('a non-user line (assistant, system) is never a turn', () => {
    expect(run([{ type: 'assistant', timestamp: '2026-09-26T01:00:00.000Z', message: { role: 'assistant', content: 'hi' } }]))
      .toEqual([])
    expect(run([{ type: 'system', subtype: 'turn_duration', timestamp: '2026-09-26T01:00:00.000Z', durationMs: 5 }]))
      .toEqual([])
  })

  test('role: subagent never emits, even for an otherwise-human line — legacy counts the main transcript only', () => {
    expect(run([humanLine('fix the bug', '2026-09-26T01:00:00.000Z')], 'subagent', subCtx)).toEqual([])
  })

  test('a timestamped line is exact; a line with no timestamp falls back to recordedAt and reads estimated', () => {
    const [withTs] = run([humanLine('fix the bug', '2026-09-26T01:02:03.000Z')])
    expect(withTs!.occurredAt).toBe('2026-09-26T01:02:03.000Z')
    expect(withTs!.provenance.confidence).toBe('exact')

    const [noTs] = run([humanLine('fix the bug')])
    expect(noTs!.occurredAt).toBe(ctx.recordedAt)
    expect(noTs!.provenance.confidence).toBe('estimated')
  })

  test('the data carries only { by: "user" } — no text, no size (D5)', () => {
    const [e] = run([humanLine('fix the bug', '2026-09-26T01:00:00.000Z')])
    expect(e!.data).toEqual({ by: 'user' })
  })

  test('the envelope: keyed on the line, stamped with the adapter, agent is the context\'s own', () => {
    const [e] = run([humanLine('fix the bug', '2026-09-26T01:02:03.000Z')])
    expect(e!.eventId).toBe(deriveEventId({
      sourceKind: 'harness', sourceId: 'claude', sourceRef: 'claude:conv-1:1', type: 'turn.started',
    }))
    expect(e!.provenance.adapterVersion).toBe(CLAUDE_ADAPTER_VERSION)
    expect(e!.provenance.sourceRef).toBe('claude:conv-1:1')
    expect(e!.recordedAt).toBe(ctx.recordedAt)
    expect(e!.agentId).toBe(ctx.agentId)
  })

  test('several human lines each get their own turn, keyed on their own line', () => {
    const events = run([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      humanLine([{ type: 'tool_result', tool_use_id: 't', content: 'x' }], '2026-09-26T01:00:01.000Z'),
      humanLine('second', '2026-09-26T01:00:02.000Z'),
    ])
    expect(events).toHaveLength(2)
    expect(events.map(e => e.provenance.sourceRef)).toEqual(['claude:conv-1:1', 'claude:conv-1:3'])
    expect(new Set(events.map(e => e.eventId)).size).toBe(2)
  })

  test('chunk independence: folding a clone mid-stream emits what one fold emits', () => {
    const entries = [
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      humanLine([{ type: 'tool_result', tool_use_id: 't', content: 'x' }], '2026-09-26T01:00:01.000Z'),
      humanLine('second'), // no timestamp
      { ...humanLine('meta', '2026-09-26T01:00:03.000Z'), isMeta: true },
      humanLine('third', '2026-09-26T01:00:04.000Z'),
    ]
    const whole = run(entries)
    for (let cut = 1; cut < entries.length; cut++) {
      const out: AgentisticsEvent[] = []
      let s = emptyTurnFold()
      entries.slice(0, cut).forEach((e, i) => foldTurnEntry(s, ctx, 'main', e, i + 1, ev => out.push(ev)))
      s = cloneTurnFold(s)
      entries.slice(cut).forEach((e, i) => foldTurnEntry(s, ctx, 'main', e, cut + i + 1, ev => out.push(ev)))
      expect(out.map(e => [e.eventId, e.data, e.provenance.confidence, e.occurredAt]))
        .toEqual(whole.map(e => [e.eventId, e.data, e.provenance.confidence, e.occurredAt]))
    }
  })

  test('a clone is independent of the state it was taken from (there is none to share, but the shape must hold)', () => {
    const s = emptyTurnFold()
    foldTurnEntry(s, ctx, 'main', humanLine('a', '2026-09-26T01:00:00.000Z'), 1, () => {})
    const c = cloneTurnFold(s)
    expect(c).toEqual(s)
    expect(c).not.toBe(s)
  })
})
