// packages/server/server/sessions/conversations.test.ts
import { test, expect } from 'bun:test'
import { sessionCostUSD, type SessionMeta } from '@agentistics/core'
import { findConversation, resumeIdOf, toConversation } from './conversations'

let seq = 0
function session(over: Partial<SessionMeta> = {}): SessionMeta {
  seq++
  return {
    session_id: `s${seq}`,
    project_path: '/home/dev/app',
    start_time: '2026-07-01T10:00:00.000Z',
    duration_minutes: 5,
    user_message_count: 1,
    assistant_message_count: 1,
    tool_counts: {},
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: 0,
    git_pushes: 0,
    input_tokens: 1000,
    output_tokens: 500,
    first_prompt: 'hi',
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: 0,
    tool_error_categories: {},
    uses_task_agent: false,
    uses_mcp: false,
    uses_web_search: false,
    uses_web_fetch: false,
    lines_added: 0,
    lines_removed: 0,
    files_modified: 0,
    message_hours: [],
    user_message_timestamps: [],
    harness: 'claude',
    ...over,
  }
}

test('prices a single-model session via its own model', () => {
  const s = session({ model: 'claude-opus-4-7', input_tokens: 1_000_000, output_tokens: 0 })
  const c = toConversation(s)
  expect(c.costUSD).toBeCloseTo(sessionCostUSD(s)!, 6)
})

test('a multi-model session is priced per model, not by one dominant rate', () => {
  // The reported bug: costUSD was computed via calcCost(totalUsage, s.model) — the WHOLE session's
  // usage priced at one model's rate. An Antigravity parent whose subagent children folded in carry
  // a `model_usage` breakdown spanning several models, so that read the cheap model's tokens at the
  // expensive model's rate (or vice versa).
  const s = session({
    model: 'gemini-3.6-flash',
    input_tokens: 1_000_000,
    output_tokens: 0,
    model_usage: {
      'gemini-3.6-flash': {
        inputTokens: 500_000, outputTokens: 0,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0,
      },
      'claude-opus-4-7': {
        inputTokens: 500_000, outputTokens: 0,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0,
      },
    },
  })
  const c = toConversation(s)
  // Per-model breakdown, via the same primitive `sessionCostUSD` uses — never a single dominant rate.
  expect(c.costUSD).toBeCloseTo(sessionCostUSD(s)!, 6)
  // A single-rate read (either model applied to the full 1M tokens) must disagree with the correct
  // per-model figure — this is the assertion that would have caught the bug.
  expect(c.costUSD).not.toBeCloseTo(1_000_000 / 1_000_000 * 3, 6) // pure-opus rate over the whole total
  expect(c.costUSD).not.toBeCloseTo(0, 6)
})

test('no model and no usage yields no costUSD at all — never a confident 0', () => {
  const s = session({ input_tokens: 0, output_tokens: 0, model: undefined })
  const c = toConversation(s)
  expect(c.costUSD).toBeUndefined()
})

// F0.2 — gemini's two ids ---------------------------------------------------------------------

const G_UUID = '04d97770-e53f-4b7d-86d2-63bd12ec32eb'

test('a gemini conversation is resumable by its header uuid, and offers THAT id — not the store key', () => {
  const c = toConversation(session({ harness: 'gemini', session_id: 'work/session-x', native_session_id: G_UUID }))
  expect(c.sessionId).toBe('work/session-x')
  expect(c.nativeId).toBe(G_UUID)
  expect(c.resumable).toBe(true)
  expect(resumeIdOf(c)).toBe(G_UUID)
})

test('a gemini conversation with no header id lists but cannot be resumed', () => {
  // The synthetic key is not something `gemini --resume` can open; the verb is withheld, not broken.
  const c = toConversation(session({ harness: 'gemini', session_id: 'work/session-old' }))
  expect(c.resumable).toBe(false)
  expect(resumeIdOf(c)).toBe('work/session-old')
})

test('every other harness keeps resuming by its store key', () => {
  const c = toConversation(session({ harness: 'claude', session_id: 'abc' }))
  expect(c.resumable).toBe(true)
  expect(c.nativeId).toBeUndefined()
  expect(resumeIdOf(c)).toBe('abc')
})

test('findConversation answers to either id, and the store key wins', () => {
  const a = toConversation(session({ harness: 'gemini', session_id: 'work/a', native_session_id: G_UUID }))
  const b = toConversation(session({ harness: 'claude', session_id: 'b' }))
  expect(findConversation([a, b], G_UUID)).toBe(a)
  expect(findConversation([a, b], 'work/a')).toBe(a)
  expect(findConversation([a, b], 'b')).toBe(b)
  expect(findConversation([a, b], 'missing')).toBeUndefined()
  // an id that is somebody's store key is never captured by another row's alias
  const shadow = toConversation(session({ harness: 'gemini', session_id: 'z', native_session_id: 'b' }))
  expect(findConversation([shadow, b], 'b')).toBe(b)
})
