import { describe, expect, test } from 'bun:test'
import { HARNESS_CAPABILITIES, HARNESS_ORDER, type HarnessId } from '../types'
import { CONFIDENCES } from './event'
import {
  CAPABILITY_METRICS,
  CAPABILITY_STATES,
  LEGACY_FALSE_NOTES,
  NO_RECORDED_REASON,
  SUPPORTED_EXACTNESS,
  capabilityReason,
  capabilitySupported,
  fromLegacyCapabilities,
  type CapabilityMetric,
  type CapabilityState,
  type LegacyFalseNotes,
} from './capabilities'

/**
 * capabilities.test.ts — pins the boolean → CapabilityState migration for the canonical layer.
 *
 * `HARNESS_CAPABILITIES` (packages/core/src/types.ts) is a plain `Record<HarnessId,
 * Record<CapabilityMetric, boolean>>` that the whole product (server, web, tui) still reads. This
 * module replaces the boolean with a richer `CapabilityState` (supported/partial/not_supported/
 * not_applicable/unknown) WITHOUT changing what any existing `capable(harness, metric)`-style
 * boolean check sees — that equivalence (`capabilitySupported(state) === legacyBoolean`) is the
 * whole point of `fromLegacyCapabilities`, and it is what test group 1 below is a TABLE over,
 * rather than a spot check, because a single wrong cell silently changes an N/A into a "0" or the
 * reverse somewhere in the app.
 *
 * `capabilities.ts` is being written by another agent in parallel and may not exist yet when this
 * file first runs — that failure (module not found) is EXPECTED and is reported verbatim rather
 * than treated as a reason to stub the module out here.
 */

describe('CAPABILITY_METRICS', () => {
  test('equals the exact key set of HARNESS_CAPABILITIES.claude (a full HarnessCapabilities record)', () => {
    const metricKeys = Object.keys(HARNESS_CAPABILITIES.claude).sort()
    expect<string[]>([...CAPABILITY_METRICS].sort()).toEqual(metricKeys)
  })

  test('has no duplicates', () => {
    expect(new Set(CAPABILITY_METRICS).size).toBe(CAPABILITY_METRICS.length)
  })
})

describe('CAPABILITY_STATES — coverage', () => {
  test('has exactly the same harness keys as HARNESS_CAPABILITIES (no extra, none missing)', () => {
    expect(Object.keys(CAPABILITY_STATES).sort()).toEqual(Object.keys(HARNESS_CAPABILITIES).sort())
  })

  for (const harness of HARNESS_ORDER) {
    test(`${harness} has exactly the CAPABILITY_METRICS key set (no extra, none missing)`, () => {
      expect(Object.keys(CAPABILITY_STATES[harness]).sort()).toEqual([...CAPABILITY_METRICS].sort())
    })
  }
})

// ── 1. EQUALITY table: for every harness x metric, capabilitySupported(new) === legacy boolean ──
describe('CAPABILITY_STATES vs HARNESS_CAPABILITIES — migration changes no behaviour', () => {
  for (const harness of HARNESS_ORDER) {
    for (const metric of Object.keys(HARNESS_CAPABILITIES[harness]) as CapabilityMetric[]) {
      test(`${harness}.${metric}`, () => {
        const legacy = HARNESS_CAPABILITIES[harness][metric]
        const state = CAPABILITY_STATES[harness][metric]
        expect(capabilitySupported(state)).toBe(legacy)
      })
    }
  }
})

// ── 3. No cell is 'partial' — a boolean cannot express it ──────────────────────────────────────
describe('CAPABILITY_STATES — no cell is partial (booleans cannot express a partial capability)', () => {
  for (const harness of HARNESS_ORDER) {
    for (const metric of CAPABILITY_METRICS) {
      test(`${harness}.${metric} is not partial`, () => {
        expect(CAPABILITY_STATES[harness][metric].state).not.toBe('partial')
      })
    }
  }
})

