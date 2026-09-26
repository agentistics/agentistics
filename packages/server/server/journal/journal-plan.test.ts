import { describe, expect, test } from 'bun:test'
import { CANONICAL_EVENT_SCHEMA, EVENT_TYPES, type AgentisticsEvent } from '@agentistics/core'
import {
  REJECTION_ORDER, isIsoInstant, planAppend, rejectionOf, rowToEvent, toRow,
} from './journal-plan'
import type { RejectionReason } from './types'

// ── Fixture ─────────────────────────────────────────────────────────────────────────────────────

function validEvent(over: Partial<AgentisticsEvent> = {}): AgentisticsEvent {
  return {
    eventId: 'evt-1',
    schema: CANONICAL_EVENT_SCHEMA,
    type: 'session.ended',
    occurredAt: '2026-09-25T10:00:00.000Z',
    recordedAt: '2026-09-25T10:00:01.000Z',
    source: { kind: 'harness', id: 'claude' },
    provenance: { mode: 'observed', confidence: 'exact', adapterVersion: '1.0.0' },
    data: {},
    ...over,
  }
}

/** A `source` with a `kind` outside the closed `SourceKind` union — runtime-malformed input. */
const badSource = (kind: string, id: string): AgentisticsEvent['source'] =>
  ({ kind, id }) as unknown as AgentisticsEvent['source']

/** Asserts `ev` is refused with exactly `reason`, and — the point of a rejection — never becomes a row. */
function expectRejection(ev: AgentisticsEvent, reason: RejectionReason): void {
  expect(rejectionOf(ev)).toBe(reason)
  const plan = planAppend([ev])
  expect(plan.rows).toEqual([])
  expect(plan.rejected).toHaveLength(1)
  expect(plan.rejected[0]!.reason).toBe(reason)
}

// ── REJECTION_ORDER is exhaustive ───────────────────────────────────────────────────────────────

describe('REJECTION_ORDER', () => {
  test('names every RejectionReason exactly once', () => {
    // Compile-time exhaustiveness: this fails to type-check if REJECTION_ORDER is missing a
    // reason (an index would be `undefined`, not assignable to `RejectionReason`) or names one
    // that does not exist (the literal would not match `RejectionReason`).
    const exhaustive: Record<RejectionReason, true> = {
      'missing-event-id': true,
      'bad-schema': true,
      'schema-too-new': true,
      'missing-adapter-version': true,
      'unknown-type': true,
      'bad-timestamp': true,
      'missing-source': true,
      'bad-provenance': true,
      'bad-data': true,
    }
    // Runtime check that REJECTION_ORDER agrees: same set, no duplicates, same length.
    expect(new Set(REJECTION_ORDER).size).toBe(REJECTION_ORDER.length)
    const asStrings: string[] = [...REJECTION_ORDER]
    expect(asStrings.sort()).toEqual(Object.keys(exhaustive).sort())
  })
})

// ── rejectionOf — one test per reason ───────────────────────────────────────────────────────────

