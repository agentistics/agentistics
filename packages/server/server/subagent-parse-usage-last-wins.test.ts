/**
 * M-1 for subagent transcripts specifically — the shape the differential actually found (460 agent
 * invocation rows / 41 session totals off, subagent transcripts only): a subagent's assistant turn
 * is streamed as several lines sharing one `message.id`, and the FIRST can carry a PARTIAL usage
 * (e.g. `output_tokens: 5`) with the FINAL, complete one arriving later on the same id.
 * `summarizeSubagentTranscript` kept the first (`countUsage`'s first-wins gate) and must keep the
 * last instead, per-model.
 */
import { test, expect } from 'bun:test'
import { summarizeSubagentTranscript } from './subagent-parse'

function assistant(id: string, model: string, usage: Record<string, number>, ts: string) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, model, usage, content: [] },
  })
}

test('a partial-then-final usage record for one id counts the FINAL numbers only', () => {
  const s = summarizeSubagentTranscript([
    assistant('msg_1', 'claude-haiku-4-5-20251001', {
      input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 10,
    }, '2026-09-20T10:00:00.000Z'),
    assistant('msg_1', 'claude-haiku-4-5-20251001', {
      input_tokens: 100, output_tokens: 276, cache_read_input_tokens: 50, cache_creation_input_tokens: 1000,
    }, '2026-09-20T10:00:01.000Z'),
  ])

  // Not the sum (200/281/100/1010) and not the partial (100/5/50/10) — the final record, exactly.
  expect(s.usage).toEqual([
    { model: 'claude-haiku-4-5-20251001', inputTokens: 100, outputTokens: 276, cacheReadTokens: 50, cacheWriteTokens: 1000 },
  ])
})

test('a superseded id does not leak into a DIFFERENT model bucket', () => {
  // Same id repeated, but a later record names a different model — the LAST record's model is what
  // the tokens are billed under, and the earlier (superseded) model bucket must not keep them.
  const s = summarizeSubagentTranscript([
    assistant('msg_1', 'claude-haiku-4-5-20251001', { input_tokens: 10, output_tokens: 2 }, '2026-09-20T10:00:00.000Z'),
    assistant('msg_1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 40 }, '2026-09-20T10:00:01.000Z'),
  ])
  expect(s.usage).toEqual([
    { model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ])
})

test('three repeats of one id still count it once, at the LAST value', () => {
  const s = summarizeSubagentTranscript([
    assistant('msg_1', 'm', { input_tokens: 1, output_tokens: 1 }, '2026-09-20T10:00:00.000Z'),
    assistant('msg_1', 'm', { input_tokens: 1, output_tokens: 2 }, '2026-09-20T10:00:01.000Z'),
    assistant('msg_1', 'm', { input_tokens: 1, output_tokens: 3 }, '2026-09-20T10:00:02.000Z'),
  ])
  expect(s.usage).toEqual([{ model: 'm', inputTokens: 1, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }])
})
