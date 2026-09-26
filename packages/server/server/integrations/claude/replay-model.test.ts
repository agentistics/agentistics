import { describe, expect, it } from 'bun:test'
import type { AgentisticsEvent } from '@agentistics/core'
import { CLAUDE_SOURCE_ID, mainContext, type ClaudeReplayContext, type EmitEvent } from './replay-core'
import { deriveEventId } from '@agentistics/core'
import {
  cloneModelFold, emptyModelFold, finishModelFold, foldModelEntry, type ModelFoldState,
} from './replay-model'

// ---- fixtures: small synthetic entries, no real conversation content -------------------------

interface UsageOpts {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  ttl?: { fiveMin: number; oneHour: number }
}

function assistantEntry(opts: {
  id?: string
  model?: string
  usage?: UsageOpts
  ts?: string
  version?: string
  isApiErrorMessage?: boolean
  error?: string
}): Record<string, unknown> {
  const message: Record<string, unknown> = {}
  if (opts.id !== undefined) message.id = opts.id
  if (opts.model !== undefined) message.model = opts.model
  if (opts.usage) {
    const usage: Record<string, unknown> = {
      input_tokens: opts.usage.input ?? 0,
      output_tokens: opts.usage.output ?? 0,
      cache_read_input_tokens: opts.usage.cacheRead ?? 0,
      cache_creation_input_tokens: opts.usage.cacheWrite ?? 0,
    }
    if (opts.usage.ttl) {
      usage.cache_creation = {
        ephemeral_5m_input_tokens: opts.usage.ttl.fiveMin,
        ephemeral_1h_input_tokens: opts.usage.ttl.oneHour,
      }
    }
    message.usage = usage
  }
  const entry: Record<string, unknown> = { type: 'assistant', message }
  if (opts.ts !== undefined) entry.timestamp = opts.ts
  if (opts.version !== undefined) entry.version = opts.version
  if (opts.isApiErrorMessage !== undefined) entry.isApiErrorMessage = opts.isApiErrorMessage
  if (opts.error !== undefined) entry.error = opts.error
  return entry
}

function otherEntry(type: string, ts?: string): Record<string, unknown> {
  const entry: Record<string, unknown> = { type }
  if (ts !== undefined) entry.timestamp = ts
  return entry
}

const ctx: ClaudeReplayContext = mainContext('conv-1', '2026-01-01T00:00:00.000Z')

