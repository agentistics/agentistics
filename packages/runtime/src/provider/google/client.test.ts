/**
 * client.test.ts — B5b.1: `invokeGoogleOnce` / `streamGoogleOnce` / `createGoogleClient` against a
 * STUB `fetch`. No network ever leaves this process.
 *
 * A `*.test.ts`, so `provider-secrets.lint.test.ts` does not walk it: the C-1 test below SETS the
 * environment variables Google's SDKs fall back to, precisely to prove this client never reads them.
 * Every "key" here is an obviously fake string built for the test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { translations } from '@agentistics/core'
import {
  GOOGLE_BASE_URL_CONSTANT,
  buildGoogleBody,
  createGoogleClient,
  invokeGoogleOnce,
  mapGoogleContents,
  normalizeGoogleModel,
  streamGoogleOnce,
  type GoogleClientDeps,
} from './client.ts'
import { createProviderClients } from '../registry.ts'
import { PROVIDER_CLIENT_ABSENT } from '../client.ts'
import type { CredentialHandle, CredentialResolver } from '../credential.ts'
import type { ProviderRequest, ProviderStreamEvent } from '../client.ts'

const FAKE_KEY = 'AIzaFAKE000000000000000000000TESTONLY'

function fakeHandle(provider: 'google' | 'anthropic' = 'google', value = FAKE_KEY): CredentialHandle {
  const label = `[credential ${provider} sha256:00000000]`
  return { provider, fingerprint: 'sha256:00000000', reveal: () => value, toString: () => label, toJSON: () => label } as CredentialHandle
}

let CAPTURE_DIR = ''
beforeAll(() => { CAPTURE_DIR = mkdtempSync(join(tmpdir(), 'agentistics-google-client-')) })
afterAll(() => { rmSync(CAPTURE_DIR, { recursive: true, force: true }) })

const okResolver: CredentialResolver = { resolve: async () => ({ ok: true, handle: fakeHandle() }) }

function deps(over: Partial<GoogleClientDeps> = {}): GoogleClientDeps {
  return { resolver: okResolver, captureDir: CAPTURE_DIR, ...over }
}

function req(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 16,
    correlation: { invocationId: 'inv_g1' },
    credential: { provider: 'google', id: 'default' },
    ...over,
  }
}

function genBody(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 9, cachedContentTokenCount: 0, candidatesTokenCount: 1, totalTokenCount: 10 },
    modelVersion: 'gemini-2.5-flash',
    ...overrides,
  }
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

interface Seen { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function recordingFetch(respond: () => Response | Promise<Response>, seen: Seen[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    seen.push({ url, headers, body: JSON.parse(String(init?.body ?? '{}')) })
    return respond()
  }) as typeof fetch
}

/** An SSE body delivered in `pieces`, with an optional error to end it. */
function sseResponse(pieces: string[], opts: { failAfter?: boolean; signal?: AbortSignal } = {}): Response {
  const enc = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < pieces.length) { controller.enqueue(enc.encode(pieces[i++]!)); return }
      if (opts.failAfter) controller.error(new Error('connection reset'))
      else controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const data = (o: unknown) => `data: ${JSON.stringify(o)}\r\n\r\n`

