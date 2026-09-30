/**
 * projections/parity-matrix.test.ts — the pure generator, exercised against hand-built
 * `SessionDiff[]` (never a real store): status mapping, the "no reason = generator bug" invariant,
 * capability overrides, determinism, and regression detection.
 */
import { describe, expect, test } from 'bun:test'
import type { FieldRow, SessionDiff } from './differential'
import {
  buildHarnessRows,
  buildParityMatrix,
  FIELD_CAPABILITY,
  firstSample,
  sortParityRows,
  statusFromSummary,
  summarizeParityMatrix,
  type ParityMatrixRow,
} from './parity-matrix'
import { summarize } from './differential'

const row = (field: string, verdict: FieldRow['verdict'], extra: Partial<FieldRow> = {}): FieldRow =>
  ({ family: 'tokens', field, verdict, ...extra })

const diff = (sessionId: string, rows: FieldRow[]): SessionDiff => ({ sessionId, rows })

describe('statusFromSummary', () => {
  test('equal-only counts map to equal', () => {
    const [s] = summarize([diff('a', [row('input_tokens', 'equal')])]).fields
    expect(statusFromSummary(s!)).toEqual({ status: 'equal' })
  })

  test('any bug, however outnumbered, wins as regression', () => {
    const diffs = [
      diff('a', [row('input_tokens', 'equal')]),
      diff('b', [row('input_tokens', 'equal')]),
      diff('c', [row('input_tokens', 'bug')]),
    ]
    const [s] = summarize(diffs).fields
    expect(statusFromSummary(s!)).toEqual({ status: 'regression' })
  })

  test('explained/not-projectable/partial all fold to "explained" and carry the reason', () => {
    for (const verdict of ['explained', 'not-projectable', 'partial'] as const) {
      const [s] = summarize([diff('a', [row('x', verdict, { reason: 'because' })])]).fields
      expect(statusFromSummary(s!)).toEqual({ status: 'explained', reason: 'because' })
    }
  })

  test('a declared verdict with NO reason is a generator failure, not a silent explained row', () => {
    const [s] = summarize([diff('a', [row('x', 'explained')])]).fields
    expect(() => statusFromSummary(s!)).toThrow(/no sentence is a failure of the generator/)
  })

  test('a field with no verdicts at all throws rather than fabricating a status', () => {
    expect(() => statusFromSummary({ family: 'tokens', field: 'x', counts: { equal: 0, explained: 0, bug: 0, 'not-projectable': 0, partial: 0 }, bugSessions: [], reasons: [] }))
      .toThrow(/carries no verdicts/)
  })
})

describe('firstSample', () => {
  test('picks the field from the session with the lexicographically-first id, regardless of array order', () => {
    const diffs = [
      diff('zzz', [row('input_tokens', 'equal', { legacy: 2, projected: 2 })]),
      diff('aaa', [row('input_tokens', 'equal', { legacy: 1, projected: 1 })]),
    ]
    expect(firstSample(diffs, 'input_tokens')).toEqual({ legacy: 1, projected: 1 })
  })

  test('undefined when no diff carries the field', () => {
    expect(firstSample([diff('a', [row('output_tokens', 'equal')])], 'input_tokens')).toBeUndefined()
  })

  test('normalises a dayed field the same way summarize() does', () => {
    const diffs = [diff('a', [{ family: 'time', field: 'daily.2026-09-01.tokens', verdict: 'equal', legacy: 1, projected: 1 }])]
    expect(firstSample(diffs, 'daily.<day>.tokens')).toEqual({ legacy: 1, projected: 1 })
  })
})

