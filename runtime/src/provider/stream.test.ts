import { describe, expect, test } from 'bun:test'
import type { InvocationResult, ProviderClient, ProviderRequest, ProviderStreamEvent } from './client.ts'
import { isEphemeralProviderEvent, openProviderStream, providerEventStream, streamingRefusal } from './stream.ts'

const req: ProviderRequest = {
  model: 'claude-haiku-4-5-20251001',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 16,
  correlation: { invocationId: 'inv_test' },
  credential: { provider: 'anthropic', id: 'default' },
}

function failed(): InvocationResult {
  return {
    invocationId: 'inv_test', attempt: 1, provider: 'anthropic', requestedModel: req.model,
    startedAt: new Date().toISOString(), latencyMs: 1, status: 'failed',
    error: { kind: 'network', retryable: true } as never,
  }
}

function client(over: Partial<ProviderClient>): ProviderClient {
  return {
    provider: 'anthropic', adapterVersion: 'test-1',
    capabilities: { streaming: true, editPolicy: 'none' as never },
    invokeOnce: async () => failed(),
    ...over,
  }
}

describe('openProviderStream', () => {
  test('a non-streaming client is refused in words — never a hang', () => {
    const c = client({ capabilities: { streaming: false, editPolicy: 'none' as never } })
    const r = openProviderStream(c, req, 1)
    expect(r).toEqual({ ok: false, reason: 'streaming-unsupported', userCode: 'provider.streaming_unsupported', provider: 'anthropic' })
  })

  test('a client claiming streaming without a stream method is refused, not trusted', () => {
    expect(streamingRefusal(client({}))?.reason).toBe('streaming-unsupported')
  })

  test('a streaming client is opened with the same request and attempt', async () => {
    const seen: Array<[ProviderRequest, number]> = []
    const c = client({
      async *stream(r, a) { seen.push([r, a]); yield { type: 'end', result: failed() } },
    })
    const r = openProviderStream(c, req, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const got: ProviderStreamEvent[] = []
    for await (const e of r.stream) got.push(e)
    expect(seen).toEqual([[req, 2]])
    expect(got.map(e => e.type)).toEqual(['end'])
  })
})

describe('providerEventStream', () => {
  test('only deltas and running usage are ephemeral', () => {
    const r = failed()
    const kinds: Array<[ProviderStreamEvent, boolean]> = [
      [{ type: 'started' }, false],
      [{ type: 'text-delta', index: 0, text: 'a' }, true],
      [{ type: 'tool-call-delta', index: 1, id: 't', name: 'n', partialJson: '{' }, true],
      [{ type: 'tool-call', index: 1, id: 't', name: 'n', input: {} }, false],
      [{ type: 'tool-call-failed', failure: { index: 1, id: 't', name: 'n', reason: 'malformed', userCode: 'x' } }, false],
      [{ type: 'usage', outputTokensSoFar: 3 }, true],
      [{ type: 'end', result: r }, false],
    ]
    for (const [e, want] of kinds) expect(isEphemeralProviderEvent(e)).toBe(want)
  })

  test('a stalled reader still receives `end`, and a late one learns it', async () => {
    const hub = providerEventStream({ bufferLimit: 4, stallGraceMs: 0 })
    const stalled = hub.subscribe()
    async function* s(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'started', messageId: 'msg_1' }
      for (let i = 0; i < 500; i++) yield { type: 'text-delta', index: 0, text: 'x' }
      yield { type: 'end', result: failed() }
    }
    await hub.pipe(s())
    const got = []
    for await (const d of stalled) got.push(d)
    expect(got.length).toBeLessThanOrEqual(4)
    expect(got[0]).toEqual({ kind: 'event', event: { type: 'started', messageId: 'msg_1' } })
    expect(got.at(-1)).toMatchObject({ kind: 'event', event: { type: 'end' } })
    const late = []
    for await (const d of hub.subscribe()) late.push(d)
    expect(late).toHaveLength(1)
    expect(late[0]).toMatchObject({ kind: 'event', event: { type: 'end' } })
  })
})
