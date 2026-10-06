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

// --- cache-backed person / machine podiums ---------------------------------------------------

import { rankTopFromCaches, cacheTotalsUsable } from './topUsage'
import type { Filters, StatsCache } from '@agentistics/core'

const cache = (over: Partial<StatsCache>): StatsCache => ({
  version: 1, lastComputedDate: '2026-07-19',
  dailyActivity: [], dailyModelTokens: [], modelUsage: {},
  totalSessions: 0, totalMessages: 0, hourCounts: {},
  ...over,
} as StatsCache)

// Real proportions from a live machine: cache reads are ~96% of the billed volume, so a podium
// that ignores them ranks by the sliver that costs almost nothing.
const heavy = cache({
  modelUsage: {
    'claude-opus-4-8': {
      inputTokens: 5_552_632, outputTokens: 21_940_184,
      cacheReadInputTokens: 5_184_768_713, cacheCreationInputTokens: 166_252_232,
      webSearchRequests: 0, costUSD: 0,
    },
  },
  dailyActivity: [{ date: '2026-07-01', sessionCount: 449, messageCount: 89_816, toolCallCount: 0 }],
})
const light = cache({
  modelUsage: {
    'claude-sonnet-4-6': {
      inputTokens: 100_000, outputTokens: 200_000,
      cacheReadInputTokens: 10_000_000, cacheCreationInputTokens: 500_000,
      webSearchRequests: 0, costUSD: 0,
    },
  },
  dailyActivity: [{ date: '2026-07-01', sessionCount: 12, messageCount: 400, toolCallCount: 0 }],
})

/** A surviving session document — it decides WHO is on the podium, not how much. */
const claudeSess = (user: string, day: string): SessionMeta => ({
  session_id: `${user}-${day}`, harness: 'claude', user,
  start_time: `${day}T12:00:00`, project_path: '/p',
} as unknown as SessionMeta)

/** A non-Claude session: its spend exists in no statsCache, so it must be added on top. */
const codexSess = (user: string, day: string, input: number, output: number): SessionMeta => ({
  session_id: `${user}-codex-${day}`, harness: 'codex', user, model: 'gpt-5',
  start_time: `${day}T12:00:00`, project_path: '/p',
  input_tokens: input, output_tokens: output,
} as unknown as SessionMeta)

const baseFilters: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }

test('cacheTotalsUsable: only a slice the caches cannot represent disqualifies them', () => {
  expect(cacheTotalsUsable(baseFilters)).toBe(true)
  // Selecting WHICH caches to read is fine — the caches are still read whole.
  expect(cacheTotalsUsable({ ...baseFilters, users: ['Bryan'], machines: ['m1'], teams: ['t'] })).toBe(true)
  expect(cacheTotalsUsable({ ...baseFilters, presence: 'online' })).toBe(true)
  // A slice INSIDE a cache is not representable — statsCache has no such granularity.
  expect(cacheTotalsUsable({ ...baseFilters, dateRange: '30d' })).toBe(false)
  expect(cacheTotalsUsable({ ...baseFilters, customStart: '2026-01-01' })).toBe(false)
  expect(cacheTotalsUsable({ ...baseFilters, projects: ['/p'] })).toBe(false)
  expect(cacheTotalsUsable({ ...baseFilters, repos: ['github.com/o/r'] })).toBe(false)
  expect(cacheTotalsUsable({ ...baseFilters, tags: ['t1'] })).toBe(false)
  expect(cacheTotalsUsable({ ...baseFilters, models: ['claude-opus-4-8'] })).toBe(false)
  // statsCache is Claude-only, so a harness selection cannot be answered from it either.
  expect(cacheTotalsUsable({ ...baseFilters, harnesses: ['codex'] })).toBe(false)
})

