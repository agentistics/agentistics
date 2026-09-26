import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyProviderError,
  deriveEventId,
  fromAnthropicStopReason,
  fromAnthropicUsage,
  type AgentisticsEvent,
} from '@agentistics/core'
import { openJournal } from '../journal/journal'
import type { PathProbe } from '../journal/schema'
import type { Journal } from '../journal/types'
import {
  completedEvent,
  createProviderEmitter,
  failedEvent,
  invokedEvent,
  type AttemptCompleted,
  type AttemptFailed,
  type AttemptStart,
  type EmitContext,
} from './emit'

// A FAKE key, shaped like a real one so the leak assertions below have something to find. No test
// in this file makes a network call and none ever sees a real key.
const TEST_KEY = 'sk-ant-api03-TESTONLY-0000000000000000000000000000'

let root = ''
let seq = 0
const freshPath = () => join(root, `j-${++seq}`, 'journal.db')
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-emit-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const localProbe: PathProbe = {
  platform: 'linux',
  realpath: p => p,
  readMountinfo: () => '58 42 8:32 / / rw,relatime - ext4 /dev/sdc rw',
  readDarwinMounts: () => null,
}
const open = (): Promise<Journal> => openJournal({ path: freshPath(), probe: localProbe })

const ctx: EmitContext = { adapterVersion: 'anthropic@1', sourceVersion: '4.0.58', recordedAt: '2026-09-25T12:00:05.000Z' }

const start: AttemptStart = {
  invocationId: 'inv_abc', attempt: 1, provider: 'anthropic',
  requestedModel: 'claude-opus-5', startedAt: '2026-09-25T12:00:00.000Z',
}

/** A raw Anthropic usage body with every optional part present. */
const RAW_USAGE = {
  input_tokens: 12,
  output_tokens: 340,
  cache_read_input_tokens: 45_000,
  cache_creation_input_tokens: 1_500,
  cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 500 },
  iterations: [{ type: 'compaction', model: 'claude-haiku-4-5', input_tokens: 99 }],
}

function completed(over: Partial<AttemptCompleted> = {}): AttemptCompleted {
  return {
    ...start,
    status: 'completed',
    latencyMs: 812,
    requestId: 'req_111',
    messageId: 'msg_01XYZ',
    servedModel: 'claude-opus-5-20260901',
    usage: fromAnthropicUsage(RAW_USAGE).usage,
    stopReason: fromAnthropicStopReason('end_turn'),
    stopReasonVerbatim: 'end_turn',
    ...over,
  }
}

function failed(over: Partial<AttemptFailed> = {}): AttemptFailed {
  return {
    ...start,
    status: 'failed',
    latencyMs: 40,
    requestId: 'req_222',
    error: classifyProviderError({ httpStatus: 529, errorType: 'overloaded_error', requestIdHeader: 'req_222' }),
    ...over,
  }
}

