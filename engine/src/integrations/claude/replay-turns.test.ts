import { describe, expect, test } from 'bun:test'
import type { AgentisticsEvent } from '@agentistics/core'
import { deriveEventId } from '@agentistics/core'
import { CLAUDE_ADAPTER_VERSION, mainContext, subagentContext } from './replay-core'
import { cloneTurnFold, emptyTurnFold, finishTurnFold, foldTurnEntry, type TurnFoldState } from './replay-turns'

const ctx = mainContext('conv-1', '2026-09-26T00:00:00.000Z')
const subCtx = subagentContext('conv-1', 'agent-1', '2026-09-26T00:00:00.000Z')

const humanLine = (content: unknown, ts?: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', ...(ts !== undefined ? { timestamp: ts } : {}), message: { role: 'user', content }, ...extra,
})
const assistantLine = (ts?: string) => ({
  type: 'assistant', ...(ts !== undefined ? { timestamp: ts } : {}), message: { role: 'assistant', content: 'ok' },
})
const turnDurationLine = (ts: string | undefined, durationMs: unknown) => ({
  type: 'system', subtype: 'turn_duration', ...(ts !== undefined ? { timestamp: ts } : {}), durationMs,
})

/** Every event `foldTurnEntry` emits, in order — used by the D25 (turn.ended / previousAssistantAt) tests. */
function runAll(
  entries: Record<string, unknown>[], role: 'main' | 'subagent' = 'main', c = ctx,
): AgentisticsEvent[] {
  const out: AgentisticsEvent[] = []
  const s = emptyTurnFold()
  entries.forEach((e, i) => foldTurnEntry(s, c, role, e, i + 1, ev => out.push(ev)))
  return out
}

/** Only `turn.started` — what the original D22 tests asserted before `turn.ended` existed. */
function run(
  entries: Record<string, unknown>[], role: 'main' | 'subagent' = 'main', c = ctx,
): AgentisticsEvent<'turn.started'>[] {
  return runAll(entries, role, c).filter((e): e is AgentisticsEvent<'turn.started'> => e.type === 'turn.started')
}

/** Fold every entry, then finish (`final`). Returns every event across both. */
function runWithFinish(
  entries: Record<string, unknown>[], final: boolean, role: 'main' | 'subagent' = 'main', c = ctx,
): AgentisticsEvent[] {
  const out: AgentisticsEvent[] = []
  const s = emptyTurnFold()
  entries.forEach((e, i) => foldTurnEntry(s, c, role, e, i + 1, ev => out.push(ev)))
  finishTurnFold(s, c, role, final, ev => out.push(ev))
  return out
}

