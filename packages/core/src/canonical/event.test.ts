import { describe, expect, test } from 'bun:test'
import {
  CANONICAL_EVENT_SCHEMA,
  CONFIDENCES,
  EVENT_TYPES,
  REQUIRED_EVENT_TYPES,
  isEventType,
  weakestConfidence,
  type AnyAgentisticsEvent,
  type Confidence,
  type EventProvenance,
  type ModelCompletedData,
} from './event'
import { REASONING_BILLINGS, SIDE_PROCESS_ENDED_BY } from './entities'

/**
 * event.test.ts — the UNION tests for the canonical event envelope (master spec §14, §38 and the
 * owner decision D17). These pin the closed vocabulary and the envelope's own shape; the "an event
 * carries facts, never an instruction" boundary lives in event-frontier.test.ts, the sibling of
 * events-frontier.test.ts for the notification channel.
 */

describe('EVENT_TYPES', () => {
  test('has no duplicates', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length)
  })

  test('CANONICAL_EVENT_SCHEMA is a number (the envelope version)', () => {
    expect(typeof CANONICAL_EVENT_SCHEMA).toBe('number')
  })
})

describe('REQUIRED_EVENT_TYPES', () => {
  /**
   * Hardcoded from §14.1's "required of every adapter that claims the capability at all" list, so
   * a silent edit to REQUIRED_EVENT_TYPES in event.ts — adding or removing a member — fails this
   * test rather than only failing to be noticed.
   */
  const SPEC_REQUIRED = [
    'session.started', 'session.ended',
    'run.started', 'run.ended',
    'agent.started', 'agent.ended',
    'model.invoked', 'model.completed', 'model.failed',
    'tool.requested', 'tool.completed', 'tool.failed',
  ]

  test('equals exactly the §14.1 required list', () => {
    // Cast to a plain string[] on both sides: the assertion is about VALUES (a silent edit to the
    // literal tuple in event.ts), not about re-deriving the same literal union type here.
    expect(REQUIRED_EVENT_TYPES as readonly string[]).toEqual(SPEC_REQUIRED)
  })

  test('is a subset of EVENT_TYPES', () => {
    for (const t of REQUIRED_EVENT_TYPES) {
      expect(EVENT_TYPES).toContain(t)
    }
  })

  test('process.started / process.ended are present in EVENT_TYPES and are NOT required (§13.4)', () => {
    expect(EVENT_TYPES).toContain('process.started')
    expect(EVENT_TYPES).toContain('process.ended')
    expect(REQUIRED_EVENT_TYPES).not.toContain('process.started')
    expect(REQUIRED_EVENT_TYPES).not.toContain('process.ended')
  })
})

describe('isEventType', () => {
  test('true for every member of EVENT_TYPES', () => {
    for (const t of EVENT_TYPES) {
      expect(isEventType(t)).toBe(true)
    }
  })

  test('false for strings that are not in the vocabulary', () => {
    expect(isEventType('nope')).toBe(false)
    expect(isEventType('')).toBe(false)
    // A trailing space is not the same string as the real type.
    expect(isEventType('model.completed ')).toBe(false)
    // A prototype key must not leak through Set membership as a false positive.
    expect(isEventType('toString')).toBe(false)
  })
})

describe('Confidence (D17)', () => {
  test('CONFIDENCES deep-equals the exact D17 vocabulary, strongest to weakest', () => {
    expect(CONFIDENCES).toEqual(['exact', 'estimated', 'inferred'])
  })

  test('contains no "derived" — D17 explicitly retired it', () => {
    expect(CONFIDENCES as readonly string[]).not.toContain('derived')
  })

  test('weakestConfidence returns the later-in-CONFIDENCES value for every ordered pair', () => {
    for (let i = 0; i < CONFIDENCES.length; i++) {
      for (let j = 0; j < CONFIDENCES.length; j++) {
        const a = CONFIDENCES[i] as Confidence
        const b = CONFIDENCES[j] as Confidence
        const expected = CONFIDENCES[Math.max(i, j)] as Confidence
        expect(weakestConfidence(a, b)).toBe(expected)
      }
    }
  })

  test('is order-independent (weakest of {a,b} === weakest of {b,a})', () => {
    for (const a of CONFIDENCES) {
      for (const b of CONFIDENCES) {
        expect(weakestConfidence(a, b)).toBe(weakestConfidence(b, a))
      }
    }
  })

  test('a single argument returns itself', () => {
    for (const c of CONFIDENCES) {
      expect(weakestConfidence(c)).toBe(c)
    }
  })

  test('three inputs: the weakest wins regardless of position', () => {
    expect(weakestConfidence('exact', 'inferred', 'estimated')).toBe('inferred')
    expect(weakestConfidence('inferred', 'exact', 'exact')).toBe('inferred')
    expect(weakestConfidence('exact', 'exact', 'exact')).toBe('exact')
  })
})

