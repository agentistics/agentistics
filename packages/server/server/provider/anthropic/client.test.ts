/**
 * client.test.ts — B1.4a: `invokeOnce` / `createAnthropicClient` against a STUB `fetch`. No network
 * ever leaves this process. Spec: docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §9.
 *
 * Guards note: this is a `*.test.ts` file, so `provider-secrets.lint.test.ts`'s walk skips it
 * outright — it is allowed to read/write `process.env.ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
 * for the C-1 test (a real key is never used anywhere in this file; every "key" here is an obviously
 * fake `sk-ant-` string built for the test).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText, jsonSchema, stepCountIs } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { createCredentialHandle } from '../credential-plan.ts'
import { resetCaptureCounters } from '../capture.ts'
import {
  ANTHROPIC_BASE_URL_CONSTANT,
  anthropicCounters,
  createAnthropicClient,
  invokeOnce,
  mapMessages,
  mapTools,
  resetAnthropicCounters,
} from './client.ts'
import type { CredentialResolver } from '../client.ts'
import type { ProviderRequest } from '../client.ts'

const FAKE_KEY = 'sk-ant-FAKE00000000000000000000TESTONLY'

function fakeHandle(value = FAKE_KEY) {
  return createCredentialHandle('anthropic', value)
}

const okResolver: CredentialResolver = {
  resolve: async () => ({ ok: true, handle: fakeHandle() }),
}

function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'claude-test-model',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 64,
    correlation: { invocationId: 'inv_test1' },
    credential: { provider: 'anthropic', id: 'default' },
    ...overrides,
  }
}

function anthropicBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    model: 'claude-test-model-served',
    content: [{ type: 'text', text: 'hi there' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  }
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/** Bun's own `typeof fetch` carries a `preconnect` method a plain async function has no reason to
 *  implement (the same reason `capture.ts`'s own `createCapturingFetch` casts its wrapper) — this
 *  is the ONE cast point every stub in this file goes through. */
function stubFetch(
  impl: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>,
): typeof fetch {
  return impl as typeof fetch
}

afterEach(() => {
  resetAnthropicCounters()
  resetCaptureCounters()
})