// ── 4. Reason/source honesty per state ──────────────────────────────────────────────────────────
describe('CAPABILITY_STATES — reason/source honesty', () => {
  for (const harness of HARNESS_ORDER) {
    for (const metric of CAPABILITY_METRICS) {
      test(`${harness}.${metric} carries the fields its state requires`, () => {
        const state = CAPABILITY_STATES[harness][metric]

        if (state.state === 'supported') return // no reason to check

        if (state.state === 'partial') {
          // Covered separately by "no cell is partial"; still exercised here for completeness.
          expect(state.limit.length).toBeGreaterThan(0)
          return
        }

        // not_supported | not_applicable | unknown all carry a non-empty `reason`.
        expect(state.reason.length).toBeGreaterThan(0)

        if (state.state === 'not_supported' || state.state === 'not_applicable') {
          expect(state.source.length).toBeGreaterThan(0)
        } else if (state.state === 'unknown' && state.source === null) {
          expect(state.reason).toBe(NO_RECORDED_REASON)
        }
      })
    }
  }
})

// ── 5. LEGACY_FALSE_NOTES targets only real false cells, with sane note reasons ─────────────────
describe('LEGACY_FALSE_NOTES', () => {
  const harnesses = Object.keys(LEGACY_FALSE_NOTES) as HarnessId[]

  test('LEGACY_FALSE_NOTES only ever names known harnesses', () => {
    for (const harness of harnesses) {
      expect(HARNESS_ORDER).toContain(harness)
    }
  })

  for (const harness of harnesses) {
    const harnessNotes = LEGACY_FALSE_NOTES[harness]
    if (!harnessNotes) continue
    for (const metric of Object.keys(harnessNotes) as CapabilityMetric[]) {
      const note = harnessNotes[metric]!

      test(`${harness}.${metric} note targets a cell that is false in HARNESS_CAPABILITIES`, () => {
        expect(HARNESS_CAPABILITIES[harness][metric]).toBe(false)
      })

      test(`${harness}.${metric} note reason is a single line and <= 240 chars`, () => {
        expect(note.reason.length).toBeGreaterThan(0)
        expect(note.reason).not.toContain('\n')
        expect(note.reason.length).toBeLessThanOrEqual(240)
      })

      test(`${harness}.${metric} note state is not_supported or not_applicable`, () => {
        expect(['not_supported', 'not_applicable']).toContain(note.state)
      })
    }
  }
})

// ── 6. Supported exactness ───────────────────────────────────────────────────────────────────────
describe('supported exactness', () => {
  for (const harness of HARNESS_ORDER) {
    for (const metric of CAPABILITY_METRICS) {
      test(`${harness}.${metric} exactness matches SUPPORTED_EXACTNESS[metric] ?? 'exact' when supported`, () => {
        const state = CAPABILITY_STATES[harness][metric]
        if (state.state !== 'supported') return
        const expected = SUPPORTED_EXACTNESS[metric] ?? 'exact'
        expect(state.exactness).toBe(expected)
      })
    }
  }

  test('every supported cost cell is estimated', () => {
    let sawSupportedCost = false
    for (const harness of HARNESS_ORDER) {
      const state = CAPABILITY_STATES[harness].cost
      if (state.state === 'supported') {
        sawSupportedCost = true
        expect(state.exactness).toBe('estimated')
      }
    }
    // Guard against the loop silently checking nothing (every harness prices cost through
    // calcCost(), so at least one supported cost cell must exist).
    expect(sawSupportedCost).toBe(true)
  })

  test('SUPPORTED_EXACTNESS[cost] is estimated', () => {
    expect(SUPPORTED_EXACTNESS.cost).toBe('estimated')
  })

  test('every SUPPORTED_EXACTNESS value is a real Confidence', () => {
    for (const value of Object.values(SUPPORTED_EXACTNESS)) {
      expect(CONFIDENCES as readonly string[]).toContain(value)
    }
  })

  test('every exactness on a supported cell is a real Confidence', () => {
    for (const harness of HARNESS_ORDER) {
      for (const metric of CAPABILITY_METRICS) {
        const state = CAPABILITY_STATES[harness][metric]
        if (state.state === 'supported') {
          expect(CONFIDENCES as readonly string[]).toContain(state.exactness)
        }
      }
    }
  })
})

