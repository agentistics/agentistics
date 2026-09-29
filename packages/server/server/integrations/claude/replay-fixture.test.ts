/**
 * The Claude replay over a REAL transcript's structure — `test/fixtures/claude-replay/proj/`, a
 * conversation with three async subagents, redacted to structural fields only (no content, no
 * paths, no cwd, no branch: master §42). The unit tests beside each sub-fold pin one rule each; this
 * one pins what they add up to against the legacy walk over the very same bytes:
 *
 * - CHUNK INDEPENDENCE (P1 §8): the fold split at every line boundary emits what it emits whole.
 * - SINK PARITY: driving the fold through `jsonl.ts`'s optional sink emits what reading the lines
 *   directly emits, and leaves `ClaudeParseState` exactly as it was without a sink.
 * - COUNTER PARITY: the four token counters summed over `model.completed` equal the legacy walk's,
 *   the last response's gauge equals its `contextTokens`, and `tool.requested` by name equals its
 *   `toolCounts`. Equal, not close — any difference is a bug on one side or the other.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyActiveTime, finishActiveTime, foldActiveTime, type AgentisticsEvent, type TurnEvent } from '@agentistics/core'
import { emptyClaudeParse, finishCompacts, foldClaudeParse, iterLines } from '../../jsonl'
import { emptyClaudeReplay, finishClaudeReplay, foldClaudeReplay, foldClaudeReplayEntry } from './replay'
import { CLAUDE_ADAPTER_VERSION, mainContext } from './replay-core'
import { createClaudeReplay } from './index'

const PROJECTS = join(import.meta.dir, '../../../test/fixtures/claude-replay')
const CONV = '00000000-0000-4000-8000-000000000001'
const TEXT = readFileSync(join(PROJECTS, 'proj', `${CONV}.jsonl`), 'utf-8')
const LINES = [...iterLines(TEXT)]
const RECORDED_AT = '2026-09-25T00:00:00.000Z'

/** What an event SAYS — everything but when we learned it. */
const essence = (e: AgentisticsEvent) => ({
  id: e.eventId, type: e.type, at: e.occurredAt, agent: e.agentId, ref: e.provenance.sourceRef, data: e.data,
})

function replayChunks(chunks: string[][]): AgentisticsEvent[] {
  const out: AgentisticsEvent[] = []
  const state = emptyClaudeReplay(mainContext(CONV, RECORDED_AT))
  for (const c of chunks) {
    foldClaudeReplay(state, c, e => out.push(e))
    finishClaudeReplay(state, { final: false }, e => out.push(e))
  }
  finishClaudeReplay(state, { final: true }, e => out.push(e))
  return out
}

const WHOLE = replayChunks([LINES])