describe('rejectionOf', () => {
  test('a valid event is accepted', () => {
    expect(rejectionOf(validEvent())).toBeNull()
  })

  test('missing-event-id: absent, wrong type, or blank', () => {
    expectRejection(validEvent({ eventId: '' }), 'missing-event-id')
    expectRejection(validEvent({ eventId: '   ' }), 'missing-event-id')
    expectRejection({ ...validEvent(), eventId: undefined } as unknown as AgentisticsEvent, 'missing-event-id')
    expectRejection({ ...validEvent(), eventId: 42 } as unknown as AgentisticsEvent, 'missing-event-id')
  })

  test('bad-schema: not a positive integer', () => {
    expectRejection(validEvent({ schema: 0 }), 'bad-schema')
    expectRejection(validEvent({ schema: -1 }), 'bad-schema')
    expectRejection(validEvent({ schema: 1.5 }), 'bad-schema')
    expectRejection({ ...validEvent(), schema: '1' } as unknown as AgentisticsEvent, 'bad-schema')
    expectRejection({ ...validEvent(), schema: undefined } as unknown as AgentisticsEvent, 'bad-schema')
  })

  test('schema-too-new: above CANONICAL_EVENT_SCHEMA', () => {
    expectRejection(validEvent({ schema: CANONICAL_EVENT_SCHEMA + 1 }), 'schema-too-new')
  })

  test('missing-adapter-version: absent provenance, or a blank adapterVersion', () => {
    expectRejection(
      validEvent({ provenance: { mode: 'observed', confidence: 'exact', adapterVersion: '' } }),
      'missing-adapter-version',
    )
    expectRejection(
      validEvent({ provenance: { mode: 'observed', confidence: 'exact', adapterVersion: '  ' } }),
      'missing-adapter-version',
    )
    expectRejection({ ...validEvent(), provenance: undefined } as unknown as AgentisticsEvent, 'missing-adapter-version')
  })

  test('unknown-type: not in the vocabulary', () => {
    expectRejection({ ...validEvent(), type: 'not.a.real.type' } as unknown as AgentisticsEvent, 'unknown-type')
    expectRejection({ ...validEvent(), type: undefined } as unknown as AgentisticsEvent, 'unknown-type')
  })

  test('bad-timestamp: either side fails isIsoInstant', () => {
    expectRejection(validEvent({ occurredAt: 'not-a-date' }), 'bad-timestamp')
    expectRejection(validEvent({ recordedAt: 'not-a-date' }), 'bad-timestamp')
    expectRejection(validEvent({ occurredAt: '2026-09-25T10:00:00' }), 'bad-timestamp') // no tz
  })

  test('missing-source: absent, or kind/id blank', () => {
    expectRejection(validEvent({ source: badSource('', 'claude') }), 'missing-source')
    expectRejection(validEvent({ source: { kind: 'harness', id: '' } }), 'missing-source')
    expectRejection({ ...validEvent(), source: undefined } as unknown as AgentisticsEvent, 'missing-source')
  })

  test('bad-provenance: mode or confidence outside the closed vocabulary', () => {
    expectRejection(
      validEvent({ provenance: { mode: 'guessed' as never, confidence: 'exact', adapterVersion: '1.0.0' } }),
      'bad-provenance',
    )
    expectRejection(
      validEvent({ provenance: { mode: 'observed', confidence: 'certain' as never, adapterVersion: '1.0.0' } }),
      'bad-provenance',
    )
  })

  test('bad-data: absent, cyclic, or a BigInt', () => {
    expectRejection({ ...validEvent(), data: undefined } as unknown as AgentisticsEvent, 'bad-data')

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expectRejection(validEvent({ data: cyclic as never }), 'bad-data')

    expectRejection(validEvent({ data: { n: BigInt(1) } as never }), 'bad-data')
  })

  test('an unrecognised source.kind is NOT missing-source — only blank/absent is', () => {
    // source.kind is checked for non-empty, never against the SourceKind union (see the header
    // comment in journal-plan.ts): a kind the vocabulary has not yet named is still a real fact.
    expect(rejectionOf(validEvent({ source: badSource('some-new-kind', 'x') }))).toBeNull()
  })

  describe('ordering — the FIRST failing check wins', () => {
    test('missing-event-id outranks bad-schema and unknown-type', () => {
      expectRejection(
        { ...validEvent(), eventId: '', schema: 0, type: 'nope' } as unknown as AgentisticsEvent,
        'missing-event-id',
      )
    })

    test('bad-schema outranks missing-source', () => {
      expectRejection(
        validEvent({ schema: 0, source: badSource('', '') }),
        'bad-schema',
      )
    })

    test('missing-adapter-version outranks unknown-type and bad-timestamp', () => {
      expectRejection(
        {
          ...validEvent(),
          provenance: { mode: 'observed', confidence: 'exact', adapterVersion: '' },
          type: 'nope',
          occurredAt: 'garbage',
        } as unknown as AgentisticsEvent,
        'missing-adapter-version',
      )
    })

    test('unknown-type outranks bad-timestamp and missing-source', () => {
      expectRejection(
        { ...validEvent(), type: 'nope', occurredAt: 'garbage', source: { kind: '', id: '' } } as unknown as AgentisticsEvent,
        'unknown-type',
      )
    })

    test('bad-timestamp outranks missing-source and bad-provenance', () => {
      expectRejection(
        validEvent({
          occurredAt: 'garbage',
          source: badSource('', ''),
          provenance: { mode: 'bogus' as never, confidence: 'exact', adapterVersion: '1.0.0' },
        }),
        'bad-timestamp',
      )
    })

    test('missing-source outranks bad-provenance and bad-data', () => {
      expectRejection(
        validEvent({
          source: badSource('', ''),
          provenance: { mode: 'bogus' as never, confidence: 'exact', adapterVersion: '1.0.0' },
          data: { n: BigInt(1) } as never,
        }),
        'missing-source',
      )
    })

    test('bad-provenance outranks bad-data', () => {
      expectRejection(
        validEvent({
          provenance: { mode: 'bogus' as never, confidence: 'exact', adapterVersion: '1.0.0' },
          data: { n: BigInt(1) } as never,
        }),
        'bad-provenance',
      )
    })
  })

  test('every EVENT_TYPES entry passes the type check', () => {
    for (const type of EVENT_TYPES) {
      const ev = { ...validEvent(), type } as AgentisticsEvent
      expect(rejectionOf(ev)).not.toBe('unknown-type')
    }
  })
})