describe('event ids — deriveEventId, keyed on the provider id wherever one exists', () => {
  test('model.completed is keyed on the msg_ id, through the provider path', () => {
    const e = completedEvent(completed(), {}, ctx, '2026-09-25T12:00:01.000Z')
    expect(e.eventId).toBe(deriveEventId({
      sourceKind: 'provider', sourceId: 'anthropic', sourceRef: 'anthropic:msg:msg_01XYZ',
      type: 'model.completed', providerRequestId: 'msg_01XYZ',
    }))
    // Provider path: the id is the response's, whatever else differs about how it was reached.
    expect(e.eventId).toBe(deriveEventId({
      sourceKind: 'gateway', sourceId: 'elsewhere', sourceRef: 'x', type: 'model.completed', providerRequestId: 'msg_01XYZ',
    }))
    expect(e.data.providerRequestId).toBe('msg_01XYZ')
    expect(e.provenance.sourceRef).toBe('anthropic:msg:msg_01XYZ')
  })

  test('the request-id header never moves an id (it can be absent)', () => {
    const a = completedEvent(completed({ requestId: 'req_1' }), {}, ctx, 't')
    const b = completedEvent(completed({ requestId: undefined }), {}, ctx, 't')
    expect(a.eventId).toBe(b.eventId)
    const f1 = failedEvent(failed({ requestId: 'req_1' }), {}, ctx, 't')
    const f2 = failedEvent(failed({ requestId: undefined }), {}, ctx, 't')
    expect(f1.eventId).toBe(f2.eventId)
    expect(JSON.stringify([a, b, f1, f2])).not.toContain('req_1')
  })

  test('model.failed and model.invoked are keyed on (invocationId, attempt)', () => {
    const f = failedEvent(failed(), {}, ctx, 't')
    expect(f.eventId).toBe(deriveEventId({
      sourceKind: 'provider', sourceId: 'anthropic', sourceRef: 'anthropic:inv:inv_abc:1', type: 'model.failed',
    }))
    expect(f.data.providerRequestId).toBeUndefined()
    const i = invokedEvent(start, {}, ctx)
    expect(i.eventId).toBe(deriveEventId({
      sourceKind: 'provider', sourceId: 'anthropic', sourceRef: 'anthropic:inv:inv_abc:1', type: 'model.invoked',
    }))
    // Each attempt is its own fact; each invocation too.
    expect(failedEvent(failed({ attempt: 2 }), {}, ctx, 't').eventId).not.toBe(f.eventId)
    expect(failedEvent(failed({ invocationId: 'inv_other' }), {}, ctx, 't').eventId).not.toBe(f.eventId)
    expect(invokedEvent({ ...start, attempt: 2 }, {}, ctx).eventId).not.toBe(i.eventId)
  })

  test('a completion with an EMPTY message id is keyed on its attempt, never on the empty string', () => {
    const a = completedEvent(completed({ messageId: '' }), {}, ctx, 't')
    const b = completedEvent(completed({ messageId: '', invocationId: 'inv_other' }), {}, ctx, 't')
    expect(a.eventId).not.toBe(b.eventId)
    expect(a.provenance.sourceRef).toBe('anthropic:inv:inv_abc:1')
    expect(a.data.providerRequestId).toBeUndefined()
  })

  test('the same attempt emitted twice derives the same ids (recordedAt does not enter the key)', () => {
    const later = { ...ctx, recordedAt: '2026-09-26T00:00:00.000Z' }
    expect(invokedEvent(start, {}, later).eventId).toBe(invokedEvent(start, {}, ctx).eventId)
    expect(completedEvent(completed(), {}, later, 'x').eventId).toBe(completedEvent(completed(), {}, ctx, 'y').eventId)
  })
})

describe('model.completed — the exact usage, and the D20 fields', () => {
  const e = completedEvent(completed(), {}, ctx, '2026-09-25T12:00:01.000Z')

  test('all four counters, verbatim, and the TTL split', () => {
    expect(e.data.usage).toEqual({ input: 12, output: 340, cacheRead: 45_000, cacheWrite: 1_500 })
    expect(e.data.cacheWriteByTtl).toEqual({ ephemeral_5m: 1_000, ephemeral_1h: 500 })
    expect(e.data.contextTokens).toBe(12 + 45_000 + 1_500)
  })

  test('served vs requested model: `model` is the served one', () => {
    expect(e.data.model).toBe('claude-opus-5-20260901')
    expect(e.data.modelServed).toBe('claude-opus-5-20260901')
    expect(e.data.modelRequested).toBe('claude-opus-5')
    expect(e.data.attemptId).toBe('inv_abc')
    expect(e.data.attempt).toBe(1)
  })

  test('stop reason: normalised AND verbatim', () => {
    expect(e.data.stopReason).toEqual({ normalised: { kind: 'end-turn' }, verbatim: 'end_turn' })
    const other = completedEvent(completed({ stopReason: fromAnthropicStopReason('new_reason'), stopReasonVerbatim: undefined }), {}, ctx, 't')
    expect(other.data.stopReason).toEqual({ normalised: { kind: 'other', raw: 'new_reason' }, verbatim: 'new_reason' })
    const noVerbatim = completedEvent(completed({ stopReasonVerbatim: undefined }), {}, ctx, 't')
    expect(noVerbatim.data.stopReason).toEqual({ normalised: { kind: 'end-turn' } })
  })

  test('iterations are carried (kind + model), never folded into the counters', () => {
    expect(e.data.iterations).toEqual({ relation: 'unmeasured', items: [{ kind: 'compaction', model: 'claude-haiku-4-5' }] })
    expect(e.data.usage.input).toBe(12)
    const none = completedEvent(completed({ usage: fromAnthropicUsage({ ...RAW_USAGE, iterations: [] }).usage }), {}, ctx, 't')
    expect('iterations' in none.data).toBe(false)
  })

  test('no cost on the event, no reasoning invented', () => {
    expect('costUSD' in e.data).toBe(false)
    expect('costSource' in e.data).toBe(false)
    expect('reasoning' in e.data).toBe(false)
  })

  test('envelope: provider source, native, exact, adapterVersion; occurredAt is the observation', () => {
    expect(e.source).toEqual({ kind: 'provider', id: 'anthropic', version: '4.0.58' })
    expect(e.provenance).toEqual({ mode: 'native', confidence: 'exact', adapterVersion: 'anthropic@1', sourceRef: 'anthropic:msg:msg_01XYZ' })
    expect(e.occurredAt).toBe('2026-09-25T12:00:01.000Z')
    expect(e.recordedAt).toBe(ctx.recordedAt)
  })

  test('a counter the provider did not state makes the event inferred, not exact', () => {
    const partial = fromAnthropicUsage({ input_tokens: 5, output_tokens: 6 }).usage
    const p = completedEvent(completed({ usage: partial }), {}, ctx, 't')
    expect(p.provenance.confidence).toBe('inferred')
    expect(p.data.contextTokens).toBeUndefined()
  })
})

