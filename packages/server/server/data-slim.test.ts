import { describe, expect, test } from 'bun:test'
import { slimApiResponse, slimSerialized, SLIM_DROPPED_SESSION_FIELDS, SLIM_SESSION_LIMIT } from './data-slim'
import type { ApiResponse } from './data'

const session = (i: number) => ({
  session_id: `s${i}`, project_path: '/p', start_time: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  input_tokens: 10, output_tokens: 5, first_prompt: 'hi',
  message_hours: Array.from({ length: 800 }, (_, k) => k % 24),
  user_message_timestamps: Array.from({ length: 200 }, () => '2026-01-01T00:00:00Z'),
  agentMetrics: { invocations: [] }, tool_output_tokens: { Bash: 1 }, user_response_times: [1, 2], tool_error_categories: { x: 1 },
})
const data = (n: number) => ({
  statsCache: { dailyActivity: [] }, projects: [{ path: '/p', name: 'p', sessions: [] }], allSessions: [] as [],
  sessions: Array.from({ length: n }, (_, i) => session(i)), healthIssues: [], homeDir: '/h', harnesses: ['claude'], workflows: [{ id: 'w' }],
}) as unknown as ApiResponse

describe('slimApiResponse', () => {
  test('is marked partial/slim and keeps the cheap fields', () => {
    const src = data(5)
    const s = slimApiResponse(src)
    expect(s.partial).toBe(true)
    expect(s.partialReason).toBe('slim')
    expect(s.statsCache).toBe(src.statsCache)
    expect(s.projects).toHaveLength(1)
    expect(s.harnesses).toEqual(['claude'])
    expect(s.sessions[0]!.first_prompt).toBe('hi')
    expect(s.sessions[0]!.input_tokens).toBe(10)
  })
  test('drops the heavy per-session arrays and the workflows', () => {
    const s = slimApiResponse(data(3))
    for (const f of SLIM_DROPPED_SESSION_FIELDS) expect(f in s.sessions[0]!).toBe(false)
    expect(s.workflows).toEqual([])
  })
  test('carries only the most recent sessions, newest first', () => {
    const s = slimApiResponse(data(SLIM_SESSION_LIMIT + 50))
    expect(s.sessions).toHaveLength(SLIM_SESSION_LIMIT)
    expect(s.sessions[0]!.session_id).toBe(`s${SLIM_SESSION_LIMIT + 49}`)
  })
  test('does not mutate the source build', () => {
    const d = data(3)
    slimApiResponse(d)
    expect(d.sessions[0]!.message_hours).toHaveLength(800)
    expect(d.partial).toBeUndefined()
  })
  test('payload size bound: a realistic 1200-session build slims to well under 10% of the full JSON', () => {
    const d = data(1200)
    const full = JSON.stringify(d).length
    const slim = slimSerialized(d).length
    expect(slim).toBeLessThan(full * 0.1)
    expect(slim).toBeLessThan(250_000)
  })
  test('serialization is memoized per build', () => {
    const d = data(10)
    expect(slimSerialized(d)).toBe(slimSerialized(d))
  })
})
