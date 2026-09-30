/**
 * emit.stream.test.ts — the streamed path's journaling (B2.1): `model.started` keyed on
 * `(invocationId, attempt)`, NO `model.delta` ever written, and `journalProviderStream` passing every
 * event through unchanged while writing invoked → started → terminal in that order.
 */
import { describe, expect, test } from 'bun:test'
import {
  classifyProviderError,
  deriveEventId,
  fromAnthropicStopReason,
  fromAnthropicUsage,
  type AgentisticsEvent,
} from '@agentistics/core'
import {
  createProviderEmitter,
  journalProviderStream,
  startedEvent,
  type AttemptStart,
  type EmitContext,
  type ProviderJournalSink,
} from './emit'
import type { InvocationResult, ProviderStreamEvent } from './client.ts'

function memorySink(): ProviderJournalSink & { events: AgentisticsEvent[] } {
  const events: AgentisticsEvent[] = []
  const seen = new Set<string>()
  return {
    events,
    async append(batch) {
      let written = 0
      let duplicates = 0
      for (const e of batch) {
        if (seen.has(e.eventId)) { duplicates += 1; continue }
        seen.add(e.eventId); events.push(e); written += 1
      }
      return { written, duplicates }
    },
  }
}

const ctx: EmitContext = { adapterVersion: 'anthropic@1', recordedAt: '2026-09-27T12:00:05.000Z' }
const start: AttemptStart = {
  invocationId: 'inv_s1', attempt: 1, provider: 'anthropic', requestedModel: 'claude-opus-4-6', startedAt: '2026-09-27T12:00:00.000Z',
}

const completedResult: InvocationResult = {
  ...start,
  latencyMs: 900,
  status: 'completed',
  messageId: 'msg_stream_1',
  servedModel: 'claude-opus-4-6-served',
  usage: fromAnthropicUsage({ input_tokens: 25, output_tokens: 15 }).usage,
  usageAnomalies: [],
  stopReason: fromAnthropicStopReason('end_turn'),
  content: [{ type: 'text', text: 'never journaled' }],
  toolCallFailures: [],
}

async function* source(events: ProviderStreamEvent[]): AsyncGenerator<ProviderStreamEvent> {
  for (const e of events) yield e
}

describe('startedEvent — keyed on the attempt, carrying the message id as data', () => {
  test('the key is (invocationId, attempt), never the msg_ id; the data joins the attempt', () => {
    const e = startedEvent({ ...start, messageId: 'msg_stream_1', servedModel: 'claude-served' }, { sessionId: 's1' }, ctx, '2026-09-27T12:00:01.000Z')
    expect(e.type).toBe('model.started')
    expect(e.eventId).toBe(deriveEventId({
      sourceKind: 'provider', sourceId: 'anthropic', sourceRef: 'anthropic:inv:inv_s1:1', type: 'model.started',
    }))
    expect(e.data).toEqual({
      provider: 'anthropic', model: 'claude-served', attemptId: 'inv_s1', attempt: 1,
      modelRequested: 'claude-opus-4-6', providerRequestId: 'msg_stream_1',
    })
    expect(e.sessionId).toBe('s1')
    expect(e.occurredAt).toBe('2026-09-27T12:00:01.000Z')
  })

  test('without a message_start model or id: model is what was asked for, no providerRequestId', () => {
    const e = startedEvent(start, {}, ctx, ctx.recordedAt)
    expect(e.data.model).toBe('claude-opus-4-6')
    expect('providerRequestId' in e.data).toBe(false)
  })

  test('the same attempt started twice converges to one row; a different attempt is another', async () => {
    const sink = memorySink()
    const em = createProviderEmitter({ journal: sink, adapterVersion: 'anthropic@1' })
    await em.started({ ...start, messageId: 'msg_a' })
    await em.started({ ...start, messageId: 'msg_a' })
    await em.started({ ...start, attempt: 2 })
    expect(sink.events.filter(e => e.type === 'model.started').length).toBe(2)
    expect(em.counters().lost['model.started']).toBe(0)
  })

  test('no journal: model.started is counted lost, never thrown', async () => {
    const em = createProviderEmitter({ journal: null, adapterVersion: 'anthropic@1' })
    expect(await em.started(start)).toBeNull()
    expect(em.counters().lost['model.started']).toBe(1)
  })
})

describe('journalProviderStream — invoked, started, terminal; deltas pass through and are never written', () => {
  const streamed: ProviderStreamEvent[] = [
    { type: 'started', requestId: 'req_1', messageId: 'msg_stream_1', servedModel: 'claude-opus-4-6-served' },
    ...Array.from({ length: 500 }, (_, i): ProviderStreamEvent => ({ type: 'text-delta', index: 0, text: `t${i}` })),
    { type: 'usage', outputTokensSoFar: 15 },
    { type: 'end', result: completedResult },
  ]

  test('a completed stream: three rows, in order, whatever the number of deltas', async () => {
    const sink = memorySink()
    const em = createProviderEmitter({ journal: sink, adapterVersion: 'anthropic@1' })
    const passed: ProviderStreamEvent[] = []
    for await (const ev of journalProviderStream(source(streamed), em, start, { runId: 'r1' })) passed.push(ev)

    expect(passed).toEqual(streamed)
    expect(sink.events.map(e => e.type)).toEqual(['model.invoked', 'model.started', 'model.completed'])
    expect(sink.events.some(e => e.type === 'model.delta')).toBe(false)
    expect(sink.events.every(e => e.runId === 'r1')).toBe(true)
    const done = sink.events[2] as AgentisticsEvent<'model.completed'>
    expect(done.data.providerRequestId).toBe('msg_stream_1')
    expect(done.data.usage).toEqual({ input: 25, output: 15 })
    // Content never reaches an event.
    expect(JSON.stringify(sink.events)).not.toContain('never journaled')
  })

  test('model.invoked is written before the source is pulled at all', async () => {
    const sink = memorySink()
    const em = createProviderEmitter({ journal: sink, adapterVersion: 'anthropic@1' })
    let pulledWith = -1
    async function* probe(): AsyncGenerator<ProviderStreamEvent> {
      pulledWith = sink.events.length
      yield { type: 'end', result: completedResult }
    }
    for await (const _ of journalProviderStream(probe(), em, start)) { /* drain */ }
    expect(pulledWith).toBe(1)
    expect(sink.events[0]!.type).toBe('model.invoked')
  })

  test('a failed stream: invoked (+ started if it began) + model.failed, no usage anywhere', async () => {
    const sink = memorySink()
    const em = createProviderEmitter({ journal: sink, adapterVersion: 'anthropic@1' })
    const failed: InvocationResult = {
      ...start, latencyMs: 50, status: 'failed',
      error: { ...classifyProviderError({ httpStatus: 529, errorType: 'overloaded_error' }), httpStatus: 200, usageOutcome: 'unknown' },
    }
    const events: ProviderStreamEvent[] = [
      { type: 'started', messageId: 'msg_x' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'end', result: failed },
    ]
    for await (const _ of journalProviderStream(source(events), em, start)) { /* drain */ }
    expect(sink.events.map(e => e.type)).toEqual(['model.invoked', 'model.started', 'model.failed'])
    const f = sink.events[2] as AgentisticsEvent<'model.failed'>
    expect(f.data.errorClass).toBe('overloaded')
    expect('usage' in f.data).toBe(false)
  })
})