describe('model.failed — no usage, never zeros', () => {
  test('carries no usage object at all', () => {
    const f = failedEvent(failed(), {}, ctx, 't')
    expect('usage' in f.data).toBe(false)
    expect(JSON.stringify(f)).not.toMatch(/usage|input|output|cacheRead|cacheWrite/i)
    expect(f.data).toEqual({
      provider: 'anthropic', model: 'claude-opus-5', deployment: 'direct', status: 'failed',
      errorClass: 'overloaded', latencyMs: 40, attemptId: 'inv_abc', attempt: 1, modelRequested: 'claude-opus-5',
    })
  })

  test('an abort is cancelled, not failed', () => {
    const f = failedEvent(failed({ error: classifyProviderError({ transport: 'aborted' }) }), {}, ctx, 't')
    expect(f.data.status).toBe('cancelled')
    expect(f.data.errorClass).toBe('aborted')
  })
})

describe('scope — only the ids the caller supplied', () => {
  test('a bare call carries no session, run, agent or task', () => {
    const e = invokedEvent(start, {}, ctx)
    for (const k of ['sessionId', 'runId', 'agentId', 'taskId']) expect(k in e).toBe(false)
  })

  test('supplied ids land on the envelope', () => {
    const e = invokedEvent(start, { sessionId: 'ses_1', agentId: 'agt_1' }, ctx)
    expect(e.sessionId).toBe('ses_1')
    expect(e.agentId).toBe('agt_1')
    expect('runId' in e).toBe(false)
  })
})

