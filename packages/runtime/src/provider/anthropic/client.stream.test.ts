/**
 * client.stream.test.ts — B2.1: `streamOnce` / `createAnthropicClient().stream` against a STUB
 * `fetch` whose body is a `ReadableStream` delivering SSE in awkward byte splits (mid-line, mid-event,
 * mid-UTF-8-character). No network ever leaves this process; every "key" is an obviously fake string.
 *
 * The streams replayed are the documented ones in `test/fixtures/provider/anthropic/*.documented.sse`
 * (source: https://docs.anthropic.com/en/api/messages-streaming, cited in each file's header).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetCaptureCounters } from '../capture.ts'
import { decideRetry } from '@agentistics/core'
import { anthropicCounters, createAnthropicClient, resetAnthropicCounters, streamOnce } from './client.ts'
import type { CredentialHandle, CredentialResolver } from '../credential.ts'
import type { InvocationResult, ProviderRequest, ProviderStreamEvent } from '../client.ts'

const FAKE_KEY = 'sk-ant-FAKE00000000000000000000STREAMTEST'
const FIXTURES = join(import.meta.dir, '../../../test/fixtures/provider/anthropic')
const TEXT = readFileSync(join(FIXTURES, 'stream-text.documented.sse'), 'utf8')
const TOOL = readFileSync(join(FIXTURES, 'stream-tool-use.documented.sse'), 'utf8')
const ERROR = readFileSync(join(FIXTURES, 'stream-error-overloaded.documented.sse'), 'utf8')

function fakeHandle(): CredentialHandle {
  const label = '[credential anthropic sha256:00000000]'
  return { provider: 'anthropic', fingerprint: 'sha256:00000000', reveal: () => FAKE_KEY, toString: () => label, toJSON: () => label } as CredentialHandle
}
const okResolver: CredentialResolver = { resolve: async () => ({ ok: true, handle: fakeHandle() }) }

let CAPTURE_DIR = ''
beforeAll(() => { CAPTURE_DIR = mkdtempSync(join(tmpdir(), 'agentistics-anthropic-stream-')) })
afterAll(() => { rmSync(CAPTURE_DIR, { recursive: true, force: true }) })
afterEach(() => { resetAnthropicCounters(); resetCaptureCounters() })

function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 64,
    correlation: { invocationId: 'inv_stream1' },
    credential: { provider: 'anthropic', id: 'default' },
    ...overrides,
  }
}

/** Splits bytes into deliberately awkward pieces: 1, 2, 3, 5, 8, 13 … cycling, so boundaries land
 *  mid-line, mid-field, between CR and LF and inside multi-byte UTF-8 characters. */
function awkwardChunks(text: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(text)
  const sizes = [1, 2, 3, 5, 8, 13, 21, 34]
  const out: Uint8Array[] = []
  let i = 0
  let k = 0
  while (i < bytes.length) {
    const n = sizes[k++ % sizes.length]!
    out.push(bytes.slice(i, i + n))
    i += n
  }
  return out
}

interface StubOptions {
  status?: number
  headers?: Record<string, string>
  /** before chunk `n` is enqueued, wait for this promise (lets a test prove deltas arrive early) */
  gate?: { at: number; wait: Promise<void> }
  /** after the chunks: close (default), keep the body open (for abort), or fail as a dropped connection */
  after?: 'close' | 'hang' | 'error'
}

interface Stub {
  fetch: typeof fetch
  calls(): number
  lastSignal(): AbortSignal | undefined
}

function streamingFetch(body: string, opts: StubOptions = {}): Stub {
  let calls = 0
  let signal: AbortSignal | undefined
  const impl = async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls += 1
    signal = init?.signal ?? undefined
    const chunks = awkwardChunks(body)
    let n = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => {
          try { controller.error(new DOMException('The operation was aborted.', 'AbortError')) } catch { /* closed */ }
        }, { once: true })
      },
      async pull(controller) {
        if (opts.gate && n === opts.gate.at) await opts.gate.wait
        if (signal?.aborted) return
        if (n < chunks.length) {
          controller.enqueue(chunks[n++]!)
          return
        }
        if (opts.after === 'hang') return new Promise<void>(() => {})
        if (opts.after === 'error') {
          controller.error(new TypeError('network connection lost'))
          return
        }
        controller.close()
      },
    })
    return new Response(stream, {
      status: opts.status ?? 200,
      headers: { 'content-type': 'text/event-stream', 'request-id': 'req_stream_1', ...opts.headers },
    })
  }
  return { fetch: impl as typeof fetch, calls: () => calls, lastSignal: () => signal }
}

