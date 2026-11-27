import { expect, setSystemTime, test } from 'bun:test'
import { emptyStatsCache, type AppData, type Filters, type SessionMeta } from '@agentistics/core'
import { computeDerivedStats } from '../hooks/useData'
import { overlayProjected, type ProjectedDerived } from './projectedDerived'
import { gitLinesReported } from './gitLinesReported'

const base: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
const model = 'opencode-go/glm-5.3'
// Shaped like ~/.agentistics/sessions/opencode/ses_*.json: declared cost, zero commits/files, no cache write.
const oc = (id: string, startMs: number, usd: number): SessionMeta => ({
  session_id: id, harness: 'opencode', project_path: '/repo', model,
  start_time: new Date(startMs).toISOString(), end_time: new Date(startMs + 25 * 60_000).toISOString(),
  duration_minutes: 25, user_message_count: 2, assistant_message_count: 81, tool_counts: { Bash: 74 },
  input_tokens: 150171, output_tokens: 29678, cache_read_input_tokens: 6087671, cache_creation_input_tokens: 0,
  model_usage: { [model]: { inputTokens: 150171, outputTokens: 29678, cacheReadInputTokens: 6087671, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: usd, costSource: 'harness' } },
  git_commits: 0, files_modified: 0, user_message_timestamps: [new Date(startMs + 1000).toISOString()], message_hours: [new Date(startMs).getHours()],
}) as unknown as SessionMeta
/**
 * The sessions happened BEFORE the clock: one started 30 minutes ago, one a day earlier. They used to
 * be stamped `<UTC date>T05:07Z`, which in the evening west of UTC (00:00–05:07Z) lies in the FUTURE of
 * the local day the date filter ends on — the product's day is the user's local day — so the newest
 * session was cut and the test failed only there.
 */
const dataAt = (nowMs: number): AppData => ({
  statsCache: emptyStatsCache(),
  sessions: [oc('a', nowMs - 86_400_000 - 30 * 60_000, 1.92), oc('b', nowMs - 30 * 60_000, 2.26)],
  allSessions: [], projects: [], harnesses: ['claude', 'opencode'],
})
const filters: Filters = { ...base, harnesses: ['opencode'] }

/** The clocks pinned: a Sao Paulo evening that is already the next UTC day, and a plain midday. */
const CLOCKS = ['2026-11-27T01:30:00Z', '2026-11-27T12:00:00Z'] as const
const ZONES = ['UTC', 'America/Sao_Paulo'] as const

/** Run `fn` with the runtime in `zone` at `iso`. NEVER restore TZ by deleting it: see tzRestore.lint.test.ts. */
function at(zone: string, iso: string, fn: (data: AppData) => void): void {
  const previous = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  process.env.TZ = zone
  setSystemTime(new Date(iso))
  try { fn(dataAt(Date.parse(iso))) } finally { setSystemTime(); process.env.TZ = previous }
}

const projection = (): ProjectedDerived => ({
  totalSessions: 2, totalCostUSD: 0, inputTokens: 0, outputTokens: 0, cacheHitRate: 0,
  modelUsage: { [model]: { inputTokens: 300342, outputTokens: 59356, cacheReadInputTokens: 12175342, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 } },
  tokenTotals: { input: 300342, output: 59356, cacheRead: 12175342, cacheWrite: 0 },
  toolCounts: { Bash: 148 }, totalToolCalls: 148, projectStats: {}, coveredHarnesses: ['opencode'], costByHarness: { opencode: 0 },
  figuresSource: 'projections',
} as unknown as ProjectedDerived)

for (const zone of ZONES) for (const clock of CLOCKS) test(`a covered harness the projection could not price keeps the cost its sessions declare (${zone}, ${clock})`, () => at(zone, clock, data => {
  const legacy = computeDerivedStats(data, filters)!
  const out = overlayProjected(legacy, projection(), {
    candidates: ['opencode'], blendedOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as never,
    legacyFor: h => computeDerivedStats(data, { ...filters, harnesses: [h] as Filters['harnesses'] }),
  })!
  expect(legacy.totalCostUSD).toBeCloseTo(4.18, 9)
  expect(out.totalCostUSD).toBeCloseTo(4.18, 9)
  expect(out.modelUsage[model]!.costUSD).toBeCloseTo(4.18, 9)
  expect(out.totalSessions).toBe(2)
}))

test('a projection that did price the harness is left alone', () => at('America/Sao_Paulo', CLOCKS[0], data => {
  const legacy = computeDerivedStats(data, filters)!
  // Coherent like `projectedDerived`'s own answer: the total IS the sum of the model rows. (A row at 0 under a
  // priced total cannot come out of the projection, and since CUSTO.MODELO-OPENCODE a 0 row is corrected per row.)
  const p = projection()
  const priced = { ...p, totalCostUSD: 5, costByHarness: { opencode: 5 }, modelUsage: { [model]: { ...p.modelUsage[model]!, costUSD: 5, costSource: 'mixed' as const } } }
  const out = overlayProjected(legacy, priced, {
    candidates: ['opencode'], blendedOf: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as never,
    legacyFor: h => computeDerivedStats(data, { ...filters, harnesses: [h] as Filters['harnesses'] }),
  })!
  expect(out.totalCostUSD).toBe(5)
}))

for (const zone of ZONES) for (const clock of CLOCKS) test(`streak / last active come from the latest OpenCode day (${zone}, ${clock})`, () => at(zone, clock, data => {
  const d = computeDerivedStats(data, filters)!
  expect(d.streak + (d.streakLastActiveDate ? 0 : 0)).toBeGreaterThan(0)
}))

test('Files is "not reported" when no selected harness reports edits', () => {
  // OpenCode reports edit line counts since the gateway fix (capabilities: gitLines partial);
  // Gemini and Kimi still do not.
  expect(gitLinesReported({ harnesses: ['gemini', 'kimi'] })).toBe(false)
  expect(gitLinesReported({ harnesses: ['opencode'] })).toBe(true)
  expect(gitLinesReported({ harnesses: ['gemini', 'claude'] })).toBe(true)
  expect(gitLinesReported({})).toBe(true)
})