// ── 7. fromLegacyCapabilities unit cases on a synthetic table ───────────────────────────────────
describe('fromLegacyCapabilities — unit cases on a synthetic legacy table', () => {
  test('false + note -> the note is copied onto the cell', () => {
    const legacy = { ...HARNESS_CAPABILITIES, claude: { ...HARNESS_CAPABILITIES.claude, tokens: false } }
    const notes: LegacyFalseNotes = {
      claude: { tokens: { state: 'not_supported', reason: 'synthetic reason for this test', source: 'synthetic-source.ts' } },
    }

    const result = fromLegacyCapabilities(legacy, notes)

    expect(result.claude.tokens).toEqual({
      state: 'not_supported',
      reason: 'synthetic reason for this test',
      source: 'synthetic-source.ts',
    })
  })

  test('false without a note -> unknown / NO_RECORDED_REASON / null source', () => {
    const legacy = { ...HARNESS_CAPABILITIES, claude: { ...HARNESS_CAPABILITIES.claude, tokens: false } }

    const result = fromLegacyCapabilities(legacy)

    expect(result.claude.tokens).toEqual({
      state: 'unknown',
      reason: NO_RECORDED_REASON,
      source: null,
    })
  })

  test('false without a note, notes object present but empty for that harness -> same unknown result', () => {
    const legacy = { ...HARNESS_CAPABILITIES, claude: { ...HARNESS_CAPABILITIES.claude, tokens: false } }
    const notes: LegacyFalseNotes = { codex: { agents: { state: 'not_supported', reason: 'unrelated', source: 'x.ts' } } }

    const result = fromLegacyCapabilities(legacy, notes)

    expect(result.claude.tokens).toEqual({
      state: 'unknown',
      reason: NO_RECORDED_REASON,
      source: null,
    })
  })

  test('true + note -> supported, the note is ignored', () => {
    // HARNESS_CAPABILITIES.claude.tokens is true in the real table.
    const legacy = { ...HARNESS_CAPABILITIES }
    const notes: LegacyFalseNotes = {
      claude: { tokens: { state: 'not_supported', reason: 'should never surface', source: 'nowhere.ts' } },
    }

    const result = fromLegacyCapabilities(legacy, notes)

    expect(result.claude.tokens.state).toBe('supported')
    if (result.claude.tokens.state === 'supported') {
      expect(result.claude.tokens.exactness).toBe(SUPPORTED_EXACTNESS.tokens ?? 'exact')
    }
  })

  test('does not mutate its inputs', () => {
    const legacy = structuredClone(HARNESS_CAPABILITIES)
    const legacyBefore = structuredClone(legacy)
    const notes: LegacyFalseNotes = structuredClone(LEGACY_FALSE_NOTES)
    const notesBefore = structuredClone(notes)

    fromLegacyCapabilities(legacy, notes)

    expect(legacy).toEqual(legacyBefore)
    expect(notes).toEqual(notesBefore)
  })

  test('does not mutate its inputs when called with no notes argument at all', () => {
    const legacy = structuredClone(HARNESS_CAPABILITIES)
    const legacyBefore = structuredClone(legacy)

    fromLegacyCapabilities(legacy)

    expect(legacy).toEqual(legacyBefore)
  })
})

// ── 8. capabilityReason ─────────────────────────────────────────────────────────────────────────
describe('capabilityReason', () => {
  test('null for a supported state', () => {
    const state: CapabilityState = { state: 'supported', exactness: 'exact' }
    expect(capabilityReason(state)).toBeNull()
  })

  test('the limit for a hand-built partial state', () => {
    const state: CapabilityState = { state: 'partial', exactness: 'estimated', limit: 'only the main agent\'s window is read' }
    expect(capabilityReason(state)).toBe('only the main agent\'s window is read')
  })

  test('the reason for a not_supported state', () => {
    const state: CapabilityState = { state: 'not_supported', reason: 'no compaction marker exists', source: 'jsonl.ts' }
    expect(capabilityReason(state)).toBe('no compaction marker exists')
  })

  test('the reason for a not_applicable state', () => {
    const state: CapabilityState = { state: 'not_applicable', reason: 'the concept does not exist for this harness', source: 'jsonl.ts' }
    expect(capabilityReason(state)).toBe('the concept does not exist for this harness')
  })

  test('the reason for an unknown state', () => {
    const state: CapabilityState = { state: 'unknown', reason: NO_RECORDED_REASON, source: null }
    expect(capabilityReason(state)).toBe(NO_RECORDED_REASON)
  })
})