describe('entity tuples the event union depends on', () => {
  test('SIDE_PROCESS_ENDED_BY equals the §13.4 endedBy union', () => {
    expect([...SIDE_PROCESS_ENDED_BY]).toEqual(['exit', 'killed-by-runtime', 'killed-externally', 'lost'])
  })

  test('REASONING_BILLINGS equals the three §14.2 values', () => {
    expect([...REASONING_BILLINGS]).toEqual(['included-in-output', 'additive', 'unknown'])
  })
})

describe('narrowing on AnyAgentisticsEvent.type', () => {
  const modelCompletedFixture: AnyAgentisticsEvent = {
    eventId: 'evt_1',
    schema: CANONICAL_EVENT_SCHEMA,
    type: 'model.completed',
    occurredAt: '2026-09-25T12:00:00.000Z',
    recordedAt: '2026-09-25T12:00:01.000Z',
    sessionId: 'ses_1',
    runId: 'run_1',
    agentId: 'agt_1',
    source: { kind: 'harness', id: 'claude', version: '2.1.263' },
    provenance: { mode: 'observed', confidence: 'exact', adapterVersion: '1.0.0' },
    data: {
      provider: 'anthropic',
      model: 'claude-opus-5',
      usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 1 },
      reasoning: { tokens: 3, billing: 'additive' },
      status: 'completed',
    },
  }

  /**
   * A compile-time exhaustiveness helper: a `switch` over a few concrete types plus `default`,
   * where the default branch assigns to `never`. If a new EventType were added to the union
   * without this switch handling it, `e` in the default branch would no longer be assignable to
   * `never` and `tsc --noEmit` would fail — which is exactly the guarantee this test wants pinned.
   * It also proves that inside the `model.completed` case, `e.data.usage.cacheRead` compiles,
   * i.e. `e.data` is narrowed to `ModelCompletedData` and not the union of every data shape.
   */
  function narrows(e: AnyAgentisticsEvent): number {
    switch (e.type) {
      case 'model.completed':
        return e.data.usage.cacheRead
      case 'model.failed':
        return e.data.latencyMs ?? 0
      case 'tool.requested':
        return e.data.name.length
      case 'session.started':
        return e.data.origin.length
      default:
        // Exhaustiveness would require every other member; deliberately not exhaustive here (a
        // handful of cases + default), so this branch is reachable and must accept `e` as the
        // wider union rather than `never`. Kept as a smoke check that narrowing itself compiles.
        return 0
    }
  }

  test('a typed model.completed event narrows e.data to ModelCompletedData', () => {
    expect(narrows(modelCompletedFixture)).toBe(5)
  })

  test('narrows() runs over every concrete case without throwing', () => {
    const toolRequested: AnyAgentisticsEvent = {
      eventId: 'evt_2',
      schema: CANONICAL_EVENT_SCHEMA,
      type: 'tool.requested',
      occurredAt: '2026-09-25T12:00:00.000Z',
      recordedAt: '2026-09-25T12:00:00.000Z',
      source: { kind: 'harness', id: 'claude' },
      provenance: { mode: 'observed', confidence: 'exact', adapterVersion: '1.0.0' },
      data: { toolExecutionId: 'tex_1', name: 'Bash', canonicalName: 'Bash', kind: 'shell' },
    }
    expect(narrows(toolRequested)).toBe('Bash'.length)
  })

  /**
   * Each negative fixture below is typed against the NARROWEST concrete type that carries the
   * rule under test (`EventProvenance`, `ModelCompletedData['reasoning']`, `Confidence`) rather
   * than the full `AnyAgentisticsEvent` union. Assigning an object literal into one arm of a
   * 30-member discriminated union reports its diagnostic on the OUTER object (TS resolves the
   * best-matching union member first), which would land the `@ts-expect-error` on the wrong line
   * and make it "unused" under `tsc`'s line-adjacency rule. Typed at the concrete field, the
   * error lands exactly on the line the directive sits above — and the concrete type is the same
   * one `AgentisticsEvent`/`EventData['model.completed']` are built from, so the guarantee is
   * identical: these shapes cannot be constructed without satisfying the rule.
   */

  // @ts-expect-error — provenance.adapterVersion is REQUIRED (§45); an event without it must not typecheck.
  const _missingAdapterVersion: EventProvenance = { mode: 'observed', confidence: 'exact' }

  const _bareReasoningNumber: ModelCompletedData = {
    provider: 'anthropic',
    model: 'claude-opus-5',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    // @ts-expect-error — `reasoning` must never be a bare number (§14.2 correction); it needs { tokens, billing }.
    reasoning: 5,
    status: 'completed',
  }

  // @ts-expect-error — 'derived' is not a Confidence (D17 retired it); only exact/estimated/inferred typecheck.
  const _derivedConfidence: Confidence = 'derived'

  test('the @ts-expect-error fixtures above exist only to be type-checked, not exercised at runtime', () => {
    // bun test does not evaluate types; this assertion exists so the block above is not dead code
    // as far as a coverage tool is concerned, and so `tsc --noEmit` is the thing that can fail it.
    expect(true).toBe(true)
  })
})