describe('Claude replay over a redacted real transcript', () => {
  test('the fixture is the shape it claims: a real conversation with several responses and tools', () => {
    expect(WHOLE.filter(e => e.type === 'model.completed').length).toBeGreaterThan(10)
    expect(WHOLE.filter(e => e.type === 'tool.requested').length).toBeGreaterThan(10)
  })

  test('chunk independence: split at EVERY line boundary, the same events', () => {
    const whole = WHOLE.map(essence)
    for (let i = 1; i < LINES.length; i++) {
      const split = replayChunks([LINES.slice(0, i), LINES.slice(i)]).map(essence)
      expect(split).toEqual(whole)
    }
  })

  test('chunk independence: many uneven chunks, the same events', () => {
    const sizes = [1, 7, 2, 30, 3, 11, 5]
    const chunks: string[][] = []
    for (let at = 0, k = 0; at < LINES.length; k++) {
      const n = sizes[k % sizes.length]!
      chunks.push(LINES.slice(at, at + n))
      at += n
    }
    expect(replayChunks(chunks).map(essence)).toEqual(WHOLE.map(essence))
  })

  test('every event id is unique within a replay, and every envelope is complete', () => {
    const ids = WHOLE.map(e => e.eventId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of WHOLE) {
      expect(e.provenance.adapterVersion).toBe(CLAUDE_ADAPTER_VERSION)
      expect(['exact', 'estimated', 'inferred']).toContain(e.provenance.confidence)
      expect(e.provenance.sourceRef).toMatch(new RegExp(`^claude:${CONV}(/subagents/[^:]+)?:(\\d+|meta)$`))
      expect(e.recordedAt).toBe(RECORDED_AT)
    }
  })

  test('the sink in jsonl.ts drives the same fold to the same events, and changes no parse', () => {
    const viaSink: AgentisticsEvent[] = []
    const replay = emptyClaudeReplay(mainContext(CONV, RECORDED_AT))
    const withSink = emptyClaudeParse()
    foldClaudeParse(withSink, LINES, (entry, lineNo) => foldClaudeReplayEntry(replay, entry, lineNo, e => viaSink.push(e)))
    finishClaudeReplay(replay, { final: true }, e => viaSink.push(e))
    expect(viaSink.map(essence)).toEqual(WHOLE.map(essence))

    const without = emptyClaudeParse()
    foldClaudeParse(without, LINES)
    expect(withSink).toEqual(without)
  })

  test('counter parity: the four token counters and the gauge equal the legacy walk exactly', () => {
    const legacy = emptyClaudeParse()
    foldClaudeParse(legacy, LINES)
    const completed = WHOLE.filter((e): e is AgentisticsEvent<'model.completed'> => e.type === 'model.completed')
    const sum = completed.reduce(
      (a, e) => {
        // D21 (2026-09-26): a counter is now individually optional on the event. This fixture's own
        // replay always reports all four, so asserting that here — rather than defaulting a missing
        // one to 0 — keeps the parity check honest: a counter that silently went absent would fail
        // this assertion instead of quietly summing to a smaller, wrong total.
        const { input, output, cacheRead, cacheWrite } = e.data.usage
        expect(input).toBeDefined()
        expect(output).toBeDefined()
        expect(cacheRead).toBeDefined()
        expect(cacheWrite).toBeDefined()
        return {
          input: a.input + input!, output: a.output + output!,
          cacheRead: a.cacheRead + cacheRead!, cacheWrite: a.cacheWrite + cacheWrite!,
        }
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    )
    expect(sum).toEqual({
      input: legacy.inputTokens, output: legacy.outputTokens,
      cacheRead: legacy.cacheReadTokens, cacheWrite: legacy.cacheCreationTokens,
    })
    const last = completed.at(-1)!
    expect(last.data.contextTokens).toBe(legacy.contextTokens)
    // one completion per billed response
    const ids = completed.map(e => e.data.providerRequestId).filter(Boolean)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('counter parity: tool.requested by name equals the legacy toolCounts', () => {
    const legacy = emptyClaudeParse()
    foldClaudeParse(legacy, LINES)
    const counts: Record<string, number> = {}
    for (const e of WHOLE) {
      if (e.type !== 'tool.requested') continue
      const name = (e as AgentisticsEvent<'tool.requested'>).data.name
      counts[name] = (counts[name] ?? 0) + 1
    }
    expect(counts).toEqual(legacy.toolCounts)
  })

  test('no event carries conversation text: no content, prompt or text field anywhere', () => {
    // Keys only — `usage.input` is a counter and legitimately named so.
    const forbidden = new Set(['content', 'text', 'prompt', 'thinking', 'command', 'title', 'message'])
    for (const e of WHOLE) {
      for (const key of Object.keys(e.data)) expect(forbidden.has(key)).toBe(false)
    }
  })
})

describe('the IO half over the fixture directory', () => {
  // The real clock: `final` compares it against the fixture file's own mtime, which is whenever the
  // checkout wrote it, so a fixed clock in the past would read the file as still being written.
  const replay = createClaudeReplay({ projectsDir: PROJECTS, settledMs: 0 })

  test('discovers the one conversation, and replays it with its three subagents', async () => {
    const sources = await replay.discover()
    expect(sources).toEqual([{ sessionId: CONV, sourceRef: `claude:${CONV}` }])
    const { events, cursor } = await replay.replay(sources[0]!, null)
    expect(cursor).not.toBeNull()

    const subStarts = events.filter(e => e.type === 'agent.started'
      && (e as AgentisticsEvent<'agent.started'>).data.kind === 'subagent')
    expect(subStarts.length).toBe(3)
    const subIds = new Set(subStarts.map(e => e.agentId))
    // each subagent's own responses are attributed to it, never to the main agent
    const subModel = events.filter(e => e.type === 'model.completed' && subIds.has(e.agentId!))
    expect(subModel.length).toBeGreaterThan(0)
    // the main transcript's part equals the pure fold's
    const mainOnly = events.filter(e => !e.provenance.sourceRef!.includes('/subagents/')
      && !(e.type === 'agent.started' && subIds.has(e.agentId!)))
    expect(mainOnly.map(essence)).toEqual(WHOLE.map(essence))
  })

  test('a second replay from the returned cursor emits nothing new', async () => {
    const [source] = await replay.discover()
    const first = await replay.replay(source!, null)
    const second = await replay.replay(source!, first.cursor)
    const seen = new Set(first.events.map(e => e.eventId))
    expect(second.events.filter(e => !seen.has(e.eventId))).toEqual([])
  })
})

describe('Claude replay over a redacted excerpt with five compactions', () => {
  // Every compact_boundary of a real five-compaction conversation plus twelve lines either side,
  // redacted like the fixture above; `compactMetadata` keeps only trigger / durationMs /
  // cumulativeDroppedTokens / preTokens / postTokens.
  const CONV2 = '00000000-0000-4000-8000-000000000002'
  const lines2 = [...iterLines(readFileSync(
    join(import.meta.dir, '../../../test/fixtures/claude-replay-compact/proj', `${CONV2}.jsonl`), 'utf-8'))]
  const run2 = (chunks: string[][]) => {
    const out: AgentisticsEvent[] = []
    const s = emptyClaudeReplay(mainContext(CONV2, RECORDED_AT))
    for (const c of chunks) foldClaudeReplay(s, c, e => out.push(e))
    finishClaudeReplay(s, { final: true }, e => out.push(e))
    return out
  }
  const all = run2([lines2])
  const compacted = all.filter((e): e is AgentisticsEvent<'context.compacted'> => e.type === 'context.compacted')

  test('one context.compacted per compaction, and the projection of them equals the legacy compact stats', () => {
    const legacy = emptyClaudeParse()
    foldClaudeParse(legacy, lines2)
    const stats = finishCompacts(legacy.compact)
    expect(compacted).toHaveLength(5)
    expect(compacted.length).toBe(stats.count)
    expect(compacted.reduce((a, e) => a + (e.data.durationMs ?? 0), 0)).toBe(stats.ms)
    expect(compacted.reduce((a, e) => a + (e.data.droppedTokens ?? 0), 0)).toBe(stats.droppedTokens!)
    expect(compacted.every(e => e.data.trigger === 'auto' && e.provenance.confidence === 'exact')).toBe(true)
  })

  test('chunk independence at every line boundary', () => {
    const whole = all.map(essence)
    for (let i = 1; i < lines2.length; i++) {
      expect(run2([lines2.slice(0, i), lines2.slice(i)]).map(essence)).toEqual(whole)
    }
  })
})

describe('Claude replay over a small excerpt exercising human turns (D22)', () => {
  // A tiny hand-built conversation (not a redacted real one, unlike the fixtures above — its whole
  // point is to exercise five specific line shapes together, which no real transcript on this
  // machine happened to carry in one file): a plain human prompt (string content), a human prompt
  // with array text content, a pure tool_result user line, an isMeta user line, an isCompactSummary
  // user line, and a human prompt with NO `timestamp` field at all — three of the six are turns.
  const CONV3 = '00000000-0000-4000-8000-000000000003'
  const lines3 = [...iterLines(readFileSync(
    join(import.meta.dir, '../../../test/fixtures/claude-replay-turns/proj', `${CONV3}.jsonl`), 'utf-8'))]
  const run3 = (chunks: string[][]) => {
    const out: AgentisticsEvent[] = []
    const s = emptyClaudeReplay(mainContext(CONV3, RECORDED_AT))
    for (const c of chunks) foldClaudeReplay(s, c, e => out.push(e))
    finishClaudeReplay(s, { final: true }, e => out.push(e))
    return out
  }
  const all3 = run3([lines3])
  const turns = all3.filter((e): e is AgentisticsEvent<'turn.started'> => e.type === 'turn.started')

  test('exactly the three human lines become turn.started — never the tool_result, isMeta or isCompactSummary lines', () => {
    expect(turns).toHaveLength(3)
    // line 1 (string content), line 4 (array text content), line 7 (no timestamp at all) — 1-based,
    // matching `lineRef`'s own numbering (blanks included, none here).
    expect(turns.map(e => e.provenance.sourceRef)).toEqual([
      `claude:${CONV3}:1`, `claude:${CONV3}:4`, `claude:${CONV3}:7`,
    ])
    expect(turns.every(e => e.data.by === 'user')).toBe(true)
  })

  test('the count equals BOTH a hand count and legacy\'s user_message_count on the same bytes', () => {
    const legacy = emptyClaudeParse()
    foldClaudeParse(legacy, lines3)
    expect(turns.length).toBe(3)
    expect(turns.length).toBe(legacy.userMsgs)
  })

  test('a timestamped line is exact; the timestamp-less line falls back to recordedAt and reads estimated', () => {
    expect(turns[0]!.occurredAt).toBe('2026-09-26T10:00:00.000Z')
    expect(turns[0]!.provenance.confidence).toBe('exact')
    expect(turns[1]!.occurredAt).toBe('2026-09-26T10:00:10.000Z')
    expect(turns[1]!.provenance.confidence).toBe('exact')
    // line 7 carries no `timestamp` at all
    expect(turns[2]!.occurredAt).toBe(RECORDED_AT)
    expect(turns[2]!.provenance.confidence).toBe('estimated')
  })

  test('no event carries anything beyond who, when and (D25) the last prior assistant reply', () => {
    const forbidden = new Set(['content', 'text', 'prompt', 'thinking', 'command', 'title', 'message'])
    for (const e of turns) for (const key of Object.keys(e.data)) expect(forbidden.has(key)).toBe(false)
    // Every key present is one of the two D5/D25-allowed fields — never more.
    for (const e of turns) for (const key of Object.keys(e.data)) expect(['by', 'previousAssistantAt']).toContain(key)
  })

  test('(D25) previousAssistantAt: absent before any assistant line, present (line 2\'s own reply) once one has spoken', () => {
    // Line 2 is the fixture's only assistant line, timestamped 2026-09-26T10:00:05.000Z, and it sits
    // between turn 1 (line 1) and turns 2 and 3 (lines 4 and 7) — so only the first turn has none.
    expect('previousAssistantAt' in turns[0]!.data).toBe(false)
    expect((turns[1]!.data as { previousAssistantAt?: string }).previousAssistantAt).toBe('2026-09-26T10:00:05.000Z')
    // Never reset between turns: turn 3 (estimated, no timestamp of its own) still carries it, and
    // line 8's assistant reply (which answers turn 3) comes AFTER it and cannot be the value.
    expect((turns[2]!.data as { previousAssistantAt?: string }).previousAssistantAt).toBe('2026-09-26T10:00:05.000Z')
  })

  test('chunk independence at every line boundary, including across the timestamp-less line', () => {
    const whole = all3.map(essence)
    for (let i = 1; i < lines3.length; i++) {
      expect(run3([lines3.slice(0, i), lines3.slice(i)]).map(essence)).toEqual(whole)
    }
  })

  test('chunk independence: many uneven chunks, the same events (and the same turn ids)', () => {
    const sizes = [1, 3, 2]
    const chunks: string[][] = []
    for (let at = 0, k = 0; at < lines3.length; k++) {
      const n = sizes[k % sizes.length]!
      chunks.push(lines3.slice(at, at + n))
      at += n
    }
    const split = run3(chunks)
    expect(split.map(essence)).toEqual(all3.map(essence))
    expect(new Set(split.filter(e => e.type === 'turn.started').map(e => e.eventId)))
      .toEqual(new Set(turns.map(e => e.eventId)))
  })
})

describe('Claude replay over a small excerpt exercising turn.ended (A2.8, D25)', () => {
  // A tiny hand-built conversation (not a redacted real one) exercising, in one file: a turn closed
  // by a measured `turn_duration` line, a stray `turn_duration` with no turn open, a negative
  // `durationMs` (an ordinary timed line — the turn stays open), a human line with no `timestamp` at
  // all sitting mid-open-turn, a turn closed by `last-line` at the next prompt, a multi-line
  // assistant response (so `previousAssistantAt` is the LAST of the two), a final turn left open to
  // EOF and closed only at `finish`, and a prompt (line 1) with no preceding assistant line at all.
  const CONV4 = '00000000-0000-4000-8000-000000000004'
  const lines4 = [...iterLines(readFileSync(
    join(import.meta.dir, '../../../test/fixtures/claude-replay-turn-end/proj', `${CONV4}.jsonl`), 'utf-8'))]
  const run4 = (chunks: string[][]) => {
    const out: AgentisticsEvent[] = []
    const s = emptyClaudeReplay(mainContext(CONV4, RECORDED_AT))
    for (const c of chunks) foldClaudeReplay(s, c, e => out.push(e))
    finishClaudeReplay(s, { final: true }, e => out.push(e))
    return out
  }
  const all4 = run4([lines4])
  const turns = all4.filter((e): e is AgentisticsEvent<'turn.started'> => e.type === 'turn.started')
  const closes = all4.filter((e): e is AgentisticsEvent<'turn.ended'> => e.type === 'turn.ended')

  test('the shape: four turns (one of them untimed), three closes, one of each close reason', () => {
    // Four HUMAN lines (1, 6, 9, 10) each get their own turn.started — line 9 counts as a round
    // (`user_message_count`) exactly like the others, even though it carries no timestamp — but only
    // THREE of them are ever closed, because line 9 never opens or closes anything in the bookkeeping
    // (see the dedicated test below).
    expect(turns).toHaveLength(4)
    expect(turns.map(e => e.provenance.sourceRef)).toEqual(
      [`claude:${CONV4}:1`, `claude:${CONV4}:6`, `claude:${CONV4}:9`, `claude:${CONV4}:10`])
    expect(closes).toHaveLength(3)
    expect(closes.map(e => e.data.close)).toEqual(['measured', 'last-line', 'last-line'])
  })

  test('the measured close: line 4\'s own durationMs, at line 4', () => {
    expect(closes[0]!.data).toEqual({ close: 'measured', durationMs: 7000 })
    expect(closes[0]!.provenance.sourceRef).toBe(`claude:${CONV4}:4`)
    expect(closes[0]!.occurredAt).toBe('2026-09-26T11:00:07.000Z')
  })

  test('the stray turn_duration (line 5) closes nothing and is never referenced by any close', () => {
    // No turn is open when line 5 is processed (turn 1 already closed at line 4), so it emits
    // nothing — and because line 6 (a timed human line) immediately follows and overwrites the
    // last-timed reference when it opens turn 2, line 5 never becomes anyone's close point either.
    // Only three closes total (asserted above): the fourth close a stray measurement might otherwise
    // have produced never happens.
    expect(closes.every(e => e.provenance.sourceRef !== `claude:${CONV4}:5`)).toBe(true)
  })

  test('the second turn closes last-line at line 8 (the negative-duration line), not at line 6, 9 or 10', () => {
    expect(closes[1]!.data).toEqual({ close: 'last-line' })
    expect(closes[1]!.provenance.sourceRef).toBe(`claude:${CONV4}:8`)
    expect(closes[1]!.occurredAt).toBe('2026-09-26T11:00:16.000Z')
  })

  test('the third turn is closed only at finish, last-line, at line 11 (the final assistant reply)', () => {
    expect(closes[2]!.data).toEqual({ close: 'last-line' })
    expect(closes[2]!.provenance.sourceRef).toBe(`claude:${CONV4}:11`)
    expect(closes[2]!.occurredAt).toBe('2026-09-26T11:00:25.000Z')
  })

  test('line 9 (the untimed human line) gets an ESTIMATED turn.started, but touches no close at all', () => {
    const line9 = turns.find(e => e.provenance.sourceRef === `claude:${CONV4}:9`)!
    expect(line9.occurredAt).toBe(RECORDED_AT)
    expect(line9.provenance.confidence).toBe('estimated')
    // None of the three closes reference line 9 in any way — it neither closed the still-open turn
    // from line 6 nor moved the last-timed line the NEXT close (line 10, closing at line 8) uses.
    expect(closes.some(e => e.provenance.sourceRef === `claude:${CONV4}:9`)).toBe(false)
  })

  test('previousAssistantAt: absent for turn 1, and the LAST of a multi-line response for the turns after it', () => {
    // turns = [line 1, line 6, line 9, line 10]
    expect('previousAssistantAt' in turns[0]!.data).toBe(false)
    // Lines 2 and 3 are both assistant replies to turn 1; line 3 (11:00:06) is the later one.
    expect((turns[1]!.data as { previousAssistantAt?: string }).previousAssistantAt).toBe('2026-09-26T11:00:06.000Z')
    // Line 7 answers turn 2 at 11:00:15, and BOTH lines 9 and 10 come after it — line 9, the untimed
    // human line in between, is not an assistant line and does not move it, so it and line 10 carry
    // the identical value.
    expect((turns[2]!.data as { previousAssistantAt?: string }).previousAssistantAt).toBe('2026-09-26T11:00:15.000Z')
    expect((turns[3]!.data as { previousAssistantAt?: string }).previousAssistantAt).toBe('2026-09-26T11:00:15.000Z')
  })

  test('THE GOAL: turn.started + turn.ended alone reproduce legacy\'s active_minutes exactly', () => {
    const legacy = emptyClaudeParse()
    foldClaudeParse(legacy, lines4)
    const legacyMinutes = finishActiveTime(legacy.active).activeMinutes

    // Every EXACT turn.started becomes a `userPrompt` TurnEvent — an ESTIMATED one (line 9) is
    // skipped, exactly as legacy's own walk never pushes a `TurnEvent` for a line whose `timestamp`
    // did not `Date.parse` (it is not that `ts` was falsy on `entry.timestamp` — it is genuinely
    // absent here). Every turn.ended becomes either a `measuredMs` one (close: 'measured') or a
    // `turnEnd` one (close: 'last-line') — including the FINISH-time close, which is why
    // `finishActiveTime` below has nothing left open to close on its own. This is exactly the
    // reconstruction a projection is expected to perform.
    const reconstructed: TurnEvent[] = all4
      .filter((e): e is AgentisticsEvent<'turn.started'> | AgentisticsEvent<'turn.ended'> =>
        (e.type === 'turn.started' && e.provenance.confidence === 'exact') || e.type === 'turn.ended')
      .map(e => {
        const ts = Date.parse(e.occurredAt)
        if (e.type === 'turn.started') return { ts, userPrompt: true }
        return e.data.close === 'measured' ? { ts, measuredMs: e.data.durationMs } : { ts, turnEnd: true }
      })
    const state = emptyActiveTime()
    foldActiveTime(state, reconstructed)
    const result = finishActiveTime(state)

    // The three turns here are each a handful of seconds long, so `activeMinutes` itself may well
    // round to 0 — the point of this test is that the RECONSTRUCTION agrees with legacy EXACTLY,
    // never that the number is large.
    expect(result.activeMinutes).toBe(legacyMinutes)
    expect(result.turns).toBe(3)
    expect(result.measuredTurns).toBe(1)
  })

  test('THE GOAL: turn.started.previousAssistantAt alone reproduces legacy\'s user_response_times exactly', () => {
    const legacy = emptyClaudeParse()
    foldClaudeParse(legacy, lines4)

    // Mirrors jsonl.ts's own computation exactly: only an EXACT turn.started (a real timestamp on
    // the line — legacy's outer `if (ts)`) with a previousAssistantAt counts, and only when the
    // delta lands in [0, 3600)s.
    const reconstructed = turns
      .filter(e => e.provenance.confidence === 'exact')
      .map(e => {
        const prev = (e.data as { previousAssistantAt?: string }).previousAssistantAt
        if (prev === undefined) return null
        const delta = (Date.parse(e.occurredAt) - Date.parse(prev)) / 1000
        return delta >= 0 && delta < 3600 ? Math.round(delta) : null
      })
      .filter((v): v is number => v !== null)

    expect(legacy.userResponseTimes.length).toBeGreaterThan(0)
    expect(reconstructed).toEqual(legacy.userResponseTimes)
  })

  test('chunk independence at every line boundary', () => {
    const whole = all4.map(essence)
    for (let i = 1; i < lines4.length; i++) {
      expect(run4([lines4.slice(0, i), lines4.slice(i)]).map(essence)).toEqual(whole)
    }
  })

  test('chunk independence: many uneven chunks, the same events', () => {
    const sizes = [1, 4, 2, 3]
    const chunks: string[][] = []
    for (let at = 0, k = 0; at < lines4.length; k++) {
      const n = sizes[k % sizes.length]!
      chunks.push(lines4.slice(at, at + n))
      at += n
    }
    expect(run4(chunks).map(essence)).toEqual(all4.map(essence))
  })

  test('a resumed live transcript: an intermediate final:true finish, then more folding, closes AGAIN', () => {
    // Fold everything up to and including line 10 (turn 3 opens, nothing closes it yet), finish as
    // `final: true` (closes turn 3 at line 10, since nothing timed came after it YET), then fold the
    // rest (line 11) and finish `final: true` again — the SAME turn closes a second time, further
    // along, mirroring a live transcript that keeps writing after a poll believed it had settled.
    const out: AgentisticsEvent[] = []
    const s = emptyClaudeReplay(mainContext(CONV4, RECORDED_AT))
    foldClaudeReplay(s, lines4.slice(0, 10), e => out.push(e))
    finishClaudeReplay(s, { final: true }, e => out.push(e))
    const firstCloses = out.filter(e => e.type === 'turn.ended')
    expect(firstCloses).toHaveLength(3) // the two earlier turns, plus turn 3 closed early at line 10

    foldClaudeReplay(s, lines4.slice(10), e => out.push(e))
    finishClaudeReplay(s, { final: true }, e => out.push(e))
    const allCloses = out.filter(e => e.type === 'turn.ended')
    expect(allCloses).toHaveLength(4) // one more: turn 3 closes again, now at line 11
    expect(allCloses[3]!.occurredAt).toBe('2026-09-26T11:00:25.000Z')
    expect(allCloses[3]!.provenance.sourceRef).toBe(`claude:${CONV4}:11`)

    // A THIRD final finish with nothing new folded since adds nothing more — idempotent.
    finishClaudeReplay(s, { final: true }, e => out.push(e))
    expect(out.filter(e => e.type === 'turn.ended')).toHaveLength(4)
  })
})