async function collect(stream: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe('google/client.ts — invokeOnce against a stub fetch (no network)', () => {
  test('C-1: the explicit key + host win over an ambient env, and no sentinel leaks anywhere', async () => {
    const names = [
      'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
    ] as const
    const prev = names.map(n => process.env[n])
    process.env.GEMINI_API_KEY = 'SENTINEL_ENV_KEY_gemini'
    process.env.GOOGLE_API_KEY = 'SENTINEL_ENV_KEY_google'
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://sentinel-gemini.invalid/v1beta'
    process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true'
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/sentinel/adc.json'
    process.env.GOOGLE_CLOUD_PROJECT = 'sentinel-project'
    const writes: string[] = []
    try {
      const seen: Seen[] = []
      const result = await invokeGoogleOnce(req(), 1, deps({
        fetch: recordingFetch(() => json(genBody()), seen),
        writeCapture: async (ex) => { writes.push(JSON.stringify(ex)); return { sha256: 'f'.repeat(64), bytes: 1 } },
      }))
      expect(result.status).toBe('completed')
      expect(seen).toHaveLength(1)
      expect(seen[0]!.url).toBe(`${GOOGLE_BASE_URL_CONSTANT}/models/gemini-2.5-flash:generateContent`)
      expect(seen[0]!.headers['x-goog-api-key']).toBe(FAKE_KEY)

      const everything = JSON.stringify({ seen, result, writes })
      for (const sentinel of ['SENTINEL_ENV_KEY_gemini', 'SENTINEL_ENV_KEY_google', 'sentinel-gemini.invalid', '/sentinel/adc.json', 'sentinel-project']) {
        expect(everything).not.toContain(sentinel)
      }
      // The key went out on the request and nowhere else: not in the result, not in the capture.
      expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
      expect(writes.join('')).not.toContain(FAKE_KEY)

      // A stream and a failure leak none of them either.
      const seenStream: Seen[] = []
      const events = await collect(streamGoogleOnce(req(), 1, deps({
        fetch: recordingFetch(() => sseResponse([data(genBody())]), seenStream),
        writeCapture: async (ex) => { writes.push(JSON.stringify(ex)); return undefined },
      })))
      expect(seenStream[0]!.url).toBe(`${GOOGLE_BASE_URL_CONSTANT}/models/gemini-2.5-flash:streamGenerateContent?alt=sse`)
      expect(seenStream[0]!.headers['x-goog-api-key']).toBe(FAKE_KEY)
      const failed = await invokeGoogleOnce(req(), 1, deps({
        fetch: recordingFetch(() => json({ error: { code: 400, message: 'bad key SENTINEL', status: 'INVALID_ARGUMENT' } }, { status: 400 }), []),
      }))
      expect(failed.status).toBe('failed')
      const all = JSON.stringify({ events, failed, writes })
      for (const s of ['SENTINEL', FAKE_KEY, 'sentinel-gemini.invalid']) expect(all).not.toContain(s)
    } finally {
      names.forEach((n, i) => { if (prev[i] === undefined) delete process.env[n]; else process.env[n] = prev[i] })
    }
  })

  test('the ONLY credential header is the key header — no other auth scheme is ever presented', async () => {
    const seen: Seen[] = []
    await invokeGoogleOnce(req(), 1, deps({ fetch: recordingFetch(() => json(genBody()), seen) }))
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(['content-type', 'x-goog-api-key'])
  })

  test('ONE POST with the mapped body; identity is inferred and no id is invented', async () => {
    const seen: Seen[] = []
    const result = await invokeGoogleOnce(req({
      system: 'be brief',
      tools: [{ name: 'get_weather', description: 'weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, additionalProperties: false } }],
    }), 2, deps({ fetch: recordingFetch(() => json(genBody(), { headers: { 'x-request-id': 'req_HIDDEN' } }), seen) }))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      systemInstruction: { parts: [{ text: 'be brief' }] },
      tools: [{ functionDeclarations: [{
        name: 'get_weather', description: 'weather',
        parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } }, additionalProperties: false },
      }] }],
      generationConfig: { maxOutputTokens: 16 },
    })
    if (result.status !== 'completed') throw new Error('expected completed')
    expect(result.provider).toBe('google')
    expect(result.attempt).toBe(2)
    expect(result.messageId).toBe('')
    expect(result.requestId).toBeUndefined()
    expect(result.correlationBasis).toBe('inferred')
    expect(result.servedModel).toBe('gemini-2.5-flash')
    expect(result.usageCertainty).toBe('provider-stated')
    expect(result.usage).toMatchObject({ input: 9, output: 1, cacheRead: 0 })
    expect(JSON.stringify(result)).not.toContain('req_HIDDEN')
  })

  test('the toolUsePrompt figure reaches the result beside the counters and inside none of them', async () => {
    const result = await invokeGoogleOnce(req(), 1, deps({
      fetch: recordingFetch(() => json(genBody({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, toolUsePromptTokenCount: 30 } })), []),
    }))
    if (result.status !== 'completed') throw new Error('expected completed')
    expect(result.toolUsePrompt).toEqual({ tokens: 30, billing: 'unknown' })
    expect(result.usage.input).toBe(100)
  })

  test('a failure is marked inferred too, carries no usage, and no request id', async () => {
    const result = await invokeGoogleOnce(req(), 1, deps({
      fetch: recordingFetch(() => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, { status: 429, headers: { 'retry-after': '2' } }), []),
    }))
    if (result.status !== 'failed') throw new Error('expected failed')
    expect(result.error).toMatchObject({ kind: 'rate-limited', retryable: true, retryAfterMs: 2000, usageOutcome: 'none-reported' })
    expect(result.correlationBasis).toBe('inferred')
    expect('usage' in result).toBe(false)
    expect(result.requestId).toBeUndefined()
  })

  test('NO hidden retry: a 500 is one request, then failed (the loop is the caller\'s)', async () => {
    const seen: Seen[] = []
    const result = await invokeGoogleOnce(req(), 1, deps({ fetch: recordingFetch(() => json({ error: { code: 500 } }, { status: 500 }), seen) }))
    expect(seen).toHaveLength(1)
    if (result.status !== 'failed') throw new Error('expected failed')
    expect(result.error.retryable).toBe(true) // it MAY be retried — by `retry.ts`, as a new attempt
  })

  test('a network failure after the request left is ambiguous: unknown outcome, never retried by decideRetry', async () => {
    const result = await invokeGoogleOnce(req(), 1, deps({ fetch: (async () => { throw new TypeError('socket hang up') }) as unknown as typeof fetch }))
    if (result.status !== 'failed') throw new Error('expected failed')
    expect(result.error).toMatchObject({ kind: 'network', usageOutcome: 'unknown', retryable: false })
  })

  test('an already-aborted signal is `aborted`', async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await invokeGoogleOnce(req({ signal: ac.signal }), 1, deps({
      fetch: (async (_i: unknown, init?: RequestInit) => { if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError'); return json(genBody()) }) as unknown as typeof fetch,
    }))
    if (result.status !== 'failed') throw new Error('expected failed')
    expect(result.error.kind).toBe('aborted')
  })
})

