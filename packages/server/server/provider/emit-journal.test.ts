/**
 * emit-journal.test.ts — the HOST half of the journal seam (D23). `@agentistics/runtime`'s
 * `createProviderEmitter` appends to a `ProviderJournalSink` it does not own; this proves agentop's
 * real A1 journal (`../journal/journal.ts`, a temp SQLite file) satisfies that sink STRUCTURALLY —
 * passed as-is, with no adapter — and that its dedupe makes a replay converge. The emitter's own
 * rules are pinned in `packages/runtime/src/provider/emit.test.ts` against an in-memory sink.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyProviderError,
  fromAnthropicStopReason,
  fromAnthropicUsage,
  type AgentisticsEvent,
} from '@agentistics/core'
import {
  completedEvent,
  createProviderEmitter,
  failedEvent,
  type AttemptCompleted,
  type AttemptFailed,
  type AttemptStart,
  type EmitContext,
  type ProviderJournalSink,
} from '@agentistics/runtime'
import { openJournal } from '../journal/journal'
import type { PathProbe } from '../journal/schema'
import type { Journal } from '../journal/types'

// Compile-time: the host's Journal IS a runtime sink, with no adapter in between.
const _structural: (j: Journal) => ProviderJournalSink = j => j
void _structural

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

describe('a journal that fails never fails the call — the real journal', () => {
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