// ── isIsoInstant ────────────────────────────────────────────────────────────────────────────────

describe('isIsoInstant', () => {
  test.each<[unknown, boolean]>([
    ['2026-09-25T10:00:00Z', true],
    ['2026-09-25T10:00:00+03:00', true],
    ['2026-09-25T10:00:00-03:00', true],
    ['2026-09-25T10:00:00.123Z', true],
    ['2026-09-25T10:00Z', true], // no seconds
    ['2026-09-25T10:00:00', false], // no tz
    ['2026-02-30T10:00:00Z', false], // no such day
    ['2024-02-29T10:00:00Z', true], // leap year
    ['2025-02-29T10:00:00Z', false], // not a leap year
    ['', false],
    [12345, false],
    [null, false],
    [undefined, false],
    ['T25:00', false],
    ['2026-09-25T25:00:00Z', false], // hour out of range
    ['not a date at all', false],
  ])('%p -> %p', (input, expected) => {
    expect(isIsoInstant(input)).toBe(expected)
  })
})

// ── toRow / rowToEvent ──────────────────────────────────────────────────────────────────────────

describe('toRow', () => {
  test('normalises an offset timestamp to UTC', () => {
    const row = toRow(validEvent({ occurredAt: '2026-09-25T10:00:00-03:00' }))
    expect(row.occurred_at).toBe('2026-09-25T13:00:00.000Z')
  })

  test('absent optional fields become null columns', () => {
    const row = toRow(validEvent())
    expect(row.session_id).toBeNull()
    expect(row.run_id).toBeNull()
    expect(row.agent_id).toBeNull()
    expect(row.task_id).toBeNull()
    expect(row.source_version).toBeNull()
    expect(row.source_ref).toBeNull()
  })

  test('data is JSON-stringified', () => {
    const row = toRow(validEvent({ data: { a: 1 } as never }))
    expect(row.data).toBe('{"a":1}')
  })
})

describe('round-trip', () => {
  test('a fully-populated event survives toRow -> rowToEvent exactly', () => {
    const full: AgentisticsEvent = {
      eventId: 'evt-full',
      schema: CANONICAL_EVENT_SCHEMA,
      type: 'session.ended',
      occurredAt: '2026-09-25T10:00:00.000Z',
      recordedAt: '2026-09-25T10:00:01.000Z',
      sessionId: 'sess-1',
      runId: 'run-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      source: { kind: 'harness', id: 'claude', version: '2.1.263' },
      provenance: { mode: 'observed', confidence: 'exact', adapterVersion: '1.0.0', sourceRef: 'file:42' },
      data: {},
    }
    expect(rowToEvent(toRow(full))).toEqual(full)
  })

  test('a minimal event omits every absent optional key on the way back', () => {
    const minimal = validEvent()
    const back = rowToEvent(toRow(minimal))
    expect(back).toEqual(minimal)
    expect('sessionId' in back).toBe(false)
    expect('runId' in back).toBe(false)
    expect('agentId' in back).toBe(false)
    expect('taskId' in back).toBe(false)
    expect('version' in back.source).toBe(false)
    expect('sourceRef' in back.provenance).toBe(false)
  })
})

// ── planAppend ──────────────────────────────────────────────────────────────────────────────────

describe('planAppend', () => {
  test('every event lands in exactly one bucket, at its own index', () => {
    const events: AgentisticsEvent[] = [
      validEvent({ eventId: 'ok-1' }),
      validEvent({ eventId: '' }), // missing-event-id
      validEvent({ eventId: 'ok-2' }),
      validEvent({ eventId: 'ok-3', schema: 0 }), // bad-schema
      { ...validEvent(), eventId: 'ok-4', type: 'nope' } as unknown as AgentisticsEvent, // unknown-type
    ]
    const plan = planAppend(events)

    expect(plan.rows.map(r => r.index)).toEqual([0, 2])
    expect(plan.rows.map(r => r.row.event_id)).toEqual(['ok-1', 'ok-2'])

    expect(plan.rejected).toEqual([
      { index: 1, reason: 'missing-event-id' },
      { index: 3, eventId: 'ok-3', reason: 'bad-schema' },
      { index: 4, eventId: 'ok-4', reason: 'unknown-type' },
    ])
  })

  test('duplicate eventIds within a batch are NOT this plan\'s business — both become rows', () => {
    const events = [validEvent({ eventId: 'same' }), validEvent({ eventId: 'same' })]
    const plan = planAppend(events)
    expect(plan.rows).toHaveLength(2)
    expect(plan.rejected).toEqual([])
    expect(plan.rows.map(r => r.row.event_id)).toEqual(['same', 'same'])
  })

  test('an empty batch plans to nothing', () => {
    expect(planAppend([])).toEqual({ rows: [], rejected: [] })
  })
})