describe('buildHarnessRows — capability override', () => {
  test('a field mapped to a capability the harness does NOT have is overridden to explained, never left equal-at-0', () => {
    // codex.agents is false (not_supported) — an agentMetrics field that happens to compare equal
    // (both sides 0) must not read as a real "we compared agents and they match" row.
    const diffs = [diff('s1', [row('agentMetrics.totalTokens', 'equal', { legacy: 0, projected: 0, family: 'tools' })])]
    const rows = buildHarnessRows('codex', diffs)
    const r = rows.find(x => x.metric === 'agentMetrics.totalTokens')!
    expect(r.status).toBe('explained')
    expect(r.reason).toMatch(/^not produced by codex: /)
    expect(r.capability).toBe('agents')
    expect(r.capabilityState).toBe('not_supported')
  })

  test('a capability the harness supports keeps the differential\'s own verdict untouched', () => {
    const diffs = [diff('s1', [row('input_tokens', 'equal', { legacy: 5, projected: 5 })])]
    const rows = buildHarnessRows('claude', diffs)
    const r = rows.find(x => x.metric === 'input_tokens')!
    expect(r.status).toBe('equal')
    expect(r.capability).toBe('tokens')
    expect(r.capabilityState).toBe('supported')
    expect(r.exactness).toBe('exact')
  })

  test('a partial capability keeps the differential verdict (already carries its own PARTIAL_FIELDS reason)', () => {
    // antigravity.gitLines is a P2 refinement to `partial` — the differential already marks
    // lines_added as `partial` with its own reason; the capability layer must not clobber it.
    const diffs = [diff('s1', [row('lines_added', 'partial', { family: 'tools', reason: 'edit-derived half only' })])]
    const rows = buildHarnessRows('antigravity', diffs)
    const r = rows.find(x => x.metric === 'lines_added')!
    expect(r.status).toBe('explained')
    expect(r.reason).toBe('edit-derived half only')
    expect(r.capabilityState).toBe('partial')
  })

  test('an unsupported capability with no covering field gets ONE synthesized row', () => {
    const rows = buildHarnessRows('codex', [])
    const r = rows.find(x => x.metric === 'agents')!
    expect(r.status).toBe('explained')
    expect(r.reason).toMatch(/^not produced by codex: /)
    expect(r.sessionsCompared).toBe(0)
    expect(r.legacyValue).toBeUndefined()
  })

  test('a supported capability with no covering field is NOT fabricated', () => {
    // claude.dynamicWorkflows is true, and no field in FIELD_CAPABILITY maps to it — there must be
    // no row claiming it was compared.
    const rows = buildHarnessRows('claude', [])
    expect(rows.find(x => x.metric === 'dynamicWorkflows')).toBeUndefined()
  })

  test('kimi.mcpServers is supported (true, unlike every other non-claude harness) — no synthesized row', () => {
    const rows = buildHarnessRows('kimi', [])
    expect(rows.find(x => x.metric === 'mcpServers')).toBeUndefined()
  })

  test('opencode.compaction/skills/contextWindow are "unknown" (no recorded reason) and still get a row', () => {
    const rows = buildHarnessRows('opencode', [])
    for (const metric of ['compaction', 'skills', 'contextWindow']) {
      const r = rows.find(x => x.metric === metric)!
      expect(r.status).toBe('explained')
      expect(r.capabilityState).toBe('unknown')
      expect(r.reason).toContain('no reason recorded')
    }
  })

  test('a real bug is a real regression, capability or not', () => {
    const diffs = [diff('s1', [row('input_tokens', 'bug', { legacy: 10, projected: 20 })])]
    const rows = buildHarnessRows('claude', diffs)
    const r = rows.find(x => x.metric === 'input_tokens')!
    expect(r.status).toBe('regression')
    expect(r.bugSessions).toEqual(['s1'])
    expect(r.delta).toBe(10)
  })
})

describe('sortParityRows / buildParityMatrix — determinism', () => {
  test('sorts by HARNESS_ORDER then metric, independent of input order', () => {
    const rows: ParityMatrixRow[] = [
      { metric: 'z', harness: 'kimi', legacyValue: 1, projectedValue: 1, delta: 0, capability: null, capabilityState: null, exactness: 'exact', status: 'equal', sessionsCompared: 1 },
      { metric: 'a', harness: 'claude', legacyValue: 1, projectedValue: 1, delta: 0, capability: null, capabilityState: null, exactness: 'exact', status: 'equal', sessionsCompared: 1 },
      { metric: 'a', harness: 'kimi', legacyValue: 1, projectedValue: 1, delta: 0, capability: null, capabilityState: null, exactness: 'exact', status: 'equal', sessionsCompared: 1 },
    ]
    const sorted = sortParityRows(rows)
    expect(sorted.map(r => `${r.harness}/${r.metric}`)).toEqual(['claude/a', 'kimi/a', 'kimi/z'])
  })

  test('buildParityMatrix is a pure function of its input: same input, byte-identical output twice', () => {
    const perHarness = { claude: [diff('s1', [row('input_tokens', 'equal', { legacy: 1, projected: 1 })])] }
    const m1 = buildParityMatrix(perHarness, '2026-01-01T00:00:00.000Z')
    const m2 = buildParityMatrix(perHarness, '2026-01-01T00:00:00.000Z')
    expect(m1).toEqual(m2)
  })

  test('rows are in sorted order straight out of buildParityMatrix', () => {
    const perHarness = {
      kimi: [diff('s1', [row('output_tokens', 'equal', { legacy: 1, projected: 1 })])],
      claude: [diff('s1', [row('input_tokens', 'equal', { legacy: 1, projected: 1 })])],
    }
    const m = buildParityMatrix(perHarness)
    const idx = (h: string) => m.rows.findIndex(r => r.harness === h)
    expect(idx('claude')).toBeLessThan(idx('kimi'))
  })

  test('a harness absent from the input still contributes its declared-unsupported capability rows', () => {
    const m = buildParityMatrix({})
    expect(m.rows.some(r => r.harness === 'codex' && r.metric === 'agents')).toBe(true)
    expect(m.rows.every(r => r.status !== 'regression')).toBe(true)
  })
})

describe('summarizeParityMatrix', () => {
  test('counts equal/explained/regression, overall and per harness', () => {
    const m = buildParityMatrix({
      claude: [diff('s1', [row('input_tokens', 'equal', { legacy: 1, projected: 1 })])],
      codex: [diff('s1', [row('input_tokens', 'bug', { legacy: 1, projected: 2 })])],
    })
    const summary = summarizeParityMatrix(m)
    expect(summary.regression).toBeGreaterThan(0)
    expect(summary.byHarness.codex.regression).toBeGreaterThan(0)
    expect(summary.byHarness.claude.regression).toBe(0)
    expect(summary.total).toBe(m.rows.length)
  })
})

test('FIELD_CAPABILITY only ever names a real HarnessCapabilities key', () => {
  const known = new Set(['tokens', 'cost', 'model', 'tools', 'agents', 'gitLines', 'dynamicWorkflows', 'activeTime', 'contextWindow', 'compaction', 'skills', 'mcpServers'])
  for (const v of Object.values(FIELD_CAPABILITY)) expect(known.has(v)).toBe(true)
})
