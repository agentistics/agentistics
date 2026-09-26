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
import type { AgentisticsEvent } from '@agentistics/core'
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
      (a, e) => ({
        input: a.input + e.data.usage.input, output: a.output + e.data.usage.output,
        cacheRead: a.cacheRead + e.data.usage.cacheRead, cacheWrite: a.cacheWrite + e.data.usage.cacheWrite,
      }),
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