// ── capabilitySupported — the boolean projection the rest of the app still reads ────────────────
describe('capabilitySupported', () => {
  test('true for supported', () => {
    expect(capabilitySupported({ state: 'supported', exactness: 'exact' })).toBe(true)
  })

  test('true for partial', () => {
    expect(capabilitySupported({ state: 'partial', exactness: 'estimated', limit: 'x' })).toBe(true)
  })

  test('false for not_supported', () => {
    expect(capabilitySupported({ state: 'not_supported', reason: 'r', source: 's' })).toBe(false)
  })

  test('false for not_applicable', () => {
    expect(capabilitySupported({ state: 'not_applicable', reason: 'r', source: 's' })).toBe(false)
  })

  test('false for unknown', () => {
    expect(capabilitySupported({ state: 'unknown', reason: 'r', source: null })).toBe(false)
  })
})

// ── 9. Regression sentinel — measured, never hardcoded ──────────────────────────────────────────
describe('regression sentinel', () => {
  test('the count of non-supported CAPABILITY_STATES cells equals the count of false HARNESS_CAPABILITIES cells', () => {
    let falseCount = 0
    for (const harness of HARNESS_ORDER) {
      for (const metric of CAPABILITY_METRICS) {
        if (HARNESS_CAPABILITIES[harness][metric] === false) falseCount++
      }
    }

    let nonSupportedCount = 0
    for (const harness of HARNESS_ORDER) {
      for (const metric of CAPABILITY_METRICS) {
        if (!capabilitySupported(CAPABILITY_STATES[harness][metric])) nonSupportedCount++
      }
    }

    // Sanity: there really are false cells in the real table (claude has none, every other
    // harness has several), so this sentinel cannot pass by both sides being vacuously zero.
    expect(falseCount).toBeGreaterThan(0)
    expect(nonSupportedCount).toBe(falseCount)
  })
})

// The classification of today's 30 falses, pinned. Each call is recorded with its evidence in the
// A1.4 handback (task t-e1dea7cd6f). A cell listed as `unknown` here has NO note on purpose: the only
// sentences available for it were composed, contradicted by the table, or claim nothing about why.
describe('LEGACY_FALSE_NOTES — the classification of every legacy false', () => {
  const EXPECTED: Record<string, CapabilityState['state']> = {
    'codex.agents': 'not_supported', 'codex.gitLines': 'not_supported', 'codex.dynamicWorkflows': 'unknown',
    'codex.compaction': 'not_supported', 'codex.skills': 'not_applicable', 'codex.mcpServers': 'not_supported',
    'gemini.agents': 'not_supported', 'gemini.gitLines': 'not_supported', 'gemini.dynamicWorkflows': 'unknown',
    'gemini.contextWindow': 'unknown', 'gemini.compaction': 'not_supported', 'gemini.skills': 'not_applicable',
    'gemini.mcpServers': 'not_supported',
    'copilot.agents': 'not_supported', 'copilot.dynamicWorkflows': 'unknown', 'copilot.contextWindow': 'not_supported',
    'copilot.compaction': 'not_supported', 'copilot.skills': 'not_applicable', 'copilot.mcpServers': 'not_supported',
    'antigravity.agents': 'not_supported', 'antigravity.gitLines': 'not_supported', 'antigravity.dynamicWorkflows': 'unknown',
    'antigravity.compaction': 'not_supported', 'antigravity.skills': 'unknown', 'antigravity.mcpServers': 'not_supported',
    'kimi.agents': 'not_supported', 'kimi.gitLines': 'not_supported', 'kimi.dynamicWorkflows': 'unknown',
    'kimi.compaction': 'not_supported', 'kimi.skills': 'not_applicable',
  }

  test('every false cell is classified exactly as recorded, and nothing else is', () => {
    const actual: Record<string, CapabilityState['state']> = {}
    for (const h of HARNESS_ORDER) {
      for (const m of CAPABILITY_METRICS) {
        const s = CAPABILITY_STATES[h][m]
        if (!capabilitySupported(s)) actual[`${h}.${m}`] = s.state
      }
    }
    expect(actual).toEqual(EXPECTED)
  })

  test('an unknown cell carries the one honest sentence and no source', () => {
    for (const [cell, state] of Object.entries(EXPECTED)) {
      if (state !== 'unknown') continue
      const [h, m] = cell.split('.') as [HarnessId, CapabilityMetric]
      expect(CAPABILITY_STATES[h][m]).toEqual({ state: 'unknown', reason: NO_RECORDED_REASON, source: null })
    }
  })
})