describe('google/client.ts — what is refused BEFORE any request leaves', () => {
  async function refused(over: Partial<ProviderRequest>, d: Partial<GoogleClientDeps> = {}) {
    const seen: Seen[] = []
    const result = await invokeGoogleOnce(req(over), 1, deps({ fetch: recordingFetch(() => json(genBody()), seen), ...d }))
    expect(seen).toHaveLength(0)
    if (result.status !== 'failed') throw new Error('expected failed')
    return result.error
  }

  test('a credential ref for another provider is refused without asking the resolver', async () => {
    let asked = 0
    const resolver: CredentialResolver = { resolve: async () => { asked++; return { ok: true, handle: fakeHandle() } } }
    const err = await refused({ credential: { provider: 'anthropic', id: 'default' } }, { resolver })
    expect(err).toMatchObject({ kind: 'authentication', usageOutcome: 'none-reported', userCode: 'provider.no_credential' })
    expect(asked).toBe(0)
  })

  test('an absent / unreadable / too-open key is a refusal — there is no keyless Gemini call', async () => {
    for (const reason of ['absent', 'unreadable', 'permissions-too-open', 'wrong-provider'] as const) {
      const err = await refused({}, { resolver: { resolve: async () => ({ ok: false, reason }) } })
      expect(err.userCode).toBe('provider.no_credential')
    }
  })

  test('a resolver that throws, or that hands back ANOTHER provider\'s handle, is a refusal', async () => {
    expect((await refused({}, { resolver: { resolve: async () => { throw new Error('boom') } } })).userCode).toBe('provider.no_credential')
    expect((await refused({}, { resolver: { resolve: async () => ({ ok: true, handle: fakeHandle('anthropic') }) } })).userCode).toBe('provider.no_credential')
  })

  test('a bad maxTokens, and a model id that is not a safe path segment, never reach the network', async () => {
    for (const maxTokens of [0, -1, 1.5, Number.NaN]) expect((await refused({ maxTokens })).kind).toBe('invalid-request')
    for (const model of ['', '../x', 'a/b', 'a:b', 'a?b', 'gemini 2', 'tunedModels/x']) {
      expect({ model, kind: (await refused({ model })).kind }).toEqual({ model, kind: 'invalid-request' })
    }
  })

  test('a tool_result whose call is nowhere in the history is refused, not sent under a guessed name', async () => {
    const err = await refused({ messages: [{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_x', content: 'r' }] }] })
    expect(err.kind).toBe('invalid-request')
  })
})

describe('google/client.ts — request mapping (pure)', () => {
  test('normalizeGoogleModel accepts a bare id or a models/ id and nothing that could change the route', () => {
    expect(normalizeGoogleModel('gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(normalizeGoogleModel('models/gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview')
    expect(normalizeGoogleModel('gemini-2.0_x.1')).toBe('gemini-2.0_x.1')
    expect(normalizeGoogleModel('a/../b')).toBeNull()
  })

  test('a tool round-trip: assistant tool_use → model functionCall, user tool_result → functionResponse by NAME', () => {
    const r = mapGoogleContents([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'call-1', name: 'get_weather', input: { city: 'Lisbon' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call-1', content: '18C' }, { type: 'text', text: 'and tomorrow?' }] },
    ])
    expect(r).toEqual({
      ok: true,
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        { role: 'model', parts: [{ text: 'looking' }, { functionCall: { id: 'call-1', name: 'get_weather', args: { city: 'Lisbon' } } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'call-1', name: 'get_weather', response: { output: '18C' } } }, { text: 'and tomorrow?' }] },
      ],
    })
  })

  test('a locally-minted call id never goes back on the wire; an error result uses the `error` key', () => {
    const r = mapGoogleContents([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'google-call-0', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'google-call-0', content: 'nope', isError: true }] },
    ])
    expect(JSON.stringify(r)).not.toContain('google-call-0')
    expect(r).toMatchObject({ ok: true, contents: [{}, { parts: [{ functionResponse: { name: 'f', response: { error: 'nope' } } }] }] })
  })

  test('cache marks are not sent (this wire has no cache_control) and no history is rewritten', () => {
    const built = buildGoogleBody(req({
      system: 's', systemCache: { type: 'ephemeral' },
      messages: [{ role: 'user', content: 'a', cache: { type: 'ephemeral', ttl: '1h' } }],
    }))
    if (!built.ok) throw new Error('expected ok')
    expect(JSON.stringify(built.body)).not.toContain('cache')
    expect(built.body.contents).toEqual([{ role: 'user', parts: [{ text: 'a' }] }])
  })
})

describe('google/client.ts — streaming', () => {
  test('a streamed answer: events in order, one request, `end` last and exactly once, facts from the raw body', async () => {
    const seen: Seen[] = []
    const captured: string[] = []
    const events = await collect(streamGoogleOnce(req(), 1, deps({
      fetch: recordingFetch(() => sseResponse([
        data({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }], modelVersion: 'gemini-2.5-flash' }),
        data({ candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, cachedContentTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 11 } }),
      ]), seen),
      writeCapture: async (ex) => { captured.push(ex.body); return { sha256: 'a'.repeat(64), bytes: ex.body.length } },
    })))
    expect(seen).toHaveLength(1)
    expect(events.map(e => e.type)).toEqual(['started', 'text-delta', 'text-delta', 'usage', 'end'])
    expect(events.filter(e => e.type === 'end')).toHaveLength(1)
    const end = events[events.length - 1]!
    if (end.type !== 'end' || end.result.status !== 'completed') throw new Error('expected completed end')
    expect(end.result.messageId).toBe('')
    expect(end.result.correlationBasis).toBe('inferred')
    expect(end.result.content).toEqual([{ type: 'text', text: 'Hello' }])
    expect(end.result.usage).toMatchObject({ input: 6, cacheRead: 2, output: 3, reasoning: { tokens: 11, billing: 'additive' } })
    expect(end.result.capture).toEqual({ sha256: 'a'.repeat(64), bytes: captured[0]!.length })
    expect(captured[0]).toContain('"candidatesTokenCount":3') // the RAW body is what was captured
  })

  test('a mid-stream failure (connection reset) ends `failed` with unknown outcome and NO usage', async () => {
    const events = await collect(streamGoogleOnce(req(), 1, deps({
      fetch: recordingFetch(() => sseResponse([data({ candidates: [{ content: { parts: [{ text: 'par' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } })], { failAfter: true }), []),
    })))
    const end = events[events.length - 1]!
    if (end.type !== 'end' || end.result.status !== 'failed') throw new Error('expected failed end')
    expect(end.result.error).toMatchObject({ kind: 'network', usageOutcome: 'unknown' })
    expect('usage' in end.result).toBe(false)
  })

  test('an in-band error on HTTP 200 ends `failed`, never `completed`', async () => {
    const events = await collect(streamGoogleOnce(req(), 1, deps({
      fetch: recordingFetch(() => sseResponse([
        data({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }),
        data({ error: { code: 503, status: 'UNAVAILABLE', message: 'quote of the prompt: SENTINEL' } }),
      ]), []),
    })))
    const end = events[events.length - 1]!
    if (end.type !== 'end' || end.result.status !== 'failed') throw new Error('expected failed end')
    expect(end.result.error.usageOutcome).toBe('unknown')
    expect(JSON.stringify(end.result)).not.toContain('SENTINEL') // the provider's message text is never read
  })

  test('an HTTP error status is classified from the status alone', async () => {
    const events = await collect(streamGoogleOnce(req(), 1, deps({
      fetch: recordingFetch(() => json({ error: { code: 403, status: 'PERMISSION_DENIED' } }, { status: 403 }), []),
    })))
    const end = events[events.length - 1]!
    if (end.type !== 'end' || end.result.status !== 'failed') throw new Error('expected failed end')
    expect(end.result.error).toMatchObject({ kind: 'permission', retryable: false })
  })

  test('a consumer that walks away aborts the request and receives no `end`', async () => {
    let aborted = false
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted = true })
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode(data({ candidates: [{ content: { parts: [{ text: 'a' }] } }] }))) },
        // never closes: the response would hang
      })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const seenTypes: string[] = []
    for await (const ev of streamGoogleOnce(req(), 1, deps({ fetch: fetchImpl }))) {
      seenTypes.push(ev.type)
      if (ev.type === 'text-delta') break
    }
    await new Promise(r => setTimeout(r, 10))
    expect(aborted).toBe(true)
    expect(seenTypes).not.toContain('end')
  })

  test('the caller\'s abort mid-body ends the attempt `aborted`', async () => {
    const ac = new AbortController()
    const enc = new TextEncoder()
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(data({ candidates: [{ content: { parts: [{ text: 'a' }] } }] })))
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const out: ProviderStreamEvent[] = []
    for await (const ev of streamGoogleOnce(req({ signal: ac.signal }), 1, deps({ fetch: fetchImpl }))) {
      out.push(ev)
      if (ev.type === 'text-delta') ac.abort()
    }
    const end = out[out.length - 1]!
    if (end.type !== 'end' || end.result.status !== 'failed') throw new Error('expected failed end')
    expect(end.result.error.kind).toBe('aborted')
  })

  test('the same refusals apply to a stream: no key, no request', async () => {
    const seen: Seen[] = []
    const events = await collect(streamGoogleOnce(req(), 1, deps({
      resolver: { resolve: async () => ({ ok: false, reason: 'absent' }) },
      fetch: recordingFetch(() => sseResponse([]), seen),
    })))
    expect(seen).toHaveLength(0)
    expect(events).toHaveLength(1)
    const end = events[0]!
    if (end.type !== 'end' || end.result.status !== 'failed') throw new Error('expected failed end')
    expect(end.result.error.userCode).toBe('provider.no_credential')
  })
})