function collector(): { events: AgentisticsEvent[]; emit: EmitEvent } {
  const events: AgentisticsEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

function runAll(entries: Record<string, unknown>[], startLine = 1): AgentisticsEvent[] {
  const state = emptyModelFold()
  const { events, emit } = collector()
  entries.forEach((e, i) => foldModelEntry(state, ctx, e, startLine + i, emit))
  finishModelFold(state, ctx, true, emit)
  return events
}

/** Every event this module can emit, for the invariants that must hold across the board. */
function assertWellFormed(events: AgentisticsEvent[]): void {
  for (const e of events) {
    expect(e.provenance.adapterVersion.length).toBeGreaterThan(0)
    expect(['exact', 'estimated', 'inferred']).toContain(e.provenance.confidence)
    expect(e.provenance.sourceRef && e.provenance.sourceRef.length).toBeGreaterThan(0)
  }
}

// -------------------------------------------------------------------------------------------

describe('foldModelEntry — one billed response, held until proven closed', () => {
  it('emits nothing while a multi-line response is still open', () => {
    const state = emptyModelFold()
    const { events, emit } = collector()
    foldModelEntry(state, ctx, assistantEntry({ id: 'm1', model: 'claude-opus-5', usage: { input: 10, output: 5 } }), 1, emit)
    foldModelEntry(state, ctx, assistantEntry({ id: 'm1', model: 'claude-opus-5', usage: { input: 10, output: 20 } }), 2, emit)
    expect(events).toHaveLength(0)
  })

  it('emits exactly one invoked+completed pair, with the LAST usage, once a later entry proves it closed', () => {
    const state = emptyModelFold()
    const { events, emit } = collector()
    foldModelEntry(state, ctx, assistantEntry({
      id: 'm1', model: 'claude-opus-5', ts: '2026-01-01T00:00:01.000Z', usage: { input: 10, output: 5 },
    }), 1, emit)
    foldModelEntry(state, ctx, assistantEntry({
      id: 'm1', model: 'claude-opus-5', ts: '2026-01-01T00:00:02.000Z', usage: { input: 10, output: 20 },
    }), 2, emit)
    // A user line proves NOTHING (a response's own tool results arrive between its lines)…
    foldModelEntry(state, ctx, otherEntry('user', '2026-01-01T00:00:03.000Z'), 3, emit)
    expect(events).toHaveLength(0)
    // …the NEXT response starting is what closes it.
    foldModelEntry(state, ctx, assistantEntry({
      id: 'm2', model: 'claude-opus-5', ts: '2026-01-01T00:00:04.000Z', usage: { input: 1, output: 1 },
    }), 4, emit)

    expect(events).toHaveLength(2)
    const [invoked, completed] = events
    expect(invoked!.type).toBe('model.invoked')
    expect(completed!.type).toBe('model.completed')
    expect(invoked!.provenance.sourceRef).toBe(completed!.provenance.sourceRef)
    // sourceRef names the FIRST line of the response, not the closing line.
    expect(invoked!.provenance.sourceRef).toBe('claude:conv-1:1')
    // occurredAt is the response's OWN first timestamp, never the closing entry's.
    expect(invoked!.occurredAt).toBe('2026-01-01T00:00:01.000Z')
    expect(completed!.occurredAt).toBe('2026-01-01T00:00:01.000Z')
    const data = completed!.data as { usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }
    expect(data.usage).toEqual({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0 })
    assertWellFormed(events)
  })

  it('a response whose lines are INTERLEAVED with other records is still emitted once (measured: 211 in 15 of 60 transcripts)', () => {
    const state = emptyModelFold()
    const { events, emit } = collector()
    const m1 = (ts: string, output: number) => assistantEntry({ id: 'm1', model: 'claude-opus-5', ts, usage: { input: 10, output } })
    foldModelEntry(state, ctx, m1('2026-01-01T00:00:01.000Z', 7), 1, emit)
    foldModelEntry(state, ctx, otherEntry('user', '2026-01-01T00:00:02.000Z'), 2, emit)
    foldModelEntry(state, ctx, m1('2026-01-01T00:00:03.000Z', 7), 3, emit)
    foldModelEntry(state, ctx, otherEntry('attachment', '2026-01-01T00:00:04.000Z'), 4, emit)
    foldModelEntry(state, ctx, m1('2026-01-01T00:00:05.000Z', 7), 5, emit)
    finishModelFold(state, ctx, true, emit)
    expect(events.map(e => e.type)).toEqual(['model.invoked', 'model.completed'])
    expect(new Set(events.map(e => e.eventId)).size).toBe(2)
  })

  it('an id already emitted is never emitted again, even if a line of it arrives after another response', () => {
    const state = emptyModelFold()
    const { events, emit } = collector()
    const line = (id: string, ts: string) => assistantEntry({ id, model: 'claude-opus-5', ts, usage: { input: 1, output: 1 } })
    foldModelEntry(state, ctx, line('m1', '2026-01-01T00:00:01.000Z'), 1, emit)
    foldModelEntry(state, ctx, line('m2', '2026-01-01T00:00:02.000Z'), 2, emit)
    foldModelEntry(state, ctx, line('m1', '2026-01-01T00:00:03.000Z'), 3, emit)
    finishModelFold(state, ctx, true, emit)
    const completed = events.filter(e => e.type === 'model.completed')
    expect(completed.map(e => (e.data as { providerRequestId?: string }).providerRequestId)).toEqual(['m1', 'm2'])
  })

  it('a different message.id closes the held response before opening the new one', () => {
    const state = emptyModelFold()
    const { events, emit } = collector()
    foldModelEntry(state, ctx, assistantEntry({ id: 'A', model: 'claude-a', usage: { input: 1, output: 1 } }), 1, emit)
    foldModelEntry(state, ctx, assistantEntry({ id: 'B', model: 'claude-b', usage: { input: 2, output: 2 } }), 2, emit)
    // Nothing closes B yet.
    expect(events).toHaveLength(2) // A's invoked+completed, emitted when B proved it closed
    expect(events.every((e) => (e.data as { model?: string }).model === 'claude-a')).toBe(true)

    finishModelFold(state, ctx, true, emit)
    expect(events).toHaveLength(4)
    expect(events.slice(2).every((e) => (e.data as { model?: string }).model === 'claude-b')).toBe(true)
  })

  it('an assistant line with no id closes a held response too (it cannot be shown to be a continuation)', () => {
    const state = emptyModelFold()
    const { events, emit } = collector()
    foldModelEntry(state, ctx, assistantEntry({ id: 'A', model: 'claude-a', usage: { input: 1, output: 1 } }), 1, emit)
    foldModelEntry(state, ctx, assistantEntry({ model: 'claude-b', usage: { input: 9, output: 9 } }), 2, emit) // no id
    // A closed, and the id-less line B emitted immediately (rule 4) — 4 events total.
    expect(events).toHaveLength(4)
    expect(events.map((e) => e.type)).toEqual(['model.invoked', 'model.completed', 'model.invoked', 'model.completed'])
  })
})

describe('finishModelFold', () => {
  it('final: false leaves the response held', () => {
    const state = emptyModelFold()
    const { events, emit } = collector()
    foldModelEntry(state, ctx, assistantEntry({ id: 'm1', model: 'claude-a', usage: { input: 1, output: 1 } }), 1, emit)
    finishModelFold(state, ctx, false, emit)
    expect(events).toHaveLength(0)
    expect(state.held).not.toBeUndefined()
  })

  it('final: true flushes it, and a second final: true is a no-op (idempotent)', () => {
    const state = emptyModelFold()
    const { events, emit } = collector()
    foldModelEntry(state, ctx, assistantEntry({ id: 'm1', model: 'claude-a', usage: { input: 1, output: 1 } }), 1, emit)
    finishModelFold(state, ctx, true, emit)
    expect(events).toHaveLength(2)
    finishModelFold(state, ctx, true, emit)
    expect(events).toHaveLength(2) // nothing new
    expect(state.held).toBeUndefined()
  })
})

describe('rule 4 — a record with no message.id is counted always, emitted immediately', () => {
  it('emits per line, never held, never paired with anything', () => {
    const events = runAll([
      assistantEntry({ model: 'claude-a', usage: { input: 1, output: 1 } }),
      assistantEntry({ model: 'claude-a', usage: { input: 2, output: 2 } }),
    ])
    expect(events).toHaveLength(4)
    const completed = events.filter((e) => e.type === 'model.completed')
    expect(completed.map((e) => (e.data as { usage: { input: number } }).usage.input)).toEqual([1, 2])
    // Neither carries a providerRequestId — nothing correlates them.
    for (const e of events) expect((e.data as { providerRequestId?: string }).providerRequestId).toBeUndefined()
  })
})

describe('cacheWriteByTtl', () => {
  it('is present, with the TTL keys, only when usage.cache_creation exists', () => {
    const events = runAll([
      assistantEntry({
        id: 'm1', model: 'claude-a', usage: { input: 1, output: 1, ttl: { fiveMin: 30, oneHour: 70 } },
      }),
    ])
    const completed = events.find((e) => e.type === 'model.completed')!
    expect((completed.data as { cacheWriteByTtl?: Record<string, number> }).cacheWriteByTtl).toEqual({
      ephemeral_5m: 30, ephemeral_1h: 70,
    })
  })

  it('is absent when usage carries no cache_creation object at all', () => {
    const events = runAll([assistantEntry({ id: 'm1', model: 'claude-a', usage: { input: 1, output: 1 } })])
    const completed = events.find((e) => e.type === 'model.completed')!
    expect((completed.data as { cacheWriteByTtl?: unknown }).cacheWriteByTtl).toBeUndefined()
  })
})

describe('API error lines (isApiErrorMessage: true) — measured shape, see the module header', () => {
  it('emits model.failed, naming the last REAL model seen, with the error code as errorClass', () => {
    const events = runAll([
      assistantEntry({ id: 'm1', model: 'claude-opus-5', usage: { input: 5, output: 5 } }),
      otherEntry('user'), // close m1 first, so lastRealModel is settled before the failure
      assistantEntry({ id: 'e1', model: '<synthetic>', isApiErrorMessage: true, error: 'rate_limit' }),
    ])
    const failed = events.find((e) => e.type === 'model.failed')
    expect(failed).toBeDefined()
    expect(failed!.data).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5', status: 'failed', errorClass: 'rate_limit' })
    // Attributed by history, not stated by the line itself — inferred, not exact.
    expect(failed!.provenance.confidence).toBe('inferred')
  })

  it('is skipped entirely when no real model has been seen yet', () => {
    const events = runAll([
      assistantEntry({ id: 'e1', model: '<synthetic>', isApiErrorMessage: true, error: 'rate_limit' }),
    ])
    expect(events.find((e) => e.type === 'model.failed')).toBeUndefined()
  })

  it('a synthetic line with no isApiErrorMessage/error is neither billed nor failed', () => {
    const events = runAll([
      assistantEntry({ id: 'm1', model: 'claude-opus-5', usage: { input: 1, output: 1 } }),
      otherEntry('user'),
      assistantEntry({ id: 'e2', model: '<synthetic>', usage: { input: 0, output: 0 } }), // e.g. "No response requested."
    ])
    expect(events.filter((e) => e.type !== 'model.invoked' && e.type !== 'model.completed')).toHaveLength(0)
    // Only m1's pair — the synthetic non-error line produced nothing.
    expect(events).toHaveLength(2)
  })

  it('does not double-close: a held response is closed once, the error line producing its own single model.failed', () => {
    const events = runAll([
      assistantEntry({ id: 'm1', model: 'claude-opus-5', usage: { input: 1, output: 1 } }),
      assistantEntry({ id: 'e1', model: '<synthetic>', isApiErrorMessage: true, error: 'server_error' }),
    ])
    const invoked = events.filter((e) => e.type === 'model.invoked')
    const completed = events.filter((e) => e.type === 'model.completed')
    const failed = events.filter((e) => e.type === 'model.failed')
    expect(invoked).toHaveLength(1)
    expect(completed).toHaveLength(1)
    expect(failed).toHaveLength(1)
  })
})

describe('chunk independence', () => {
  const entries: Record<string, unknown>[] = [
    assistantEntry({ id: 'A', model: 'claude-a', ts: '2026-01-01T00:00:01.000Z', usage: { input: 1, output: 1 } }),
    assistantEntry({ id: 'A', model: 'claude-a', ts: '2026-01-01T00:00:02.000Z', usage: { input: 1, output: 9 } }),
    otherEntry('user', '2026-01-01T00:00:03.000Z'),
    assistantEntry({ model: 'claude-a', usage: { input: 3, output: 3 } }), // id-less, rule 4
    assistantEntry({ id: 'e1', model: '<synthetic>', isApiErrorMessage: true, error: 'invalid_request' }),
    assistantEntry({
      id: 'B', model: 'claude-b', ts: '2026-01-01T00:00:05.000Z',
      usage: { input: 4, output: 4, ttl: { fiveMin: 1, oneHour: 2 } },
    }),
    otherEntry('user', '2026-01-01T00:00:06.000Z'),
  ]

  function ids(events: AgentisticsEvent[]): { eventId: string; type: string; data: unknown }[] {
    return events.map((e) => ({ eventId: e.eventId, type: e.type, data: e.data }))
  }

  const whole = runAll(entries)

  for (let split = 0; split <= entries.length; split++) {
    it(`splitting the entry list at index ${split} yields the same events after final finish`, () => {
      const state = emptyModelFold()
      const { events, emit } = collector()
      entries.slice(0, split).forEach((e, i) => foldModelEntry(state, ctx, e, i + 1, emit))
      // Exercise cloneModelFold mid-walk: continue on a CLONE, and verify the original is untouched.
      const clone = cloneModelFold(state)
      entries.slice(split).forEach((e, i) => foldModelEntry(clone, ctx, e, split + i + 1, emit))
      finishModelFold(clone, ctx, true, emit)
      expect(ids(events)).toEqual(ids(whole))
    })
  }

  it('folding the clone never mutated the original state object', () => {
    const state = emptyModelFold()
    const { emit } = collector()
    foldModelEntry(state, ctx, entries[0]!, 1, emit)
    const before = JSON.stringify(state)
    const clone = cloneModelFold(state)
    foldModelEntry(clone, ctx, entries[1]!, 2, emit)
    expect(JSON.stringify(state)).toBe(before)
  })
})

describe('event ids are keyed on providerRequestId, ignoring sourceRef (O-8)', () => {
  it('the SAME id from two different lines/contexts derives the SAME eventId', () => {
    const events = runAll([
      assistantEntry({ id: 'shared-id', model: 'claude-a', usage: { input: 1, output: 1 } }),
    ], 1)
    const completed = events.find((e) => e.type === 'model.completed')!
    const expected = deriveEventId({
      sourceKind: 'harness', sourceId: CLAUDE_SOURCE_ID, sourceRef: 'this-sourceRef-is-irrelevant:999',
      type: 'model.completed', providerRequestId: 'shared-id',
    })
    expect(completed.eventId).toBe(expected)

    // A second run at a totally different line number derives the identical id.
    const events2 = runAll([
      assistantEntry({ id: 'shared-id', model: 'claude-a', usage: { input: 1, output: 1 } }),
    ], 500)
    const completed2 = events2.find((e) => e.type === 'model.completed')!
    expect(completed2.eventId).toBe(completed.eventId)
  })
})