describe('anthropic/client.ts — invokeOnce against a stub fetch (no network)', () => {
  test('C-1: an explicit key + baseURL win over an ambient env, and neither sentinel leaks', async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY
    const prevBase = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_API_KEY = 'SENTINEL_ENV_KEY_x'
    process.env.ANTHROPIC_BASE_URL = 'https://sentinel.invalid'
    try {
      let capturedUrl: string | undefined
      let capturedHeaders: Record<string, string> = {}
      const fetchImpl = stubFetch(async (input, init) => {
        capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const headers: Record<string, string> = {}
        new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
        capturedHeaders = headers
        return jsonResponse(anthropicBody(), { headers: { 'request-id': 'req_c1' } })
      })

      const result = await invokeOnce(baseRequest(), 1, { resolver: okResolver, fetchImpl })

      expect(result.status).toBe('completed')
      expect(capturedUrl).toBeDefined()
      expect(capturedUrl!.startsWith(ANTHROPIC_BASE_URL_CONSTANT)).toBe(true)
      expect(capturedHeaders['x-api-key']).toBe(FAKE_KEY)

      const serializedResult = JSON.stringify(result)
      const serializedHeaders = JSON.stringify(capturedHeaders)
      expect(capturedUrl).not.toContain('sentinel.invalid')
      expect(serializedHeaders).not.toContain('SENTINEL_ENV_KEY_x')
      expect(serializedResult).not.toContain('SENTINEL_ENV_KEY_x')
      expect(serializedResult).not.toContain('sentinel.invalid')
      expect(serializedResult).not.toContain(FAKE_KEY)
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
      if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = prevBase
    }
  })

  test('a 529 fails as overloaded, exactly one fetch call, requestId from the header, no usage key', async () => {
    let calls = 0
    const fetchImpl = stubFetch(async () => {
      calls += 1
      return jsonResponse(
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        { status: 529, headers: { 'request-id': 'req_529' } },
      )
    })

    const result = await invokeOnce(baseRequest(), 1, { resolver: okResolver, fetchImpl })

    expect(calls).toBe(1)
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('overloaded')
      expect(result.error.retryable).toBe(true)
      expect(result.requestId).toBe('req_529')
      expect('usage' in result).toBe(false)
    }
  })

  test('condition 1 + 2: a 5m+1h cache write and iterations are carried; capture ref present', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'anthropic-capture-'))
    try {
      const body = anthropicBody({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 30,
          cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
          // The AI SDK's own response schema (verified in the installed @ai-sdk/anthropic@4.0.58,
          // dist/index.js's `usage.iterations` zod shape) requires BOTH input_tokens and
          // output_tokens on every iteration — a fixture missing either fails the SDK's own
          // validation before our code ever sees the response, independent of `raw.ts`'s own
          // (more lenient) reading of the same field.
          iterations: [{ type: 'compaction', input_tokens: 5, output_tokens: 3 }],
        },
      })
      const fetchImpl = stubFetch(async () => jsonResponse(body, { headers: { 'request-id': 'req_cache' } }))

      const result = await invokeOnce(baseRequest(), 1, {
        resolver: okResolver,
        fetchImpl,
        captureDir: tmpDir,
      })

      expect(result.status).toBe('completed')
      if (result.status !== 'completed') return
      expect(result.usage.cacheWriteByTtl).toEqual({ ephemeral5m: 10, ephemeral1h: 20 })
      expect(result.usage.iterations?.length).toBe(1)
      expect(result.usage.iterationsRelation).toBe('unmeasured')
      expect(result.messageId).toBe('msg_test123')
      expect(result.servedModel).toBe('claude-test-model-served')
      expect(result.requestId).toBe('req_cache')
      expect(result.capture).toBeDefined()

      // the capture really landed under the injected dir, content-addressed.
      const shardDirs = readdirSync(tmpDir)
      expect(shardDirs.length).toBeGreaterThan(0)
      const files = readdirSync(join(tmpDir, shardDirs[0]!))
      expect(files.length).toBeGreaterThan(0)
      const written = JSON.parse(readFileSync(join(tmpDir, shardDirs[0]!, files[0]!), 'utf8'))
      expect(written.body).toContain('msg_test123')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('abort before any response: failed aborted, usageOutcome unknown, no usage key', async () => {
    const controller = new AbortController()
    const fetchImpl = stubFetch(async () => {
      controller.abort()
      const err = new Error('The operation was aborted.')
      err.name = 'AbortError'
      throw err
    })

    const result = await invokeOnce(baseRequest({ signal: controller.signal }), 1, {
      resolver: okResolver,
      fetchImpl,
    })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('aborted')
      expect(result.error.usageOutcome).toBe('unknown')
      expect(result.error.retryable).toBe(false)
      expect('usage' in result).toBe(false)
    }
  })

  test('the SDK is never constructed without an explicit key: a refused resolution never calls fetch', async () => {
    let called = false
    const fetchImpl = stubFetch(async () => {
      called = true
      return jsonResponse(anthropicBody())
    })
    const resolver: CredentialResolver = { resolve: async () => ({ ok: false, reason: 'absent' }) }

    const result = await invokeOnce(baseRequest(), 1, { resolver, fetchImpl })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('authentication')
      expect(result.error.usageOutcome).toBe('none-reported')
    }
    expect(called).toBe(false)
  })

  test('a non-integer or non-positive maxTokens is refused locally — no request built', async () => {
    let called = false
    const fetchImpl = stubFetch(async () => {
      called = true
      return jsonResponse(anthropicBody())
    })

    const result = await invokeOnce(baseRequest({ maxTokens: 0 }), 1, { resolver: okResolver, fetchImpl })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.error.kind).toBe('invalid-request')
    expect(called).toBe(false)
  })

  test('createAnthropicClient wires provider/adapterVersion/capabilities and delegates invokeOnce', async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(anthropicBody()))
    const client = createAnthropicClient({ resolver: okResolver, fetchImpl })

    expect(client.provider).toBe('anthropic')
    expect(client.capabilities.streaming).toBe(false)
    expect(client.capabilities.editPolicy.provider).toBe('anthropic')
    expect(typeof client.adapterVersion).toBe('string')

    const result = await client.invokeOnce(baseRequest(), 1)
    expect(result.status).toBe('completed')
  })

  test('an SDK usage divergence and a missing request-id are counted, never silently corrected', async () => {
    // A body whose stated usage differs from what would be read as the four counters is not
    // producible through the real SDK path without forging the raw body itself — this test instead
    // verifies the counters start at zero and a normal completed call with a request-id present
    // does NOT increment `request_id_missing`, then a response with none DOES.
    expect(anthropicCounters.request_id_missing).toBe(0)
    expect(anthropicCounters.sdk_usage_divergence).toBe(0)

    const fetchImpl = stubFetch(async () => jsonResponse(anthropicBody())) // no request-id header
    const result = await invokeOnce(baseRequest(), 1, { resolver: okResolver, fetchImpl })

    expect(result.status).toBe('completed')
    if (result.status === 'completed') expect(result.requestId).toBeUndefined()
    expect(anthropicCounters.request_id_missing).toBe(1)
  })
})