describe('google/ — registry and the two things a key must never be', () => {
  test('the registry builds a streaming Google client only when the host injects deps; else a declared null with its reason', () => {
    const anthropic = { resolver: okResolver, captureDir: CAPTURE_DIR }
    expect(createProviderClients({ anthropic }).google).toBeNull()
    const client = createProviderClients({ anthropic, google: deps() }).google
    expect(client?.provider).toBe('google')
    expect(client?.capabilities.streaming).toBe(true)
    expect(typeof client?.stream).toBe('function')
    expect(client?.capabilities.editPolicy.provider).toBe('google')
    expect(PROVIDER_CLIENT_ABSENT.google).toBe('provider.not_configured')
    expect(translations.en['provider.not_configured' as keyof typeof translations.en]).toBeTruthy()
  })

  test('createGoogleClient wires invokeOnce and stream to the same one-attempt cores', async () => {
    const seen: Seen[] = []
    const client = createGoogleClient(deps({ fetch: recordingFetch(() => json(genBody()), seen) }))
    const r = await client.invokeOnce(req(), 1)
    expect(r.status).toBe('completed')
    expect(seen).toHaveLength(1)
  })

  test('the module source has no environment read and no login/token-exchange/ADC path (fragments, so this file never spells them)', () => {
    const dir = join(import.meta.dir)
    const sources = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(sources.sort()).toEqual(['client.ts', 'raw-stream.ts', 'raw.ts', 'usage.ts'])
    const needles = [
      'process' + '.env', 'Bun' + '.env', 'import.meta' + '.env',
      'GOOGLE_APPLICATION' + '_CREDENTIALS', 'GEMINI_API' + '_KEY', 'GOOGLE_API' + '_KEY', 'gcloud',
      'author' + 'ization', 'bear' + 'er', 'o' + 'auth', 'access' + '_token', 'refresh' + '_token', 'id' + '_token',
      'googleapis.com/o' + 'auth2', 'accounts.google' + '.com', 'metadata.google' + '.internal',
    ]
    for (const f of sources) {
      const src = readFileSync(join(dir, f), 'utf8').toLowerCase()
      const hits = needles.filter(n => src.includes(n.toLowerCase()))
      expect({ file: f, hits }).toEqual({ file: f, hits: [] })
    }
  })
})
