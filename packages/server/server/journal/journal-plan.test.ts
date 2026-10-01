import { describe, expect, test } from 'bun:test'
import { CANONICAL_EVENT_SCHEMA, EVENT_TYPES, type AgentisticsEvent } from '@agentistics/core'
import {
  REJECTION_ORDER, decodeData, decodeRow, encodeData, encodeEventId, encodeInstant, encodeRow,
  isIsoInstant, joinSourceRef, planAppend, rejectionOf, rowToEvent, splitSourceRef, toRow,
  type Intern, type Lookup,
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

  // The canonical-UTC fast path skips `new Date(x).toISOString()` for a string already in that
  // shape. It is only sound if the two always agree — so every shape is checked against Date itself.
  test.each([
    '2026-09-25T10:00:00.000Z',
    '2024-02-29T23:59:59.999Z',
    '0001-01-01T00:00:00.000Z',
    '2026-09-25T10:00:00Z',
    '2026-09-25T10:00Z',
    '2026-09-25T10:00:00.1Z',
    '2026-09-25T10:00:00.123456Z',
    '2026-09-25T10:00:00.000+00:00',
    '2026-09-25T23:30:00.000-03:00',
  ])('the stored timestamp is exactly new Date(%p).toISOString()', (at) => {
    const row = toRow(validEvent({ occurredAt: at, recordedAt: at }))
    expect(row.occurred_at).toBe(new Date(at).toISOString())
    expect(row.recorded_at).toBe(new Date(at).toISOString())
  })
})

