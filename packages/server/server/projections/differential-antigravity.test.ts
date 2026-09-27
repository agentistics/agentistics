/** The agy parity row over the fixture: every field equal, or explained with its per-session proof. */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { buildFixtureRoot } from '../integrations/antigravity/fixture-db'
import { ANTIGRAVITY_EXPLANATIONS, runAntigravityDifferential } from './differential-antigravity'

const FIX = join(import.meta.dir, '../../test/fixtures/antigravity-replay')
const LATER = Date.parse('2027-01-01T00:00:00Z')

describe('agy differential — fixture', () => {
  test('no bug row; the same sessions on both sides', async () => {
    const r = await runAntigravityDifferential({ rootDir: buildFixtureRoot(FIX), now: () => LATER, keepDiffs: true })
    expect(r.sessions).toBe(1)
    expect(r.sessionsWithBugs).toBe(0)
    expect(r.legacyOnly).toEqual([])
    expect(r.replayOnly).toEqual([])
  })

  test('each explained row carries its own sentence', async () => {
    const r = await runAntigravityDifferential({ rootDir: buildFixtureRoot(FIX), now: () => LATER, keepDiffs: true })
    const rows = r.diffs![0]!.rows
    const reasonOf = (f: string) => rows.find(x => x.field === f)?.reason
    expect(reasonOf('input_tokens')).toBe(ANTIGRAVITY_EXPLANATIONS.childRollup)
    expect(reasonOf('costUSD')).toBe(ANTIGRAVITY_EXPLANATIONS.childRollup)
    expect(reasonOf('tool_counts')).toBe(ANTIGRAVITY_EXPLANATIONS.childRollup)
    expect(reasonOf('agentMetrics.totalTokens')).toBe(ANTIGRAVITY_EXPLANATIONS.childAgentNew)
    expect(reasonOf('active_minutes')).toBe(ANTIGRAVITY_EXPLANATIONS.slashTurn)
    expect(rows.find(x => x.field === 'daily.2026-08-14.tokens')?.reason).toBe(ANTIGRAVITY_EXPLANATIONS.dailyNew)
    expect(rows.find(x => x.field === 'user_interruptions')?.verdict).toBe('not-projectable')
    for (const f of ['start_time', 'end_time', 'user_message_count', 'user_message_timestamps', 'tool_errors',
      'tool_error_categories', 'uses_task_agent', 'uses_web_search', 'model', 'context_tokens', 'context_window']) {
      expect(rows.find(x => x.field === f)?.verdict).toBe('equal')
    }
  })
})

describe('agy differential — the redacted real parent/child pair', () => {
  test('no bug; the rollup and the child agent are explained with legacy\'s own numbers', async () => {
    const REAL = join(import.meta.dir, '../../test/fixtures/antigravity-replay-real')
    const r = await runAntigravityDifferential({ rootDir: buildFixtureRoot(REAL), now: () => LATER, keepDiffs: true })
    expect(r.sessionsWithBugs).toBe(0)
    const rows = r.diffs![0]!.rows
    const pick = (f: string) => { const x = rows.find(y => y.field === f)!; return [x.verdict, x.legacy, x.projected] }
    expect(pick('input_tokens')).toEqual(['explained', 1059186, 532274])
    expect(pick('cache_read_input_tokens')).toEqual(['explained', 2367988, 980382])
    expect(pick('agentMetrics.totalTokens')).toEqual(['explained', 0, 1929735])
    expect(pick('duration_minutes')[0]).toBe('explained')
    expect(pick('active_minutes')[0]).toBe('equal')
    expect(pick('user_message_timestamps')[0]).toBe('equal')
  })
})
