import { test, expect } from 'bun:test'
import { rankTop, planCostOf, shareOf } from './topUsage'
import type { HarnessId, ModelUsage, SessionMeta } from '@agentistics/core'

const usage = (input: number, output: number): ModelUsage => ({
  inputTokens: input, outputTokens: output,
  cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
  webSearchRequests: 0, costUSD: 0,
})

function s(over: Partial<SessionMeta>): SessionMeta {
  return {
    session_id: Math.random().toString(36).slice(2),
    project_path: '/p', harness: 'claude' as HarnessId,
    input_tokens: 0, output_tokens: 0,
    ...over,
  } as SessionMeta
}

test('ranks by the chosen metric, and the metrics genuinely disagree', () => {
  // One expensive session against many cheap ones: cost and sessions name different winners, which
  // is the whole reason the metric is a choice rather than a fixed definition of "usage".
  const sessions = [
    s({ harness: 'claude', model: 'claude-opus-5', input_tokens: 1_000_000, output_tokens: 100_000 }),
    ...Array.from({ length: 5 }, () => s({ harness: 'codex', model: 'gpt-5-mini', input_tokens: 1000, output_tokens: 100 })),
  ]
  expect(rankTop(sessions, 'harness', 'cost').entries[0]!.key).toBe('claude')
  expect(rankTop(sessions, 'harness', 'sessions').entries[0]!.key).toBe('codex')
})

test('a multi-model session is split per model, not filed under one label', () => {
  // An Antigravity parent with its sub-agents folded in runs Opus AND Gemini Flash. Attributing the
  // whole session to one of them would hand the cheap model the expensive one's spend.
  const session = s({
    harness: 'antigravity',
    model: 'claude-opus-5',
    model_usage: {
      'claude-opus-5': usage(1_000_000, 0),
      'gemini-3.5-flash-lite': usage(1_000_000, 0),
    },
  })
  const r = rankTop([session], 'model', 'cost')
  expect(r.distinct).toBe(2)
  const opus = r.entries.find(e => e.key === 'claude-opus-5')!
  const flash = r.entries.find(e => e.key === 'gemini-3.5-flash-lite')!
  expect(opus.cost).toBeCloseTo(5, 5)     // 1M input at $5/1M
  expect(flash.cost).toBeCloseTo(0.3, 5)  // 1M input at $0.30/1M
  // Both models were touched by that one session.
  expect(opus.sessions).toBe(1)
  expect(flash.sessions).toBe(1)
})

test('worktrees fold into their project rather than ranking separately', () => {
  const sessions = [
    s({ project_path: '/home/u/pulsar' }),
    s({ project_path: '/home/u/pulsar/.claude/worktrees/feature-a' }),
    s({ project_path: '/home/u/pulsar/.claude/worktrees/feature-b' }),
  ]
  const r = rankTop(sessions, 'project', 'sessions')
  expect(r.distinct).toBe(1)
  expect(r.entries[0]).toMatchObject({ key: '/home/u/pulsar', sessions: 3 })
})

test('sessions with nothing to attribute are skipped, not bucketed as empty', () => {
  const r = rankTop([s({ git_remote: '' }), s({ git_remote: undefined })], 'repo', 'sessions')
  expect(r.entries).toEqual([])
  expect(r.distinct).toBe(0)
  expect(r.total).toBe(0)
})

test('tokens_unavailable sessions are absent from token and cost leaderboards', () => {
  const r = rankTop([s({ harness: 'codex', model: 'gpt-5', tokens_unavailable: true, input_tokens: 1000, output_tokens: 500 })], 'harness', 'tokens')
  expect(r.entries).toEqual([])
  expect(r.total).toBe(0)
})

test('only the top N are returned, but the total counts everything', () => {
  const sessions = Array.from({ length: 6 }, (_, i) =>
    s({ project_path: `/p${i}`, input_tokens: (i + 1) * 1000 }))
  const r = rankTop(sessions, 'project', 'tokens', 3)
  expect(r.entries.length).toBe(3)
  expect(r.distinct).toBe(6)
  // The share of first place must be measured against ALL six, not just the podium.
  expect(r.total).toBe(1000 + 2000 + 3000 + 4000 + 5000 + 6000)
  expect(shareOf(r.entries[0]!, r, 'tokens')).toBeCloseTo(6000 / 21000, 5)
})

test('ties resolve deterministically instead of shuffling between renders', () => {
  const mk = () => [s({ project_path: '/b' }), s({ project_path: '/a' })]
  const first = rankTop(mk(), 'project', 'sessions').entries.map(e => e.key)
  const second = rankTop(mk().reverse(), 'project', 'sessions').entries.map(e => e.key)
  expect(first).toEqual(second)
  expect(first).toEqual(['/a', '/b'])
})

test('shareOf is zero rather than NaN when there is nothing to share', () => {
  const empty = rankTop([], 'harness', 'cost')
  expect(shareOf({ key: 'x', cost: 0, tokens: 0, sessions: 0 }, empty, 'cost')).toBe(0)
})

test('mixed rows keep an uncovered harness at API price and totals close to their rows', () => {
  const split = { claude: 10, antigravity: 20 }
  const factors = { claude: 0.2, antigravity: null }
  expect(planCostOf({ antigravity: 20 }, factors)).toBe(20)
  expect(planCostOf(split, factors)).toBe(22)
  expect(planCostOf(split, factors)).toBe(
    planCostOf({ claude: 10 }, factors) + planCostOf({ antigravity: 20 }, factors),
  )
})