async function collect(stream: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

function endOf(events: ProviderStreamEvent[]): InvocationResult {
  const ends = events.filter(e => e.type === 'end')
  expect(ends.length).toBe(1)
  expect(events[events.length - 1]!.type).toBe('end')
  return (ends[0] as Extract<ProviderStreamEvent, { type: 'end' }>).result
}

function deps(stub: Stub) {
  return { resolver: okResolver, fetchImpl: stub.fetch, captureDir: CAPTURE_DIR }
}

function readCapture(ref: { sha256: string } | undefined) {
  expect(ref).toBeDefined()
  const path = join(CAPTURE_DIR, ref!.sha256.slice(0, 2), ref!.sha256)
  return JSON.parse(readFileSync(path, 'utf8')) as { status: number; headers: Record<string, string>; body: string }
}

describe('anthropic/client.ts — streamOnce against a stub streaming fetch (no network)', () => {
  test('the documented text stream: started, deltas, usage, then ONE end — completed, facts from the raw SSE', async () => {
    const stub = streamingFetch(TEXT)
    const events = await collect(streamOnce(baseRequest(), 1, deps(stub)))
    expect(events.map(e => e.type)).toEqual(['started', 'text-delta', 'text-delta', 'usage', 'end'])
    expect(events[0]).toEqual({ type: 'started', requestId: 'req_stream_1', messageId: 'msg_documented_stream_text_0001', servedModel: 'claude-opus-4-6' })
    const result = endOf(events)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result).toMatchObject({
      invocationId: 'inv_stream1', attempt: 1, provider: 'anthropic', requestedModel: 'claude-opus-4-6',
      messageId: 'msg_documented_stream_text_0001', servedModel: 'claude-opus-4-6', requestId: 'req_stream_1',
      content: [{ type: 'text', text: 'Hello!' }], toolCallFailures: [],
    })
    expect(result.usage).toMatchObject({ input: 25, output: 15, missing: ['cacheRead', 'cacheWrite'] })
    expect(result.stopReason.kind).toBe('end-turn')
    expect(stub.calls()).toBe(1)
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY)
  })

  test('deltas reach the caller BEFORE the body has ended (the capture tees, it does not wait)', async () => {
    let release!: () => void
    const wait = new Promise<void>(r => { release = r })
    // Hold the body right after the first text delta's frame (its blank line), long before the end.
    const firstDeltaEnd = new TextEncoder().encode(TEXT.slice(0, TEXT.indexOf('"Hello"}}') + 12)).length
    let at = 0
    for (let bytes = 0; bytes < firstDeltaEnd; at++) bytes += awkwardChunks(TEXT)[at]!.length
    const stub = streamingFetch(TEXT, { gate: { at, wait } })
    const iter = streamOnce(baseRequest(), 1, deps(stub))[Symbol.asyncIterator]()
    const seen: string[] = []
    for (;;) {
      const { value } = await iter.next()
      seen.push(value!.type)
      if (value!.type === 'text-delta') break
    }
    expect(seen).toEqual(['started', 'text-delta'])
    release()
    const rest: ProviderStreamEvent[] = []
    for (;;) {
      const { value, done } = await iter.next()
      if (done) break
      rest.push(value)
    }
    expect(endOf(rest).status).toBe('completed')
  })

  test('the raw capture holds the WHOLE SSE body and only allowlisted headers', async () => {
    const stub = streamingFetch(TEXT, { headers: { 'anthropic-organization-id': 'org_secret', 'set-cookie': 'x=y', 'anthropic-ratelimit-tokens-remaining': '9' } })
    const result = endOf(await collect(streamOnce(baseRequest(), 1, deps(stub))))
    const cap = readCapture(result.capture)
    expect(cap.status).toBe(200)
    expect(cap.body).toBe(TEXT)
    expect(cap.headers['request-id']).toBe('req_stream_1')
    expect(cap.headers['anthropic-ratelimit-tokens-remaining']).toBe('9')
    expect(cap.headers['anthropic-organization-id']).toBeUndefined()
    expect(cap.headers['set-cookie']).toBeUndefined()
  })

  test('a multi-byte UTF-8 answer split mid-character arrives intact', async () => {
    const text = TEXT.replace('"Hello"', '"Olá, mundo 🌍"')
    const result = endOf(await collect(streamOnce(baseRequest(), 1, deps(streamingFetch(text)))))
    if (result.status !== 'completed') throw new Error('expected completed')
    expect(result.content).toEqual([{ type: 'text', text: 'Olá, mundo 🌍!' }])
    expect(readCapture(result.capture).body).toBe(text)
  })

  test('the documented tool-use stream: tool-call-deltas, one tool-call, tool_use in content', async () => {
    const events = await collect(streamOnce(baseRequest({ tools: [{ name: 'get_weather', inputSchema: { type: 'object' } }] }), 1, deps(streamingFetch(TOOL))))
    expect(events.filter(e => e.type === 'tool-call-delta').length).toBe(9)
    expect(events.filter(e => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', index: 1, id: 'toolu_documented_stream_0001', name: 'get_weather', input: { location: 'San Francisco, CA', unit: 'fahrenheit' } },
    ])
    const result = endOf(events)
    if (result.status !== 'completed') throw new Error('expected completed')
    expect(result.stopReason.kind).toBe('tool-use')
    expect(result.content[1]).toEqual({ type: 'tool_use', id: 'toolu_documented_stream_0001', name: 'get_weather', input: { location: 'San Francisco, CA', unit: 'fahrenheit' } })
  })

  test('an undeclared tool name fails the CALL (unknown-tool), carried as other — the invocation completes', async () => {
    const events = await collect(streamOnce(baseRequest({ tools: [{ name: 'something_else', inputSchema: { type: 'object' } }] }), 1, deps(streamingFetch(TOOL))))
    expect(events.some(e => e.type === 'tool-call')).toBe(false)
    const result = endOf(events)
    if (result.status !== 'completed') throw new Error('expected completed')
    expect(result.toolCallFailures?.map(f => f.reason)).toEqual(['unknown-tool'])
    expect(result.content[1]).toEqual({ type: 'other', rawType: 'tool_use' })
  })

  test('HTTP 200 with the documented in-band overloaded_error → FAILED overloaded, no usage, one request', async () => {
    const stub = streamingFetch(ERROR)
    const events = await collect(streamOnce(baseRequest(), 1, deps(stub)))
    const result = endOf(events)
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.error).toMatchObject({ kind: 'overloaded', httpStatus: 200, usageOutcome: 'unknown', errorType: 'overloaded_error' })
    expect('usage' in result).toBe(false)
    expect(result.requestId).toBe('req_stream_1')
    expect(stub.calls()).toBe(1)
    expect(readCapture(result.capture).body).toBe(ERROR)
  })

  test('an in-band overloaded_error mid-stream is NOT retried, though its kind is retryable (leader decision 2026-09-27)', async () => {
    const result = endOf(await collect(streamOnce(baseRequest(), 1, deps(streamingFetch(ERROR)))))
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    // The kind alone would retry; the possibly-billed outcome is what refuses it.
    expect(result.error.retryable).toBe(true)
    expect(decideRetry({ attempt: 1, elapsedMs: 0, error: result.error })).toEqual({ retry: false, reason: 'ambiguous-outcome' })
  })

  test('a body that closes before message_stop → failed network, usage unknown, captured as far as it got', async () => {
    const cut = TEXT.slice(0, TEXT.indexOf('event: message_delta'))
    const result = endOf(await collect(streamOnce(baseRequest(), 1, deps(streamingFetch(cut)))))
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.error).toMatchObject({ kind: 'network', usageOutcome: 'unknown' })
    expect('usage' in result).toBe(false)
    expect(readCapture(result.capture).body).toBe(cut)
  })

  test('a connection that drops mid-body → failed network, never completed, iteration does not throw', async () => {
    const cut = TEXT.slice(0, TEXT.indexOf('event: content_block_stop'))
    const result = endOf(await collect(streamOnce(baseRequest(), 1, deps(streamingFetch(cut, { after: 'error' })))))
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.error).toMatchObject({ kind: 'network', usageOutcome: 'unknown' })
  })

  test('abort via req.signal mid-stream → failed aborted, end last and exactly once', async () => {
    const controller = new AbortController()
    const cut = TEXT.slice(0, TEXT.indexOf('event: content_block_stop'))
    const stub = streamingFetch(cut, { after: 'hang' })
    const events: ProviderStreamEvent[] = []
    for await (const ev of streamOnce(baseRequest({ signal: controller.signal }), 1, deps(stub))) {
      events.push(ev)
      if (ev.type === 'text-delta') controller.abort()
    }
    const result = endOf(events)
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.error).toMatchObject({ kind: 'aborted', usageOutcome: 'unknown' })
    expect('usage' in result).toBe(false)
  })

  test('an already-aborted signal: no response head → failed aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const stub: Stub = {
      fetch: (async (_i: unknown, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
        throw new Error('unexpected')
      }) as unknown as typeof fetch,
      calls: () => 0,
      lastSignal: () => undefined,
    }
    const result = endOf(await collect(streamOnce(baseRequest({ signal: controller.signal }), 1, deps(stub))))
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.error.kind).toBe('aborted')
  })

  test('a fetch that rejects before any response → failed network (sent, usage unknown)', async () => {
    const stub: Stub = {
      fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
      calls: () => 1,
      lastSignal: () => undefined,
    }
    const result = endOf(await collect(streamOnce(baseRequest(), 1, deps(stub))))
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.error).toMatchObject({ kind: 'network', usageOutcome: 'unknown' })
  })

  test.each([
    [529, 'overloaded_error', 'overloaded', true],
    [500, 'api_error', 'api-error', true],
    [400, 'invalid_request_error', 'invalid-request', false],
    [401, 'authentication_error', 'authentication', false],
  ] as const)('HTTP %d → failed %s via the same classifier as invokeOnce, captured, no usage', async (status, errorType, kind, retryable) => {
    const body = JSON.stringify({ type: 'error', error: { type: errorType, message: 'x' }, request_id: 'req_body' })
    const stub = streamingFetch(body, { status, headers: { 'content-type': 'application/json' } })
    const events = await collect(streamOnce(baseRequest(), 1, deps(stub)))
    expect(events.map(e => e.type)).toEqual(['end'])
    const result = endOf(events)
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.error).toMatchObject({ kind, retryable, httpStatus: status, usageOutcome: 'none-reported' })
    expect('usage' in result).toBe(false)
    expect(stub.calls()).toBe(1)
    expect(readCapture(result.capture)).toMatchObject({ status, body })
  })

  test('invalid maxTokens: one end, no request', async () => {
    const stub = streamingFetch(TEXT)
    const events = await collect(streamOnce(baseRequest({ maxTokens: 0 }), 1, deps(stub)))
    expect(events.map(e => e.type)).toEqual(['end'])
    const result = endOf(events)
    if (result.status === 'failed') expect(result.error.kind).toBe('invalid-request')
    expect(stub.calls()).toBe(0)
  })

  test('no credential: one end (authentication, none-reported), no request', async () => {
    const stub = streamingFetch(TEXT)
    const refusing: CredentialResolver = { resolve: async () => ({ ok: false, reason: 'missing' }) as never }
    const events = await collect(streamOnce(baseRequest(), 1, { resolver: refusing, fetchImpl: stub.fetch, captureDir: CAPTURE_DIR }))
    const result = endOf(events)
    if (result.status === 'failed') expect(result.error).toMatchObject({ kind: 'authentication', usageOutcome: 'none-reported' })
    expect(stub.calls()).toBe(0)
  })

  test('a consumer that walks away mid-stream cancels the HTTP request', async () => {
    const stub = streamingFetch(TEXT.slice(0, TEXT.indexOf('event: content_block_stop')), { after: 'hang' })
    for await (const ev of streamOnce(baseRequest(), 1, deps(stub))) {
      if (ev.type === 'text-delta') break
    }
    expect(stub.lastSignal()?.aborted).toBe(true)
  })

  test('iteration never throws, whatever the body is', async () => {
    for (const body of ['', 'garbage without frames', 'data: {not json\n\n', TEXT.replaceAll('message_stop', 'mess')]) {
      const result = endOf(await collect(streamOnce(baseRequest(), 1, deps(streamingFetch(body)))))
      expect(result.status).toBe('failed')
    }
  })

  test('createAnthropicClient().stream is the same path; the SDK\'s own per-step usage agrees with the raw read', async () => {
    const stub = streamingFetch(TEXT, { headers: { 'request-id': '' } })
    const client = createAnthropicClient(deps(stub))
    expect(client.capabilities.streaming).toBe(true)
    const result = endOf(await collect(client.stream!(baseRequest(), 2)))
    expect(result.attempt).toBe(2)
    expect(result.status).toBe('completed')
    expect(anthropicCounters.sdk_usage_divergence).toBe(0)
  })
})
