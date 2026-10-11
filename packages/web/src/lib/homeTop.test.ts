import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import {
  hourProfile, lastActiveDay, rankHarnesses, rankModels, rankProjects, rankSessions, rankTools,
  sessionDayLocal, sessionsOnDay, shareOf,
} from './homeTop'

const s = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 'a',
  project_path: '/repo/one',
  harness: 'claude',
  model: 'claude-opus-5',
  start_time: '2026-08-15T14:00:00.000Z',
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 900_000,
  cache_creation_input_tokens: 10_000,
  ...over,
} as SessionMeta)

const label = (x: SessionMeta) => x.first_prompt ?? x.session_id

describe('the day a card is about', () => {
  it('is derived from the DATA, not from the clock', () => {
    // With a date filter on, "today" may hold nothing at all, and a card rendering an empty day
    // beside a filter plainly full of sessions reads as broken rather than as an empty Tuesday.
    const list = [
      s({ session_id: '1', start_time: '2026-08-10T10:00:00.000Z' }),
      s({ session_id: '2', start_time: '2026-08-12T10:00:00.000Z' }),
      s({ session_id: '3', start_time: '2026-08-11T10:00:00.000Z' }),
    ]
    expect(lastActiveDay(list)).toBe('2026-08-12')
    expect(sessionsOnDay(list, lastActiveDay(list)).map(x => x.session_id)).toEqual(['2'])
  })

  it('is null over an empty set, and over sessions with no usable start time', () => {
    expect(lastActiveDay([])).toBeNull()
    expect(lastActiveDay([s({ start_time: '' }), s({ start_time: 'not a date' })])).toBeNull()
    expect(sessionDayLocal(s({ start_time: '' }))).toBeNull()
    // A day nobody could name selects nothing rather than everything.
    expect(sessionsOnDay([s()], null)).toEqual([])
  })
})

describe('the boards', () => {
  it('ranks sessions by every billed counter, not by the conversation', () => {
    const big = s({ session_id: 'cached', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 5_000_000, cache_creation_input_tokens: 0 })
    const chatty = s({ session_id: 'chatty', input_tokens: 100_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    const board = rankSessions([chatty, big], 'tokens', label)
    // The cached session is 25x the volume; ranking on input+output would have put it second.
    expect(board.entries[0]!.key).toBe('cached')
    expect(board.entries[0]!.tokens).toBe(5_000_020)
  })

  it('splits a multi-model session across its models rather than filing it under one', () => {
    const multi = s({
      session_id: 'm',
      model: 'claude-opus-5',
      model_usage: {
        'claude-opus-5': { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 },
        'gemini-3.6-flash': { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 },
      },
    } as Partial<SessionMeta>)
    const board = rankModels([multi], 'tokens')
    expect(board.entries.map(e => e.key).sort()).toEqual(['claude-opus-5', 'gemini-3.6-flash'])
    expect(board.entries.find(e => e.key === 'gemini-3.6-flash')!.tokens).toBe(55)
    // Both models were touched by the one session.
    expect(board.distinct).toBe(2)
  })

  it('groups harnesses and projects, and takes the top N of a longer list', () => {
    const list = [
      s({ session_id: '1', harness: 'claude', project_path: '/a' }),
      s({ session_id: '2', harness: 'codex', project_path: '/b' }),
      s({ session_id: '3', harness: 'codex', project_path: '/b' }),
    ]
    expect(rankHarnesses(list, 'sessions').entries[0]).toMatchObject({ key: 'codex', sessions: 2 })
    const projects = rankProjects(list, 'sessions', 1)
    expect(projects.entries).toHaveLength(1)
    expect(projects.distinct).toBe(2)
    // The total spans every entry, not only the one shown — a share needs its whole.
    expect(projects.total).toBe(3)
  })

  it('skips a session with no project rather than inventing a bucket for it', () => {
    expect(rankProjects([s({ project_path: '' })], 'sessions').distinct).toBe(0)
  })

  it('skips tokens_unavailable sessions from board sums and costs', () => {
    const unavailable = s({ tokens_unavailable: true, input_tokens: 1000, output_tokens: 500 })
    expect(rankSessions([unavailable], 'tokens', label)).toEqual({ entries: [], total: 0, distinct: 0 })
    expect(rankHarnesses([unavailable], 'cost')).toEqual({ entries: [], total: 0, distinct: 0 })
  })

  it('ranks tools by calls, and totals every tool not just the shown ones', () => {
    const list = [
      s({ session_id: '1', tool_counts: { Bash: 30, Read: 5, Edit: 2 } }),
      s({ session_id: '2', tool_counts: { Bash: 12, Grep: 1 } }),
    ] as SessionMeta[]
    const board = rankTools(list, 2)
    expect(board.entries.map(e => e.key)).toEqual(['Bash', 'Read'])
    expect(board.entries[0]!.calls).toBe(42)
    expect(board.total).toBe(50)
    expect(board.distinct).toBe(4)
    expect(shareOf(board.entries[0]!, board, 'calls')).toBeCloseTo(42 / 50, 10)
  })
})

describe('the peak hour', () => {
  it('reports the busiest local hour and its share', () => {
    const list = [s({ message_hours: [14, 14, 14, 9] })] as SessionMeta[]
    const { peak } = hourProfile(list)
    expect(peak).toEqual({ hour: 14, messages: 3, share: 0.75 })
  })

  it('is NULL with no data — never hour 0, which is a real answer', () => {
    // "No data" must not be able to impersonate midnight.
    expect(hourProfile([]).peak).toBeNull()
    expect(hourProfile([s({ message_hours: [] })]).peak).toBeNull()
    const midnight = hourProfile([s({ message_hours: [0, 0] })] as SessionMeta[])
    expect(midnight.peak).toMatchObject({ hour: 0, messages: 2 })
  })

  it('ignores an out-of-range or non-integer hour rather than throwing', () => {
    const junk = [s({ message_hours: [24, -1, 3.5, 7] as number[] })] as SessionMeta[]
    expect(hourProfile(junk).peak).toMatchObject({ hour: 7, messages: 1 })
  })
})

describe('shares', () => {
  it('are zero rather than NaN when the board is empty', () => {
    const board = rankTools([])
    expect(board.total).toBe(0)
    expect(shareOf({ key: 'x', label: 'x', cost: 0, tokens: 0, sessions: 0, calls: 0 }, board, 'calls')).toBe(0)
  })
})
