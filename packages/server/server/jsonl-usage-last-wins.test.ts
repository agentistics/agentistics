/**
 * M-1: `countUsage` kept the FIRST usage record per `message.id`, despite `usage-dedupe.ts`'s own
 * doc, `dedupeUsage`, and CLAUDE.md all saying the LAST record wins. Claude Code streams one
 * response as several lines sharing one `message.id`; in subagent transcripts the first line can
 * carry a PARTIAL usage (e.g. `output_tokens: 5`) with the final, complete one arriving later on
 * the SAME id. First-wins silently under-reports in exactly that case.
 *
 * These tests exercise the resumable fold directly (`emptyClaudeParse` / `foldClaudeParse`), so the
 * fix must retract a superseded id's contribution from every sink it touched — the four counters,
 * the day bucket, the cache-creation TTL split, and the context gauge — not merely stop double
 * adding it.
 */
import { describe, expect, test } from 'bun:test'
import { cloneClaudeParseState, emptyClaudeParse, foldClaudeParse, iterLines } from './jsonl'

/** One assistant line carrying a full usage record (all four counters + the optional TTL split). */
function assistantTurn(
  id: string,
  ts: string,
  usage: {
    input?: number; output?: number; cacheRead?: number; cacheCreation?: number
    ttl1h?: number; ttl5m?: number
  },
): string {
  const u: Record<string, unknown> = {
    input_tokens: usage.input ?? 0,
    output_tokens: usage.output ?? 0,
    cache_read_input_tokens: usage.cacheRead ?? 0,
    cache_creation_input_tokens: usage.cacheCreation ?? 0,
  }
  if (usage.ttl1h !== undefined || usage.ttl5m !== undefined) {
    u.cache_creation = { ephemeral_1h_input_tokens: usage.ttl1h ?? 0, ephemeral_5m_input_tokens: usage.ttl5m ?? 0 }
  }
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    cwd: '/w',
    message: { id, model: 'claude-opus-5', usage: u, content: [] },
  })
}

// A PARTIAL usage line, then the FINAL one for the SAME message id — same shape the differential
// found in real subagent transcripts (31 lines / 17 ids, 77-83 % over).
const PARTIAL = assistantTurn('msg_stream', '2026-09-20T10:00:00.000Z', {
  input: 100, output: 5, cacheRead: 50, cacheCreation: 10, ttl1h: 8, ttl5m: 2,
})
const FINAL = assistantTurn('msg_stream', '2026-09-20T10:00:01.000Z', {
  input: 100, output: 276, cacheRead: 50, cacheCreation: 1000, ttl1h: 800, ttl5m: 200,
})

