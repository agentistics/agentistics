import { describe, expect, test } from 'bun:test'
import { MODEL_PRICING, hermesModelId, type AppData, type Filters, type SessionMeta } from '@agentistics/core'
import { computeDerivedStats, computeHarnessSummaries } from './useData'

// A model Ollama serves must be no spend on Home, Compare or Costs, even when the community table
// holds a hosted model of the same name.
describe('hermes local model', () => {
  test('llama3:8b via ollama adds no cost', () => {
    MODEL_PRICING['llama3-8b-instruct'] = { input: 0.2, output: 0.2, cacheRead: 0.2, cacheWrite: 0.2, cacheWrite1h: 0.2 }
    try {
      const sessions = ['ollama:llama3:8b', 'llama3:8b'].map((raw, i) => ({
        session_id: `h${i}`, harness: 'hermes', start_time: '2026-06-11T09:00:00Z', project_path: '/p',
        user_message_count: 1, assistant_message_count: 1, input_tokens: 1e6, output_tokens: 1e6,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: hermesModelId(raw, { provider: 'local' }),
        tool_counts: {}, tool_output_tokens: {}, languages: [], message_hours: [], user_response_times: [],
        user_message_timestamps: [], tool_error_categories: {}, git_commits: 0, git_pushes: 0,
      })) as unknown as SessionMeta[]
      const data = {
        statsCache: { dailyActivity: [], dailyModelTokens: [], modelUsage: {}, hourCounts: {} },
        sessions, allSessions: sessions, projects: [], harnesses: ['hermes'],
      } as unknown as AppData

      const d = computeDerivedStats(data, { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] } as Filters)!
      expect(d.totalCostUSD).toBe(0)
      expect(Object.values(d.modelUsage).map(u => u.inputTokens).reduce((a, b) => a + b, 0)).toBe(2e6)
      expect(d.apiCostByDay.days.hermes?.['2026-06-11']?.costUSD ?? 0).toBe(0)

      const compare = computeHarnessSummaries(data).hermes!
      expect(compare.costUSD).toBe(0)
      expect(compare.models.map(m => [m.model, m.costUSD]).sort()).toEqual([['local/llama3:8b', 0], ['ollama/llama3:8b', 0]])
    } finally { delete MODEL_PRICING['llama3-8b-instruct'] }
  })
})