test('rankTopFromCaches ranks on the full history, cache tokens included', () => {
  const caches = { Bryan: heavy, Vini: light }
  // One surviving session each — the scope comes from the sessions, the money from the caches.
  const scope = [claudeSess('Bryan', '2026-07-01'), claudeSess('Vini', '2026-07-01')]

  const byCost = rankTopFromCaches(caches, scope, s => s.user ?? '', 'cost')
  expect(byCost.entries.map(e => e.key)).toEqual(['Bryan', 'Vini'])
  expect(byCost.distinct).toBe(2)
  // Opus 4.8 at 5/25/0.5/6.25 per 1M — dominated by the 5.18B cache reads ($2,592) and the
  // 166M cache writes ($1,039), NOT by input+output ($577).
  expect(byCost.entries[0]!.cost).toBeCloseTo(4208, -1)
  expect(byCost.entries[0]!.tokens).toBe(5_552_632 + 21_940_184 + 5_184_768_713 + 166_252_232)
  // The share denominator is the whole, so the two must add up to the reported total.
  expect(byCost.total).toBeCloseTo(byCost.entries[0]!.cost + byCost.entries[1]!.cost, 6)

  // Sessions come from the deep dailyActivity, which is the point: the surviving session
  // documents are a fraction of it. The one session above is on a day the cache already
  // covers, so it must NOT be added on top.
  expect(rankTopFromCaches(caches, scope, s => s.user ?? '', 'sessions').entries[0]!.sessions).toBe(449)
})

test('rankTopFromCaches honours the filtered scope and never invents a key', () => {
  const caches = { Bryan: heavy, Vini: light }
  const only = rankTopFromCaches(caches, [claudeSess('Vini', '2026-07-01')], s => s.user ?? '', 'cost')
  expect(only.entries.map(e => e.key)).toEqual(['Vini'])
  expect(only.distinct).toBe(1)
  // A member filtered out contributes nothing to the total, so shares stay out of 100%.
  expect(only.total).toBeCloseTo(only.entries[0]!.cost, 6)
  // A key with no session at all is absent — the caches never widen the scope.
  expect(rankTopFromCaches(caches, [], s => s.user ?? '', 'cost').entries).toEqual([])
})

test('rankTopFromCaches adds the non-Claude spend the caches cannot hold', () => {
  // stats-cache.json is Claude-only. Ana runs Claude AND Codex; reading the caches alone reported
  // her at the Claude sliver and put her at the bottom of a podium she should top.
  const caches = { Ana: light }
  const withCodex = [
    claudeSess('Ana', '2026-07-01'),
    codexSess('Ana', '2026-07-01', 20_000_000, 20_000_000),
  ]
  const cacheOnly = rankTopFromCaches(caches, [claudeSess('Ana', '2026-07-01')], s => s.user ?? '', 'cost')
  const both = rankTopFromCaches(caches, withCodex, s => s.user ?? '', 'cost')

  expect(both.entries[0]!.cost).toBeGreaterThan(cacheOnly.entries[0]!.cost)
  expect(both.entries[0]!.tokens).toBe(cacheOnly.entries[0]!.tokens + 40_000_000)
  // The Codex session is a session too — and it is on a day the Claude cache "covers", which must
  // not suppress it: that gap rule applies to Claude sessions only.
  expect(both.entries[0]!.sessions).toBe(cacheOnly.entries[0]!.sessions + 1)
})

test('rankTopFromCaches counts a Claude session only on days the cache has not computed', () => {
  const caches = { Bryan: heavy }   // dailyActivity covers 2026-07-01 with 449 sessions
  const keyOf = (s: { user?: string }) => s.user ?? ''
  const covered = rankTopFromCaches(caches, [claudeSess('Bryan', '2026-07-01')], keyOf, 'sessions')
  const gapDay = rankTopFromCaches(caches, [claudeSess('Bryan', '2026-07-20')], keyOf, 'sessions')
  expect(covered.entries[0]!.sessions).toBe(449)
  expect(gapDay.entries[0]!.sessions).toBe(450)
  // Money is NOT gap-filled: modelUsage already holds it whole, so adding it would double-count.
  expect(gapDay.entries[0]!.cost).toBeCloseTo(covered.entries[0]!.cost, 6)
})

test('rankTopFromCaches puts a member with sessions but no cache on the podium', () => {
  // A member who only ever ran a non-Claude CLI has no statsCache at all; dropping them would
  // hide real spend behind "no cache" rather than report it.
  const out = rankTopFromCaches({}, [codexSess('Solo', '2026-07-01', 10_000_000, 5_000_000)], s => s.user ?? '', 'cost')
  expect(out.entries.map(e => e.key)).toEqual(['Solo'])
  expect(out.entries[0]!.cost).toBeGreaterThan(0)
  expect(out.entries[0]!.sessions).toBe(1)
})