const ended = (events: AgentisticsEvent[]) =>
  events.filter((e): e is AgentisticsEvent<'turn.ended'> => e.type === 'turn.ended')

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

  test('the data carries only { by: "user" } — no text, no size (D5) — when nothing preceded it', () => {
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
      const outStarted = out.filter(e => e.type === 'turn.started')
      expect(outStarted.map(e => [e.eventId, e.data, e.provenance.confidence, e.occurredAt]))
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

describe('previousAssistantAt (D25) — legacy state.lastAssistantTs, never reset between turns', () => {
  test('absent when no assistant line ever preceded the prompt', () => {
    const [e] = run([humanLine('first', '2026-09-26T01:00:00.000Z')])
    expect(e!.data).toEqual({ by: 'user' })
    expect('previousAssistantAt' in e!.data).toBe(false)
  })

  test('present, and equal to the assistant line\'s own raw timestamp', () => {
    const [, e2] = run([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      assistantLine('2026-09-26T01:00:05.000Z'),
      humanLine('second', '2026-09-26T01:00:10.000Z'),
    ])
    expect(e2!.data).toEqual({ by: 'user', previousAssistantAt: '2026-09-26T01:00:05.000Z' })
  })

  test('a multi-line assistant response: previousAssistantAt is the LAST assistant line, not the first', () => {
    const [, e2] = run([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      assistantLine('2026-09-26T01:00:05.000Z'),
      assistantLine('2026-09-26T01:00:06.000Z'),
      assistantLine('2026-09-26T01:00:07.000Z'),
      humanLine('second', '2026-09-26T01:00:10.000Z'),
    ])
    expect((e2!.data as { previousAssistantAt?: string }).previousAssistantAt).toBe('2026-09-26T01:00:07.000Z')
  })

  test('never reset between turns: it is still the LAST assistant line seen, even across a closed turn', () => {
    const [, , e3] = run([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      assistantLine('2026-09-26T01:00:05.000Z'),
      humanLine('second', '2026-09-26T01:00:10.000Z'), // no assistant line answers this one
      humanLine('third', '2026-09-26T01:00:20.000Z'),
    ])
    expect((e3!.data as { previousAssistantAt?: string }).previousAssistantAt).toBe('2026-09-26T01:00:05.000Z')
  })

  test('an assistant line with a truthy but UNPARSEABLE timestamp still updates it (legacy is not gated on Date.parse here)', () => {
    const [, e2] = run([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      { type: 'assistant', timestamp: 'not-a-real-date', message: { role: 'assistant', content: 'ok' } },
      humanLine('second', '2026-09-26T01:00:10.000Z'),
    ])
    expect((e2!.data as { previousAssistantAt?: string }).previousAssistantAt).toBe('not-a-real-date')
  })

  test('it is set even on an ESTIMATED turn.started (no timestamp on the prompt itself)', () => {
    const [, e2] = run([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      assistantLine('2026-09-26T01:00:05.000Z'),
      humanLine('second'), // no timestamp on the prompt
    ])
    expect(e2!.provenance.confidence).toBe('estimated')
    expect((e2!.data as { previousAssistantAt?: string }).previousAssistantAt).toBe('2026-09-26T01:00:05.000Z')
  })
})

describe('turn.ended (D25) — mirrors activeTime.ts\'s foldActiveTime exactly', () => {
  test('a measured close: system/turn_duration on an OPEN turn emits close: "measured" with the duration', () => {
    const events = runAll([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      turnDurationLine('2026-09-26T01:00:05.000Z', 1500),
    ])
    const closes = ended(events)
    expect(closes).toHaveLength(1)
    expect(closes[0]!.data).toEqual({ close: 'measured', durationMs: 1500 })
    expect(closes[0]!.occurredAt).toBe('2026-09-26T01:00:05.000Z')
    expect(closes[0]!.provenance.sourceRef).toBe('claude:conv-1:2')
    expect(closes[0]!.provenance.confidence).toBe('exact')
  })

  test('a stray turn_duration with NO turn open emits nothing', () => {
    const events = runAll([turnDurationLine('2026-09-26T01:00:00.000Z', 500)])
    expect(ended(events)).toEqual([])
  })

  test('a NEGATIVE durationMs is an ordinary timed line — the turn stays open and closes later at last-line', () => {
    const events = runAll([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      turnDurationLine('2026-09-26T01:00:05.000Z', -50),
      humanLine('second', '2026-09-26T01:00:10.000Z'),
    ])
    const closes = ended(events)
    expect(closes).toHaveLength(1)
    expect(closes[0]!.data).toEqual({ close: 'last-line' })
    // Closed at the negative-duration line itself (the last TIMED line before "second"), not at
    // "first" and not at "second".
    expect(closes[0]!.occurredAt).toBe('2026-09-26T01:00:05.000Z')
    expect(closes[0]!.provenance.sourceRef).toBe('claude:conv-1:2')
  })

  test('a non-finite durationMs (NaN) is likewise an ordinary timed line, never a close', () => {
    const events = runAll([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      turnDurationLine('2026-09-26T01:00:05.000Z', NaN),
    ])
    expect(ended(events)).toEqual([])
  })

  test('a turn_duration line with a non-number durationMs is not a measurement at all, and never closes', () => {
    const events = runAll([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      turnDurationLine('2026-09-26T01:00:05.000Z', 'not-a-number'),
    ])
    expect(ended(events)).toEqual([])
  })

  test('a turn_duration line with NO timestamp is inert: neither closes nor moves the last-timed line', () => {
    const events = runAll([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      turnDurationLine(undefined, 1500),
      humanLine('second', '2026-09-26T01:00:10.000Z'),
    ])
    // The untimed turn_duration contributes nothing, so "first" closes at ITS OWN line (no
    // intervening timed line at all) via last-line, not via the untimed measurement.
    const closes = ended(events)
    expect(closes).toHaveLength(1)
    expect(closes[0]!.data).toEqual({ close: 'last-line' })
    expect(closes[0]!.occurredAt).toBe('2026-09-26T01:00:00.000Z')
    expect(closes[0]!.provenance.sourceRef).toBe('claude:conv-1:1')
  })

  test('last-line close: a later human prompt closes the still-open turn BEFORE its own turn.started', () => {
    const events = runAll([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      assistantLine('2026-09-26T01:00:05.000Z'),
      humanLine('second', '2026-09-26T01:00:10.000Z'),
    ])
    expect(events.map(e => e.type)).toEqual(['turn.started', 'turn.ended', 'turn.started'])
    const [, close] = events
    expect((close as AgentisticsEvent<'turn.ended'>).data).toEqual({ close: 'last-line' })
    expect(close!.occurredAt).toBe('2026-09-26T01:00:05.000Z') // the assistant line, not "second"
    expect(close!.provenance.sourceRef).toBe('claude:conv-1:2')
  })

  test('an UNTIMED human line mid-open-turn neither closes anything nor becomes the last-timed reference', () => {
    const events = runAll([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      assistantLine('2026-09-26T01:00:05.000Z'),
      humanLine('untimed-prompt'), // isHumanUserEntry true, but no timestamp
      humanLine('second', '2026-09-26T01:00:10.000Z'),
    ])
    // Three turn.started (first, untimed-prompt, second) and exactly ONE close, referring to the
    // assistant line — the untimed prompt is invisible to the close bookkeeping entirely.
    expect(events.filter(e => e.type === 'turn.started')).toHaveLength(3)
    const closes = ended(events)
    expect(closes).toHaveLength(1)
    expect(closes[0]!.occurredAt).toBe('2026-09-26T01:00:05.000Z')
    expect(closes[0]!.provenance.sourceRef).toBe('claude:conv-1:2')
  })

  test('role: subagent never emits turn.ended, mirroring turn.started', () => {
    const events = runAll([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      turnDurationLine('2026-09-26T01:00:05.000Z', 1000),
    ], 'subagent', subCtx)
    expect(events).toEqual([])
  })

  test('finish: an open turn at EOF closes with last-line, at the last timed line', () => {
    const events = runWithFinish([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      assistantLine('2026-09-26T01:00:05.000Z'),
    ], true)
    const closes = ended(events)
    expect(closes).toHaveLength(1)
    expect(closes[0]!.data).toEqual({ close: 'last-line' })
    expect(closes[0]!.occurredAt).toBe('2026-09-26T01:00:05.000Z')
    expect(closes[0]!.provenance.sourceRef).toBe('claude:conv-1:2')
  })

  test('finish with final: false emits nothing, even with a turn open', () => {
    const events = runWithFinish([humanLine('first', '2026-09-26T01:00:00.000Z')], false)
    expect(ended(events)).toEqual([])
  })

  test('finish with no turn ever opened emits nothing', () => {
    const events = runWithFinish([assistantLine('2026-09-26T01:00:00.000Z')], true)
    expect(ended(events)).toEqual([])
  })

  test('finish is idempotent: a second final finish with nothing new folded emits nothing more', () => {
    const s = emptyTurnFold()
    const out: AgentisticsEvent[] = []
    foldTurnEntry(s, ctx, 'main', humanLine('first', '2026-09-26T01:00:00.000Z'), 1, ev => out.push(ev))
    finishTurnFold(s, ctx, 'main', true, ev => out.push(ev))
    finishTurnFold(s, ctx, 'main', true, ev => out.push(ev))
    expect(ended(out)).toHaveLength(1)
    // The turn is NOT marked closed in state — turnOpen stays true, so a resumed transcript's next
    // prompt (or next finish) can still close it correctly.
    expect(s.turnOpen).toBe(true)
  })

  test('finish after MORE lines were folded closes AGAIN, at the new true end (a resumed live transcript)', () => {
    const s = emptyTurnFold()
    const out: AgentisticsEvent[] = []
    foldTurnEntry(s, ctx, 'main', humanLine('first', '2026-09-26T01:00:00.000Z'), 1, ev => out.push(ev))
    finishTurnFold(s, ctx, 'main', true, ev => out.push(ev))
    foldTurnEntry(s, ctx, 'main', assistantLine('2026-09-26T01:00:05.000Z'), 2, ev => out.push(ev))
    finishTurnFold(s, ctx, 'main', true, ev => out.push(ev))

    const closes = ended(out)
    expect(closes).toHaveLength(2)
    expect(closes[0]!.occurredAt).toBe('2026-09-26T01:00:00.000Z')
    expect(closes[0]!.provenance.sourceRef).toBe('claude:conv-1:1')
    expect(closes[1]!.occurredAt).toBe('2026-09-26T01:00:05.000Z')
    expect(closes[1]!.provenance.sourceRef).toBe('claude:conv-1:2')
    // Two DIFFERENT lines never collide on an id, and re-emitting the SAME line is stable —
    // verified by construction (sourceRef+type keys the id) but pinned here too.
    expect(closes[0]!.eventId).not.toBe(closes[1]!.eventId)
  })

  test('a re-fold of the exact same line is a stable id (resumed-from-a-cursor safety)', () => {
    const line = turnDurationLine('2026-09-26T01:00:05.000Z', 1500)
    const first = runAll([humanLine('first', '2026-09-26T01:00:00.000Z'), line])
    const second = runAll([humanLine('first', '2026-09-26T01:00:00.000Z'), line])
    expect(ended(first)[0]!.eventId).toBe(ended(second)[0]!.eventId)
  })

  test('the envelope: no forbidden fields, only close/durationMs (D5)', () => {
    const [, close] = runAll([
      humanLine('first', '2026-09-26T01:00:00.000Z'),
      turnDurationLine('2026-09-26T01:00:05.000Z', 1500),
    ])
    expect(Object.keys(close!.data).sort()).toEqual(['close', 'durationMs'])
    expect(close!.provenance.adapterVersion).toBe(CLAUDE_ADAPTER_VERSION)
    expect(close!.agentId).toBe(ctx.agentId)
  })
})

describe('chunk independence over a full open/measured/last-line/finish scenario', () => {
  const entries: Record<string, unknown>[] = [
    humanLine('first', '2026-09-26T01:00:00.000Z'),
    assistantLine('2026-09-26T01:00:01.000Z'),
    assistantLine('2026-09-26T01:00:02.000Z'),
    turnDurationLine('2026-09-26T01:00:03.000Z', 3000), // measured close of "first"
    turnDurationLine('2026-09-26T01:00:04.000Z', 10), // stray, no open turn
    humanLine('second', '2026-09-26T01:00:05.000Z'),
    assistantLine('2026-09-26T01:00:06.000Z'),
    turnDurationLine('2026-09-26T01:00:07.000Z', -5), // negative: stays open
    humanLine('untimed'), // untimed human line, mid-open-turn
    humanLine('third', '2026-09-26T01:00:08.000Z'), // last-line closes "second" at line 8 (the -5 one)
    assistantLine('2026-09-26T01:00:09.000Z'),
    // "third" stays open to EOF — closed only at finish
  ]

  function foldChunks(chunks: Record<string, unknown>[][]): AgentisticsEvent[] {
    const out: AgentisticsEvent[] = []
    let s = emptyTurnFold()
    let lineNo = 0
    for (const chunk of chunks) {
      chunk.forEach(e => { lineNo++; foldTurnEntry(s, ctx, 'main', e, lineNo, ev => out.push(ev)) })
      s = cloneTurnFold(s)
      finishTurnFold(s, ctx, 'main', false, ev => out.push(ev)) // no-op, exercised for parity with replay.ts
    }
    finishTurnFold(s, ctx, 'main', true, ev => out.push(ev))
    return out
  }

  const essence = (e: AgentisticsEvent) => [e.type, e.data, e.occurredAt, e.provenance.sourceRef, e.provenance.confidence]

  const whole = foldChunks([entries])

  test('the scenario shapes exactly the events the header describes', () => {
    expect(whole.map(e => e.type)).toEqual([
      'turn.started', // first
      'turn.ended', // measured, closes first
      'turn.started', // second
      'turn.started', // untimed (mid-"second", changes nothing about the close bookkeeping)
      'turn.ended', // last-line, closes second at the -5 line
      'turn.started', // third
      'turn.ended', // finish: closes third at last timed line (the final assistant)
    ])
    const closes = ended(whole)
    expect(closes[0]!.data).toEqual({ close: 'measured', durationMs: 3000 })
    expect(closes[1]!.data).toEqual({ close: 'last-line' })
    expect(closes[1]!.occurredAt).toBe('2026-09-26T01:00:07.000Z')
    expect(closes[2]!.data).toEqual({ close: 'last-line' })
    expect(closes[2]!.occurredAt).toBe('2026-09-26T01:00:09.000Z')
  })

  test('every line boundary produces the identical result', () => {
    for (let cut = 1; cut < entries.length; cut++) {
      const split = foldChunks([entries.slice(0, cut), entries.slice(cut)])
      expect(split.map(essence)).toEqual(whole.map(essence))
    }
  })

  test('many uneven chunks produce the identical result', () => {
    const sizes = [1, 3, 2, 4]
    const chunks: Record<string, unknown>[][] = []
    for (let at = 0, k = 0; at < entries.length; k++) {
      const n = sizes[k % sizes.length]!
      chunks.push(entries.slice(at, at + n))
      at += n
    }
    expect(foldChunks(chunks).map(essence)).toEqual(whole.map(essence))
  })
})

describe('TurnFoldState shape', () => {
  test('emptyTurnFold / cloneTurnFold round-trip', () => {
    const s: TurnFoldState = emptyTurnFold()
    expect(s).toEqual({
      turnOpen: false, lastTimedLineNo: 0, lastTimedAt: null, lastAssistantAt: undefined, closedThroughLine: null,
    })
    const c = cloneTurnFold(s)
    expect(c).toEqual(s)
    expect(c).not.toBe(s)
  })
})