describe('foldClaudeParse — LAST usage record per id wins', () => {
  test('a streamed id (partial first line, final last line) counts the FINAL record only', () => {
    const state = emptyClaudeParse()
    foldClaudeParse(state, iterLines(PARTIAL + '\n' + FINAL))

    // Not the sum of both (200/281/100/1010) and not the partial alone (100/5/50/10) — the FINAL
    // record's own numbers, exactly.
    expect(state.inputTokens).toBe(100)
    expect(state.outputTokens).toBe(276)
    expect(state.cacheReadTokens).toBe(50)
    expect(state.cacheCreationTokens).toBe(1000)
  })

  test('the TTL split is REPLACED, not added, when a repeat supersedes it', () => {
    const state = emptyClaudeParse()
    foldClaudeParse(state, iterLines(PARTIAL + '\n' + FINAL))

    expect(state.cacheCreation1hTokens).toBe(800)
    expect(state.cacheCreation5mTokens).toBe(200)
    expect(state.sawCacheCreationBreakdown).toBe(true)
  })

  test('the day bucket the usage feeds is REPLACED, not added', () => {
    const state = emptyClaudeParse()
    foldClaudeParse(state, iterLines(PARTIAL + '\n' + FINAL))

    const day = state.daily.get('2026-09-20')
    expect(day).toBeDefined()
    expect(day!.input_tokens).toBe(100)
    expect(day!.output_tokens).toBe(276)
    expect(day!.cache_read_input_tokens).toBe(50)
    expect(day!.cache_creation_input_tokens).toBe(1000)
  })

  test('a response whose lines straddle a UTC midnight stays on the day it STARTED, at its final usage', () => {
    // The canonical replay (`integrations/claude/replay-model.ts`) stamps a response with its FIRST
    // record's timestamp and its LAST record's usage. Measured on two real sessions (cfd203d2,
    // 64f54029): moving the whole response to the final line's day shifted tokens between two days
    // while the session totals stayed equal.
    const start = assistantTurn('msg_midnight', '2026-09-20T23:59:59.000Z', { input: 2, output: 5, cacheRead: 10 })
    const end = assistantTurn('msg_midnight', '2026-09-21T00:00:03.000Z', { input: 2, output: 300, cacheRead: 10 })
    const whole = emptyClaudeParse()
    foldClaudeParse(whole, iterLines(start + '\n' + end))
    expect(whole.daily.get('2026-09-20')!.output_tokens).toBe(300)
    expect(whole.daily.get('2026-09-21')?.output_tokens ?? 0).toBe(0)
    expect(whole.outputTokens).toBe(300)

    const chunked = emptyClaudeParse()
    foldClaudeParse(chunked, iterLines(start))
    const resumed = cloneClaudeParseState(chunked)
    foldClaudeParse(resumed, iterLines(end))
    expect(resumed.daily.get('2026-09-20')!.output_tokens).toBe(300)
    expect(resumed.daily.get('2026-09-21')?.output_tokens ?? 0).toBe(0)
  })

  test('the context gauge reflects the LAST record actually written, not the first one counted', () => {
    const state = emptyClaudeParse()
    foldClaudeParse(state, iterLines(PARTIAL + '\n' + FINAL))

    // contextOfUsage(FINAL) = input + cache_creation + cache_read = 100 + 1000 + 50
    expect(state.contextTokens).toBe(1150)
  })

  test('folding the split across TWO calls matches folding it in one — resumability', () => {
    // 1..n then n+1..m must equal 1..m: the whole point of a walk that can be resumed. The boundary
    // falls exactly between the partial line (already counted by the first fold) and the final line
    // for the SAME id (arriving in a LATER fold call, on a state a prior poll already advanced).
    const whole = emptyClaudeParse()
    foldClaudeParse(whole, iterLines(PARTIAL + '\n' + FINAL))

    const chunked = emptyClaudeParse()
    foldClaudeParse(chunked, iterLines(PARTIAL))
    const resumed = cloneClaudeParseState(chunked)
    foldClaudeParse(resumed, iterLines(FINAL))

    expect(resumed.inputTokens).toBe(whole.inputTokens)
    expect(resumed.outputTokens).toBe(whole.outputTokens)
    expect(resumed.cacheReadTokens).toBe(whole.cacheReadTokens)
    expect(resumed.cacheCreationTokens).toBe(whole.cacheCreationTokens)
    expect(resumed.cacheCreation1hTokens).toBe(whole.cacheCreation1hTokens)
    expect(resumed.cacheCreation5mTokens).toBe(whole.cacheCreation5mTokens)
    expect(resumed.contextTokens).toBe(whole.contextTokens)
    expect([...resumed.daily.entries()]).toEqual([...whole.daily.entries()])

    // And the actual figures, so a change that makes both sides wrong the same way still fails this.
    expect(resumed.inputTokens).toBe(100)
    expect(resumed.outputTokens).toBe(276)
  })

  test('three lines with no id at all are each counted — an id-less record is never a duplicate', () => {
    const anon = (ts: string, output: number) => JSON.stringify({
      type: 'assistant', timestamp: ts, cwd: '/w',
      message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: output }, content: [] },
    })
    const state = emptyClaudeParse()
    foldClaudeParse(state, iterLines([
      anon('2026-09-20T11:00:00.000Z', 1),
      anon('2026-09-20T11:00:01.000Z', 2),
      anon('2026-09-20T11:00:02.000Z', 3),
    ].join('\n')))
    expect(state.outputTokens).toBe(6)
    expect(state.inputTokens).toBe(3)
  })
})
