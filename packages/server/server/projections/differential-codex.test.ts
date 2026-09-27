/**
 * The Codex differential over the redacted fixtures: no `bug` row, and every `explained` row is one
 * whose proof held for THAT session. The synthetic rollout (…05) is the one that exercises what this
 * machine's store never did — a counter reset, a model switch, a web_search_call.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCodexRollout } from '../adapters/codex-parse'
import { collectRollouts, fallbackIdOf, rolloutIdOf } from '../integrations/codex'
import { codexContext } from '../integrations/codex/replay-core'
import { replayCodexRollout } from '../integrations/codex/replay'
import { iterLines } from '../jsonl'
import {
  CODEX_EXPLANATIONS, compareCodexSession, projectCodex, recountCodex, runCodexDifferential,
} from './differential-codex'

const SESSIONS = join(import.meta.dir, '../../test/fixtures/codex-replay/sessions')
const far = () => Date.parse('2100-01-01T00:00:00.000Z')

describe('runCodexDifferential over the fixtures', async () => {
  const report = await runCodexDifferential({ sessionsDir: SESSIONS, now: far, keepDiffs: true })

  test('every rollout is compared and none has a bug row', () => {
    expect(report.sessions).toBe(5)
    expect(report.sessionsWithBugs).toBe(0)
    expect(report.resets).toBe(1)
  })

  test('the synthetic rollout explains exactly its designed differences', () => {
    const d = report.diffs!.find(x => x.sessionId.endsWith('05'))!
    const why = Object.fromEntries(d.rows.filter(r => r.verdict === 'explained' && !r.field.startsWith('daily.')).map(r => [r.field, r.reason]))
    expect(why).toEqual({
      input_tokens: CODEX_EXPLANATIONS.cumulativeReset,
      output_tokens: CODEX_EXPLANATIONS.cumulativeReset,
      cache_read_input_tokens: CODEX_EXPLANATIONS.cumulativeReset,
      model: CODEX_EXPLANATIONS.modelSwitch,
      costUSD: CODEX_EXPLANATIONS.costFollows,
      duration_minutes: CODEX_EXPLANATIONS.durationRounded,
      user_interruptions: CODEX_EXPLANATIONS.interruptionsHardcoded,
      uses_web_search: CODEX_EXPLANATIONS.webSearchName,
    })
  })

  test('the turn family and the gauge are EQUAL on every rollout', () => {
    for (const d of report.diffs!) {
      for (const f of ['active_minutes', 'user_message_count', 'user_message_timestamps', 'rounds', 'start_time', 'end_time',
        'context_tokens', 'context_window', 'tool_counts']) {
        expect({ s: d.sessionId, f, v: d.rows.find(r => r.field === f)?.verdict }).toEqual({ s: d.sessionId, f, v: 'equal' })
      }
    }
  })
})

describe('an explanation applies only when its proof holds', () => {
  const path = join(SESSIONS, '2026/01/01/rollout-2026-01-01T00-00-05-00000000-0000-4000-8000-000000000005.jsonl')
  const text = readFileSync(path, 'utf-8')
  const projection = projectCodex(replayCodexRollout(codexContext(rolloutIdOf(path), fallbackIdOf(path), '2026-09-27T00:00:00.000Z'), iterLines(text)))
  const evidence = recountCodex(iterLines(text))

  test('a legacy figure the recount does not reproduce stays a bug', () => {
    const legacy = { ...parseCodexRollout(text, fallbackIdOf(path))!, input_tokens: 299, duration_minutes: 7 }
    const rows = compareCodexSession({ sessionId: 'x', legacy, projection, evidence }).rows
    expect(rows.find(r => r.field === 'input_tokens')!.verdict).toBe('bug')
    expect(rows.find(r => r.field === 'duration_minutes')!.verdict).toBe('bug')
    // …and the cost, whose proof needs every token row proven first.
    expect(rows.find(r => r.field === 'costUSD')!.verdict).toBe('bug')
  })
})

describe('the recount', () => {
  test('the recount agrees with the fixture set it proves against', async () => {
    const files = await collectRollouts(SESSIONS)
    const resets = files.map(f => recountCodex(iterLines(readFileSync(f, 'utf-8'))).resets)
    expect(resets.reduce((a, b) => a + b, 0)).toBe(1)
  })
})
