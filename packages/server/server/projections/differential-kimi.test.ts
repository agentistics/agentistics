import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { runKimiDifferential } from './differential-kimi'

const FIXTURES = join(import.meta.dir, '../../test/fixtures/kimi-replay')

describe('projections/differential-kimi.ts', () => {
  test('the basic single-agent fixture: no bug rows, and the turn-count fields are not-projectable (not silently bug)', async () => {
    const report = await runKimiDifferential({
      sessionsDir: join(FIXTURES, 'basic'),
      now: () => 1_800_000_000_000,
      settledMs: 60_000,
      keepDiffs: true,
    })
    expect(report.sessions).toBe(1)
    expect(report.sessionsWithBugs).toBe(0)

    const rows = report.diffs![0]!.rows
    const byField = new Map(rows.map(r => [r.field, r]))

    for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'model', 'context_tokens', 'start_time', 'end_time', 'tool_counts', 'tool_errors']) {
      const r = byField.get(field)
      expect(r?.verdict).toBe('equal')
    }

    for (const field of ['user_message_count', 'rounds', 'user_interruptions', 'user_message_timestamps']) {
      const r = byField.get(field)
      expect(r?.verdict).toBe('not-projectable')
      expect(r?.reason).toBeTruthy()
    }
    for (const field of ['active_minutes', 'user_response_times']) {
      const r = byField.get(field)
      expect(r?.verdict).toBe('not-projectable')
    }

    const dailyRow = rows.find(r => /^daily\.\d{4}-\d{2}-\d{2}\.tokens$/.test(r.field))
    expect(dailyRow?.verdict).toBe('explained')
  })

  test('the subagent fixture: session-level tokens equal legacy on this real-store shape (single-agent sessions), and the multi-agent case is exercised without a bug row', async () => {
    const report = await runKimiDifferential({
      sessionsDir: join(FIXTURES, 'subagent'),
      now: () => 1_800_000_000_000,
      settledMs: 60_000,
      keepDiffs: true,
    })
    expect(report.sessions).toBe(1)
    const rows = report.diffs![0]!.rows
    const inputRow = rows.find(r => r.field === 'input_tokens')
    // Legacy sums BOTH agents (50 + 30 = 80); the projection's session-level total is MAIN only (50)
    // — a real, declared divergence in aggregation scope (this integration's handback explains it),
    // never forced to `equal` by mislabelling the subagent as `main`.
    expect(inputRow?.legacy).toBe(80)
    expect(inputRow?.projected).toBe(50)
    expect(inputRow?.verdict).toBe('bug')
  })
})