describe('planAppend serializes data once', () => {
  test('the row carries exactly JSON.stringify(data), the same text toRow alone produces', () => {
    const data = { usage: { input: 3, output: 50 }, tags: ['a', 'b'], note: 'é "quoted"' }
    const e = validEvent({ data: data as never })
    const plan = planAppend([e])
    expect(plan.rejected).toEqual([])
    expect(plan.rows[0]!.row.data).toBe(JSON.stringify(data))
    expect(plan.rows[0]!.row).toEqual(toRow(e))
  })

  test('JSON.stringify runs once per accepted event, not twice', () => {
    const e = validEvent({ data: { a: 1 } as never })
    let calls = 0
    const orig = JSON.stringify
    JSON.stringify = ((...args: Parameters<typeof orig>) => { calls++; return orig(...args) }) as typeof orig
    try {
      planAppend([e, e, e])
    } finally {
      JSON.stringify = orig
    }
    expect(calls).toBe(3)
  })

  test('a data value JSON cannot hold is still bad-data, through the single serialization', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(planAppend([validEvent({ data: cyclic as never })]).rejected).toEqual([{ index: 0, reason: 'bad-data', eventId: validEvent().eventId }])
    expect(planAppend([validEvent({ data: (() => 1) as never })]).rejected[0]!.reason).toBe('bad-data')
    expect(planAppend([validEvent({ data: 10n as never })]).rejected[0]!.reason).toBe('bad-data')
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

// ── storage encoding (schema v2) ────────────────────────────────────────────────────────────────

/** An in-memory `event_strings`: the same contract journal.ts keeps against the table. */
function dictionary(): { intern: Intern; lookup: Lookup; size: () => number } {
  const ids = new Map<string, number>()
  const strs: string[] = []
  return {
    intern: s => { let id = ids.get(s); if (id === undefined) { id = strs.push(s); ids.set(s, id) } return id },
    lookup: id => { const s = strs[id - 1]; if (s === undefined) throw new Error(`unknown ${id}`); return s },
    size: () => strs.length,
  }
}

/** `e` through every layer the journal stores it with, and back. */
function throughStorage(e: AgentisticsEvent, d = dictionary()): AgentisticsEvent {
  return rowToEvent(decodeRow(encodeRow(toRow(e), d.intern), d.lookup))
}

describe('storage encoding — lossless by construction', () => {
  test('a 32-char lowercase hex id is 16 raw bytes; any other id stays the text it is', () => {
    const hex = '0123456789abcdef0123456789abcdef'
    expect(encodeEventId(hex)).toBeInstanceOf(Uint8Array)
    expect((encodeEventId(hex) as Uint8Array).length).toBe(16)
    for (const id of ['evt-1', hex.toUpperCase(), `${hex}0`, hex.slice(1)]) expect(encodeEventId(id)).toBe(id)
  })

  test('an instant is epoch ms, and anything but the normalised form refuses instead of drifting', () => {
    expect(encodeInstant('2026-09-25T10:00:00.123Z')).toBe(Date.UTC(2026, 8, 25, 10, 0, 0, 123))
    expect(() => encodeInstant('2026-09-25T10:00:00Z')).toThrow()
    expect(() => encodeInstant('2026-09-25T07:00:00.000-03:00')).toThrow()
  })

  test('source_ref splits only at a trailing canonical decimal, and always joins back', () => {
    for (const ref of [
      'claude:0a1b:12', 'claude:0a1b/subagents/a9:3', 'x:0', 'x:01', 'x:', ':7', 'plain', '',
      'a::5', 'x:1234567890123456', 'multi\nline:4', 'claude:c:9007199254740991',
    ]) {
      const { base, line } = splitSourceRef(ref)
      expect(joinSourceRef(base, line)).toBe(ref)
    }
    expect(splitSourceRef('claude:abc:12')).toEqual({ base: 'claude:abc', line: 12 })
    expect(splitSourceRef('x:01')).toEqual({ base: 'x:01', line: null })
    expect(splitSourceRef('x:1234567890123456')).toEqual({ base: 'x:1234567890123456', line: null })
  })

  test('data comes back as the SAME JSON text, byte for byte', () => {
    const d = dictionary()
    const values: unknown[] = [
      {}, [], 'text', 7, null, true, [1, { a: 2 }],
      { a: 1 }, { a: {} }, { a: [] }, { a: null, b: false, c: 'x' },
      { provider: 'anthropic', usage: { input: 3, output: 9, cacheRead: 0, cacheWrite: 1 }, cacheWriteByTtl: { ephemeral_5m: 0, ephemeral_1h: 1 } },
      { deep: { er: { est: { v: 1 } }, sib: 2 }, tail: 'z' },
      { '2': 'b', '1': 'a', x: 'c' }, // index-like keys: the engine's own order, both ways
      JSON.parse('{"__proto__":{"polluted":1},"k":1}'),
      { 'quo"te': 'ü ✓ \u0000', n: -0, big: 1e21, small: 5e-7, neg: -12.5 },
      { filesTouched: ['/a b/c.ts'], linesAdded: 3 },
    ]
    for (const v of values) {
      const json = JSON.stringify(v)
      const enc = encodeData(json, d.intern)
      expect(decodeData(enc.shape === null ? null : d.lookup(enc.shape), enc.values)).toBe(json)
    }
    // Nothing leaked onto Object.prototype while rebuilding `__proto__`.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('one payload shape is one dictionary entry however many rows carry it', () => {
    const d = dictionary()
    const a = encodeData(JSON.stringify({ model: 'm1', usage: { input: 1 } }), d.intern)
    const b = encodeData(JSON.stringify({ model: 'm2', usage: { input: 99 } }), d.intern)
    expect(a.shape).toBe(b.shape)
    expect(a.values).toBe('["m1",1]')
    expect(d.size()).toBe(1)
  })

  test('a values array that does not fit its shape is refused, never silently misread', () => {
    const d = dictionary()
    const { shape } = encodeData('{"a":1,"b":2}', d.intern)
    expect(() => decodeData(d.lookup(shape!), '[1]')).toThrow()
    expect(() => decodeData(d.lookup(shape!), '[1,2,3]')).toThrow()
  })

  test('every optional field present and absent survives the storage layer exactly', () => {
    const full: AgentisticsEvent = {
      eventId: '0123456789abcdef0123456789abcdef',
      schema: CANONICAL_EVENT_SCHEMA,
      type: 'session.ended',
      occurredAt: '2026-09-25T10:00:00.000Z',
      recordedAt: '2026-09-25T10:00:01.000Z',
      sessionId: 'sess-1', runId: 'run-1', agentId: 'agent-1', taskId: 'task-1',
      source: { kind: 'harness', id: 'claude', version: '2.1.263' },
      provenance: { mode: 'observed', confidence: 'exact', adapterVersion: '1.0.0', sourceRef: 'claude:c:42' },
      data: {},
    }
    expect(throughStorage(full)).toEqual(full)
    const minimal = validEvent()
    const back = throughStorage(minimal)
    expect(back).toEqual(minimal)
    for (const k of ['sessionId', 'runId', 'agentId', 'taskId']) expect(k in back).toBe(false)
    expect('version' in back.source).toBe(false)
    expect('sourceRef' in back.provenance).toBe(false)
  })
})

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