describe('mapMessages / mapTools — ProviderMessage[] -> ModelMessage[] (pure)', () => {
  test('a user/assistant/tool_result exchange splits the tool result into its own role', () => {
    const messages = mapMessages([
      { role: 'user', content: 'what is 2+2?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'add', input: { a: 2, b: 2 } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: '4' }],
      },
    ])

    expect(messages[0]).toEqual({ role: 'user', content: 'what is 2+2?' })
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'add', input: { a: 2, b: 2 } }],
    })
    expect(messages[2]).toEqual({
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'call_1', toolName: 'add', output: { type: 'text', value: '4' } },
      ],
    })
  })

  test('an isError tool_result maps to an error-text output', () => {
    const messages = mapMessages([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'fail', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'boom', isError: true }] },
    ])
    expect(messages[1]).toEqual({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'fail', output: { type: 'error-text', value: 'boom' } }],
    })
  })

  test('mapTools returns declarations without execute', () => {
    const tools = mapTools([{ name: 'echo', description: 'echoes', inputSchema: { type: 'object' } }])
    expect(tools).toBeDefined()
    expect(tools!.echo).toBeDefined()
    expect((tools!.echo as { execute?: unknown }).execute).toBeUndefined()
    expect(mapTools(undefined)).toBeUndefined()
    expect(mapTools([])).toBeUndefined()
  })
})

describe('condition 3 (R13 §3) — the SDK aggregate carries no raw usage across steps', () => {
  test('a two-step MockLanguageModelV4 generateText call: result.usage.raw is undefined', async () => {
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doGenerate: [
        {
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'echo', input: '{"x":1}' }],
          warnings: [],
        },
        {
          finishReason: { unified: 'stop', raw: 'end_turn' },
          usage: {
            inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 8, text: 8, reasoning: 0 },
          },
          content: [{ type: 'text', text: 'done' }],
          warnings: [],
        },
      ],
    })

    const result = await generateText({
      model,
      prompt: 'hi',
      tools: {
        echo: {
          description: 'echo',
          inputSchema: jsonSchema({ type: 'object', properties: { x: { type: 'number' } } }),
          execute: async () => 'ok',
        },
      },
      stopWhen: stepCountIs(2),
    })

    expect(result.steps.length).toBe(2)
    // R13 §3's finding, pinned against the installed ai@7.0.107: the aggregate `usage` (a sum of
    // per-step usages) carries no `raw` — only a SINGLE step's own usage can (spec §4.1 condition 3),
    // which is exactly why B1 reads usage from the raw HTTP capture and never from this aggregate.
    expect(result.usage.raw).toBeUndefined()
  })
})

describe('capture failures never fail the call (spec §7)', () => {
  test('a writeCapture that throws leaves the result completed, with no captureRef', async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(anthropicBody()))
    const throwingWriteCapture = async (): Promise<never> => {
      throw new Error('disk full')
    }

    const result = await invokeOnce(baseRequest(), 1, {
      resolver: okResolver,
      fetchImpl,
      writeCapture: throwingWriteCapture,
    })

    expect(result.status).toBe('completed')
    expect(result.capture).toBeUndefined()
  })
})

// A stated limitation, not a gap: with `stopWhen: stepCountIs(1)` and every declared tool lacking
// `execute` (spec §4.6, B3 owns execution), the AI SDK has nothing to feed back into a second step
// regardless of what `stopWhen` says — so `invokeOnce`'s own `result.steps.length !== 1` defense
// (spec §9a condition 3's second half) is not independently reachable through a real Anthropic call
// shape in this test file. It is exercised structurally above (the two-step MockLanguageModel test)
// at the SDK level the check exists to distrust, and is otherwise dead-code defense — kept because a
// future SDK version changing that behavior must fail loudly here rather than silently trusting a
// multi-step response as if it were one attempt.
