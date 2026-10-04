import { describe, expect, test } from 'bun:test'
import { sessionTokenTotal } from '@agentistics/core'
import { loadNativeSessions, nativeSessionMeta, nativeSessionsFrom, type NativeSessionFactsWire } from './native-sessions'

const facts = (over: Partial<NativeSessionFactsWire> = {}): NativeSessionFactsWire => ({
  sessionId: 'ses_1',
  title: 'fix the bug',
  cwd: '/repo/sub',
  workspaceRoot: '/repo',
  status: 'idle',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  createdAt: '2026-10-03T10:00:00.000Z',
  updatedAt: '2026-10-03T10:30:00.000Z',
  messageCount: 4,
  runCount: 2,
  models: [
    { model: 'claude-sonnet-4-6', provider: 'anthropic', responses: 3, input: 100, output: 50, cacheRead: 1000, cacheWrite: 10, partial: false, statedUSD: null },
    { model: 'mystery-model', provider: 'local', responses: 1, input: 5, output: 5, cacheRead: 0, cacheWrite: 0, partial: false, statedUSD: null },
  ],
  tools: { 'fs.read': { calls: 3, errors: 1 } },
  runs: [
    { startedAt: '2026-10-03T10:01:00.000Z', endedAt: '2026-10-03T10:05:00.000Z', status: 'completed' },
    { startedAt: '2026-10-03T10:20:00.000Z', endedAt: '2026-10-03T10:25:00.000Z', status: 'completed' },
  ],
  ...over,
})

describe('nativeSessionMeta', () => {
  test('maps facts to a SessionMeta of the native harness with all four token counters', () => {
    const s = nativeSessionMeta(facts())!
    expect(s.harness).toBe('agentistics')
    expect(s.project_path).toBe('/repo')
    expect(s.current_cwd).toBe('/repo/sub')
    expect(sessionTokenTotal(s)).toBe(100 + 50 + 1000 + 10 + 5 + 5)
    expect(s.model).toBe('claude-sonnet-4-6')
    expect(Object.keys(s.model_usage!)).toEqual(['claude-sonnet-4-6', 'mystery-model'])
    expect(s.user_message_count).toBe(2)
    expect(s.assistant_message_count).toBe(2)
    expect(s.tool_counts).toEqual({ 'fs.read': 3 })
    expect(s.tool_errors).toBe(1)
    expect(s.start_time).toBe('2026-10-03T10:01:00.000Z')
    expect(s.end_time).toBe('2026-10-03T10:25:00.000Z')
    expect(s.duration_minutes).toBe(24)
  })

  test('an unfinished run ends the session at its last touch, not at the last finished run', () => {
    const s = nativeSessionMeta(facts({ runs: [
      { startedAt: '2026-10-03T10:01:00.000Z', endedAt: '2026-10-03T10:05:00.000Z', status: 'completed' },
      { startedAt: '2026-10-03T10:20:00.000Z', status: 'running' },
    ] }))!
    expect(s.end_time).toBe('2026-10-03T10:30:00.000Z')
  })

  test('a malformed record is skipped, never drawn', () => {
    expect(nativeSessionMeta(facts({ sessionId: '' }))).toBeNull()
    expect(nativeSessionMeta(facts({ createdAt: 'nope' }))).toBeNull()
  })

  test('tokens no model was stated for still count in the totals', () => {
    const s = nativeSessionMeta(facts({ models: [{ model: '', provider: 'x', responses: 1, input: 7, output: 3, cacheRead: 0, cacheWrite: 0, partial: true, statedUSD: null }] }))!
    expect(sessionTokenTotal(s)).toBe(10)
    expect(s.model_usage).toBeUndefined()
    expect(s.model).toBe('claude-sonnet-4-6') // falls back to the session's configured model
  })
})

describe('nativeSessionsFrom', () => {
  test('newest first; garbage answers yield nothing', () => {
    const rows = nativeSessionsFrom({ sessions: [facts(), facts({ sessionId: 'ses_2', runs: [{ startedAt: '2026-10-03T12:00:00.000Z', status: 'completed' }] }), { junk: true }] })
    expect(rows.map(r => r.session_id)).toEqual(['ses_2', 'ses_1'])
    expect(nativeSessionsFrom(null)).toEqual([])
    expect(nativeSessionsFrom({ sessions: 'x' })).toEqual([])
  })
})

describe('loadNativeSessions', () => {
  const ok = async () => new Response(JSON.stringify({ sessions: [facts()] }), { status: 200 })
  test('a central and a switched-off flag answer nothing', async () => {
    expect(await loadNativeSessions({ central: true, on: true, fetch: ok })).toEqual([])
    expect(await loadNativeSessions({ on: false, fetch: ok })).toEqual([])
  })
  test('an absent or failing engine answers nothing rather than throwing', async () => {
    expect(await loadNativeSessions({ on: true, fetch: async () => null })).toEqual([])
    expect(await loadNativeSessions({ on: true, fetch: async () => new Response('x', { status: 500 }) })).toEqual([])
    expect(await loadNativeSessions({ on: true, fetch: async () => { throw new Error('boom') } })).toEqual([])
  })
  test('the engine answer becomes rows', async () => {
    const rows = await loadNativeSessions({ on: true, fetch: ok })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.harness).toBe('agentistics')
  })
})