describe('against the real A1 journal (a temp SQLite file)', () => {
  test('invoked + completed append once; a replay changes no count and is reported as duplicates', async () => {
    const j = await open()
    const em = createProviderEmitter({ journal: j, adapterVersion: 'anthropic@1', now: () => new Date('2026-09-25T12:00:05.000Z') })

    const r1 = await em.invoked(start)
    const r2 = await em.terminal(completed(), {}, '2026-09-25T12:00:01.000Z')
    expect(r1).toEqual({ written: 1, duplicates: 0, rejected: [] })
    expect(r2).toEqual({ written: 1, duplicates: 0, rejected: [] })

    // Replay: same attempt, different wall clock.
    const replay = createProviderEmitter({ journal: j, adapterVersion: 'anthropic@1', now: () => new Date('2026-09-27T00:00:00.000Z') })
    expect(await replay.invoked(start)).toEqual({ written: 0, duplicates: 1, rejected: [] })
    expect(await replay.terminal(completed())).toEqual({ written: 0, duplicates: 1, rejected: [] })

    expect((await j.stats()).rows).toBe(2)
    const page = await j.readFrom(0, 10)
    expect(page.events.map(e => e.type)).toEqual(['model.invoked', 'model.completed'])
    const back = page.events[1] as AgentisticsEvent<'model.completed'>
    expect(back.data.usage).toEqual({ input: 12, output: 340, cacheRead: 45_000, cacheWrite: 1_500 })
    expect(back.eventId).toBe(completedEvent(completed(), {}, ctx, 'x').eventId)
    expect(em.counters().lost).toEqual({ 'model.invoked': 0, 'model.completed': 0, 'model.failed': 0 })
    j.close()
  })

  test('a retried invocation: failed attempt 1, completed attempt 2 — four rows, one billed response', async () => {
    const j = await open()
    const em = createProviderEmitter({ journal: j, adapterVersion: 'anthropic@1' })
    await em.invoked(start)
    await em.terminal(failed())
    await em.invoked({ ...start, attempt: 2 })
    await em.terminal(completed({ attempt: 2 }))
    const events = (await j.readFrom(0, 10)).events
    expect(events.map(e => e.type)).toEqual(['model.invoked', 'model.failed', 'model.invoked', 'model.completed'])
    expect(events.filter(e => e.type === 'model.completed')).toHaveLength(1)
    const failedBack = events[1] as AgentisticsEvent<'model.failed'>
    expect('usage' in failedBack.data).toBe(false)
    j.close()
  })

  test('no emitted string matches sk-ant- or equals the test key — even when the input carries one', async () => {
    const j = await open()
    const em = createProviderEmitter({ journal: j, adapterVersion: 'anthropic@1' })
    // The key smuggled into every field emit.ts has no reason to read, plus the content a real
    // client result carries (not part of the input type — which is the point).
    const dirty = { ...completed({ requestId: TEST_KEY }), content: [{ type: 'text', text: TEST_KEY }] } as AttemptCompleted
    const dirtyFail = { ...failed({ requestId: TEST_KEY }), message: TEST_KEY } as AttemptFailed
    dirtyFail.error = { ...dirtyFail.error, errorType: TEST_KEY, requestId: TEST_KEY }
    await em.invoked(start)
    await em.terminal(dirty)
    await em.terminal({ ...dirtyFail, attempt: 2 })
    const stored = JSON.stringify((await j.readFrom(0, 10)).events)
    expect(stored).not.toContain('sk-ant-')
    expect(stored).not.toContain(TEST_KEY)
    const built = JSON.stringify([completedEvent(dirty, {}, ctx, 't'), failedEvent(dirtyFail, {}, ctx, 't')])
    expect(built).not.toContain('sk-ant-')
    j.close()
  })
})

describe('a journal that fails never fails the call', () => {
  test('no journal: resolves null, counts the loss by type', async () => {
    const em = createProviderEmitter({ journal: null, adapterVersion: 'anthropic@1' })
    expect(await em.invoked(start)).toBeNull()
    expect(await em.terminal(failed())).toBeNull()
    expect(await em.terminal(completed())).toBeNull()
    expect(em.counters().lost).toEqual({ 'model.invoked': 1, 'model.completed': 1, 'model.failed': 1 })
  })

  test('an append that throws resolves null and is counted', async () => {
    const throwing = { append: async () => { throw new Error('disk gone') } } as unknown as Journal
    const em = createProviderEmitter({ journal: throwing, adapterVersion: 'anthropic@1' })
    expect(await em.invoked(start)).toBeNull()
    expect(em.counters().lost['model.invoked']).toBe(1)
  })

  test('a disabled journal (network filesystem) drops the event: counted lost, never thrown', async () => {
    const nfs: PathProbe = { ...localProbe, readMountinfo: () => '58 42 0:50 / / rw - nfs4 server:/x rw' }
    const j = await openJournal({ path: freshPath(), probe: nfs })
    expect(j.status().state).toBe('disabled')
    const em = createProviderEmitter({ journal: j, adapterVersion: 'anthropic@1' })
    const r = await em.terminal(completed())
    expect(r?.written).toBe(0)
    expect(em.counters().lost['model.completed']).toBe(1)
  })
})

describe('source guard', () => {
  test('emit.ts names no credential', () => {
    const code = readFileSync(join(import.meta.dir, 'emit.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).not.toMatch(/apiKey|api_key|x-api-key|authorization|bearer|credentials\.json/i)
  })
})
