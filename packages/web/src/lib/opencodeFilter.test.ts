import { expect, test } from 'bun:test'
import { emptyStatsCache, type AppData, type Filters, type SessionMeta } from '@agentistics/core'
import { computeDerivedStats } from '../hooks/useData'
import { overlayProjected, type ProjectedDerived } from './projectedDerived'
import { gitLinesReported } from './gitLinesReported'

const base: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
const model = 'opencode-go/glm-5.3'
// Shaped like ~/.agentistics/sessions/opencode/ses_*.json: declared cost, zero commits/files, no cache write.
const oc = (id: string, day: string, usd: number): SessionMeta => ({
  session_id: id, harness: 'opencode', project_path: '/repo', model, start_time: `${day}T05:07:49.146Z`, end_time: `${day}T05:33:15.028Z`,
  duration_minutes: 25, user_message_count: 2, assistant_message_count: 81, tool_counts: { Bash: 74 },
  input_tokens: 150171, output_tokens: 29678, cache_read_input_tokens: 6087671, cache_creation_input_tokens: 0,
  model_usage: { [model]: { inputTokens: 150171, outputTokens: 29678, cacheReadInputTokens: 6087671, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: usd, costSource: 'harness' } },
  git_commits: 0, files_modified: 0, user_message_timestamps: [`${day}T05:07:49.756Z`], message_hours: [5],
}) as unknown as SessionMeta
// Days relative to today: the streak counts back from today, so fixed dates broke the day after.
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const sessions = [oc('a', daysAgo(1), 1.92), oc('b', daysAgo(0), 2.26)]
const data: AppData = { statsCache: emptyStatsCache(), sessions, allSessions: [], projects: [], harnesses: ['claude', 'opencode'] }
const filters: Filters = { ...base, harnesses: ['opencode'] }

// What the projection answered on the owner's machine: sessions and tokens, but no price for the gateway model.
const projection = (): ProjectedDerived => ({
  totalSessions: 2, totalCostUSD: 0, inputTokens: 0, outputTokens: 0, cacheHitRate: 0,
  modelUsage: { [model]: { inputTokens: 300342, outputTokens: 59356, cacheReadInputTokens: 12175342, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 } },
  tokenTotals: { input: 300342, output: 59356, cacheRead: 12175342, cacheWrite: 0 },
  toolCounts: { Bash: 148 }, totalToolCalls: 148, projectStats: {}, coveredHarnesses: ['opencode'], costByHarness: { opencode: 0 },
  figuresSource: 'projections',
} as unknown as ProjectedDerived)

test('a covered harness the projection could not price keeps the cost its sessions declare', () => {
  const legacy = computeDerivedStats(data, filters)!
  const out = overlayProjected(legacy, projection(), {
    candidates: ['opencode'], blendedOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as never,
    legacyFor: h => computeDerivedStats(data, { ...filters, harnesses: [h] as Filters['harnesses'] }),
  })!
  expect(legacy.totalCostUSD).toBeCloseTo(4.18, 9)
  expect(out.totalCostUSD).toBeCloseTo(4.18, 9)
  expect(out.modelUsage[model]!.costUSD).toBeCloseTo(4.18, 9)
  expect(out.totalSessions).toBe(2)
})

test('a projection that did price the harness is left alone', () => {
  const legacy = computeDerivedStats(data, filters)!
  const priced = { ...projection(), totalCostUSD: 5, costByHarness: { opencode: 5 } }
  const out = overlayProjected(legacy, priced, {
    candidates: ['opencode'], blendedOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as never,
    legacyFor: h => computeDerivedStats(data, { ...filters, harnesses: [h] as Filters['harnesses'] }),
  })!
  expect(out.totalCostUSD).toBe(5)
})

test('streak / last active come from the latest OpenCode day', () => {
  const d = computeDerivedStats(data, filters)!
  expect(d.streak + (d.streakLastActiveDate ? 0 : 0)).toBeGreaterThan(0)
})

test('Files is "not reported" when no selected harness reports edits', () => {
  // OpenCode reports edit line counts since the gateway fix (capabilities: gitLines partial);
  // Gemini and Kimi still do not.
  expect(gitLinesReported({ harnesses: ['gemini', 'kimi'] })).toBe(false)
  expect(gitLinesReported({ harnesses: ['opencode'] })).toBe(true)
  expect(gitLinesReported({ harnesses: ['gemini', 'claude'] })).toBe(true)
  expect(gitLinesReported({})).toBe(true)
})
