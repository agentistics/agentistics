/**
 * client.test.ts — B5a.1: `invokeOpenAICompatibleOnce` / `createOpenAICompatibleClient` against a
 * STUB `fetch`. No network ever leaves this process.
 *
 * A `*.test.ts`, so `provider-secrets.lint.test.ts` does not walk it: the C-1 test below may SET the
 * environment variables the OpenAI SDK family falls back to, precisely to prove this client never
 * reads them. Every "key" here is an obviously fake string built for the test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { translations } from '@agentistics/core'
import {
  buildChatBody,
  chatCompletionsUrl,
  createOpenAICompatibleClient,
  invokeOpenAICompatibleOnce,
  mapChatMessages,
  type OpenAICompatibleClientDeps,
} from './client.ts'
import { createProviderClients } from '../registry.ts'
import { PROVIDER_CLIENT_ABSENT } from '../client.ts'
import type { CredentialHandle, CredentialResolver } from '../credential.ts'
import type { ProviderRequest } from '../client.ts'

const FAKE_KEY = 'sk-or-FAKE000000000000000000TESTONLY'
const BASE = 'https://explicit.example/api/v1'

function fakeHandle(value = FAKE_KEY): CredentialHandle {
  const label = '[credential openai-compatible/openrouter sha256:00000000]'
  return { provider: 'openai-compatible', fingerprint: 'sha256:00000000', reveal: () => value, toString: () => label, toJSON: () => label } as CredentialHandle
}

let CAPTURE_DIR = ''
beforeAll(() => { CAPTURE_DIR = mkdtempSync(join(tmpdir(), 'agentistics-oai-client-')) })
afterAll(() => { rmSync(CAPTURE_DIR, { recursive: true, force: true }) })

const okResolver: CredentialResolver = { resolve: async () => ({ ok: true, handle: fakeHandle() }) }

function deps(over: Partial<OpenAICompatibleClientDeps> = {}): OpenAICompatibleClientDeps {
  return {
    resolver: okResolver,
    captureDir: CAPTURE_DIR,
    endpoint: { id: 'openrouter', baseUrl: BASE, kind: 'router' },
    ...over,
  }
}

function req(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'openai/gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 16,
    correlation: { invocationId: 'inv_oai1' },
    credential: { provider: 'openai-compatible', id: 'openrouter' },
    ...over,
  }
}

function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gen-abc',
    model: 'openai/gpt-test-served',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10, cost: 0.0001 },
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

describe('openai-compatible/client.ts — invokeOnce against a stub fetch (no network)', () => {
  test('C-1: the explicit key + base URL win over an ambient env, and no sentinel leaks anywhere', async () => {
    const names = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY'] as const
    const prev = names.map(n => process.env[n])
    process.env.OPENAI_API_KEY = 'SENTINEL_ENV_KEY_openai'
    process.env.OPENAI_BASE_URL = 'https://sentinel-openai.invalid/v1'
    process.env.OPENROUTER_API_KEY = 'SENTINEL_ENV_KEY_openrouter'
    const writes: string[] = []
    try {
      const seen: Seen[] = []
      const result = await invokeOpenAICompatibleOnce(req(), 1, deps({
        fetch: recordingFetch(() => json(chatBody(), { headers: { 'x-request-id': 'req_c1' } }), seen),
        writeCapture: async (ex) => { writes.push(JSON.stringify(ex)); return { sha256: 'f'.repeat(64), bytes: 1 } },
      }))
      expect(result.status).toBe('completed')
      expect(seen).toHaveLength(1)
      expect(seen[0]!.url).toBe(`${BASE}/chat/completions`)
      expect(seen[0]!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)

      const everything = JSON.stringify({ seen, result, writes })
      for (const sentinel of ['SENTINEL_ENV_KEY_openai', 'sentinel-openai.invalid', 'SENTINEL_ENV_KEY_openrouter']) {
        expect(everything).not.toContain(sentinel)
      }
      // The key went out on the request and nowhere else: not in the result, not in the capture.
      expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
      expect(writes.join('')).not.toContain(FAKE_KEY)

      // And a failure path leaks none of them either.
      const failed = await invokeOpenAICompatibleOnce(req(), 1, deps({
        fetch: recordingFetch(() => json({ error: { message: 'bad key SENTINEL', type: 'x' } }, { status: 401 }), []),
      }))
      expect(failed.status).toBe('failed')
      const failedText = JSON.stringify(failed)
      for (const s of ['SENTINEL', FAKE_KEY, 'sentinel-openai.invalid']) expect(failedText).not.toContain(s)
    } finally {
      names.forEach((n, i) => { if (prev[i] === undefined) delete process.env[n]; else process.env[n] = prev[i] })
    }
  })

  test('ONE non-streaming POST with the mapped body; the result is read from the raw body', async () => {
    const seen: Seen[] = []
    const result = await invokeOpenAICompatibleOnce(req({ system: 'be brief' }), 2, deps({
      fetch: recordingFetch(() => json(chatBody(), { headers: { 'x-request-id': 'req_1', 'openai-organization': 'org-HIDDEN' } }), seen),
    }))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.body).toEqual({
      model: 'openai/gpt-test',
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }],
      max_tokens: 16,
      stream: false,
    })
    if (result.status !== 'completed') throw new Error('expected completed')
    expect(result.provider).toBe('openai-compatible')
    expect(result.attempt).toBe(2)
    expect(result.messageId).toBe('gen-abc')
    expect(result.servedModel).toBe('openai/gpt-test-served')
    expect(result.requestId).toBe('req_1')
    expect(result.stopReason).toEqual({ kind: 'end-turn' })
    expect(result.usageCertainty).toBe('router-stated')
    expect(result.cost?.kind).toBe('router-reported')
    expect(Array.isArray(result.usageNotes)).toBe(true)
    expect(result.capture).toBeDefined()
    expect(JSON.stringify(result)).not.toContain('org-HIDDEN')
  })

  test('the capture carries only allowlisted response headers — never an account id, cookie or cf-*', async () => {
    let captured: { headers: Record<string, string> } | undefined
    await invokeOpenAICompatibleOnce(req(), 1, deps({
      fetch: recordingFetch(() => json(chatBody(), {
        headers: {
          'x-request-id': 'req_h',
          'x-ratelimit-remaining-requests': '9',
          'openai-organization': 'org-HIDDEN',
          'openai-project': 'proj-HIDDEN',
          'set-cookie': 'sess=HIDDEN',
          'cf-ray': 'HIDDEN-ray',
          'x-openrouter-trace': 'HIDDEN',
        },
      }), []),
      writeCapture: async (ex) => { captured = ex; return undefined },
    }))
    expect(captured).toBeDefined()
    expect(Object.keys(captured!.headers).sort()).toEqual(['content-type', 'x-ratelimit-remaining-requests', 'x-request-id'])
    expect(JSON.stringify(captured!.headers)).not.toContain('HIDDEN')
  })

  test('no bearer is sent when a LOCAL endpoint has no key; a direct endpoint with no key is refused unsent', async () => {
    const absent: CredentialResolver = { resolve: async () => ({ ok: false, reason: 'absent' }) }
    const seen: Seen[] = []
    const local = await invokeOpenAICompatibleOnce(req({ credential: { provider: 'openai-compatible', id: 'ollama' } }), 1, deps({
      resolver: absent,
      endpoint: { id: 'ollama', baseUrl: 'http://localhost:11434/v1', kind: 'local' },
      fetch: recordingFetch(() => json(chatBody({ id: 'chatcmpl-local', usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })), seen),
    }))
    expect(local.status).toBe('completed')
    expect(seen[0]!.url).toBe('http://localhost:11434/v1/chat/completions')
    expect('authorization' in seen[0]!.headers).toBe(false)

    const directSeen: Seen[] = []
    const direct = await invokeOpenAICompatibleOnce(req({ credential: { provider: 'openai-compatible', id: 'openai' } }), 1, deps({
      resolver: absent,
      endpoint: { id: 'openai', baseUrl: 'https://api.openai.com/v1', kind: 'direct' },
      fetch: recordingFetch(() => json(chatBody()), directSeen),
    }))
    expect(direct.status).toBe('failed')
    if (direct.status === 'failed') expect(direct.error.userCode).toBe('provider.no_credential')
    expect(directSeen).toHaveLength(0)
  })

  test('a broken key file never downgrades to a keyless call, even locally', async () => {
    const seen: Seen[] = []
    const r = await invokeOpenAICompatibleOnce(req({ credential: { provider: 'openai-compatible', id: 'ollama' } }), 1, deps({
      resolver: { resolve: async () => ({ ok: false, reason: 'permissions-too-open' }) },
      endpoint: { id: 'ollama', baseUrl: 'http://localhost:11434/v1', kind: 'local' },
      fetch: recordingFetch(() => json(chatBody()), seen),
    }))
    expect(r.status).toBe('failed')
    expect(seen).toHaveLength(0)
  })

  test('a credential ref for ANOTHER endpoint is refused before the resolver is asked — no key crosses hosts', async () => {
    let asked = 0
    const seen: Seen[] = []
    const resolver: CredentialResolver = { resolve: async () => { asked++; return { ok: true, handle: fakeHandle() } } }
    for (const credential of [
      { provider: 'openai-compatible' as const, id: 'openai' },
      { provider: 'anthropic' as const, id: 'openrouter' },
      { provider: 'openai' as const, id: 'openrouter' },
    ]) {
      const r = await invokeOpenAICompatibleOnce(req({ credential }), 1, deps({ resolver, fetch: recordingFetch(() => json(chatBody()), seen) }))
      expect(r.status).toBe('failed')
    }
    expect(asked).toBe(0)
    expect(seen).toHaveLength(0)
  })

  test('errors: 429 rate-limited with retry-after, 401 authentication, 402 billing — no usage key on a failure', async () => {
    const run = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      invokeOpenAICompatibleOnce(req(), 1, deps({ fetch: recordingFetch(() => json(body, { status, headers }), []) }))

    const limited = await run(429, { error: { message: 'slow down', type: 'tokens', code: 'rate_limit_exceeded' } }, { 'retry-after': '2', 'x-request-id': 'req_rl' })
    if (limited.status !== 'failed') throw new Error('expected failed')
    expect(limited.error.kind).toBe('rate-limited')
    expect(limited.error.retryable).toBe(true)
    expect(limited.error.retryAfterMs).toBe(2000)
    expect(limited.requestId).toBe('req_rl')
    expect('usage' in limited).toBe(false)

    const auth = await run(401, { error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } })
    if (auth.status !== 'failed') throw new Error('expected failed')
    expect(auth.error.kind).toBe('authentication')

    const quota = await run(429, { error: { message: 'quota', type: 'insufficient_quota', code: 'insufficient_quota' } })
    if (quota.status !== 'failed') throw new Error('expected failed')
    expect(quota.error.retryable).toBe(false)

    const billing = await run(402, { error: { code: 402, message: 'Insufficient credits' } })
    if (billing.status !== 'failed') throw new Error('expected failed')
    expect(billing.error.kind).toBe('billing')
  })

  test('a network failure and an abort are failed values, never throws', async () => {
    const net = await invokeOpenAICompatibleOnce(req(), 1, deps({ fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch }))
    if (net.status !== 'failed') throw new Error('expected failed')
    expect(net.error.kind).toBe('network')
    expect(net.error.usageOutcome).toBe('unknown')

    const controller = new AbortController()
    controller.abort()
    const aborted = await invokeOpenAICompatibleOnce(req({ signal: controller.signal }), 1, deps({
      fetch: (async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }) as unknown as typeof fetch,
    }))
    if (aborted.status !== 'failed') throw new Error('expected failed')
    expect(aborted.error.kind).toBe('aborted')
  })

  test('a non-integer maxTokens is refused locally — nothing is sent', async () => {
    const seen: Seen[] = []
    const r = await invokeOpenAICompatibleOnce(req({ maxTokens: 0 }), 1, deps({ fetch: recordingFetch(() => json(chatBody()), seen) }))
    expect(r.status).toBe('failed')
    expect(seen).toHaveLength(0)
  })

  test('a writeCapture that throws leaves the call completed, with no capture ref', async () => {
    const r = await invokeOpenAICompatibleOnce(req(), 1, deps({
      fetch: recordingFetch(() => json(chatBody()), []),
      writeCapture: async () => { throw new Error('disk full') },
    }))
    expect(r.status).toBe('completed')
    expect(r.capture).toBeUndefined()
  })
})

describe('mapChatMessages / buildChatBody — the wire translation (pure)', () => {
  test('tool_use -> assistant tool_calls; tool_result -> role:tool before any user text; tools declared', () => {
    const body = buildChatBody(req({
      messages: [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: [
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', toolUseId: 'call_1', content: 'file body', isError: true },
          { type: 'text', text: 'and?' },
        ] },
      ],
      tools: [{ name: 'read', description: 'read a file', inputSchema: { type: 'object' } }],
    }))
    expect(body.messages).toEqual([
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: 'on it', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      { role: 'user', content: 'and?' },
    ])
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } }])
  })

  test('several text parts are sent as parts, never joined; an assistant with only calls has null content', () => {
    expect(mapChatMessages({ messages: [
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'n', input: {} }] },
    ] })).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } }] },
    ])
  })

  test('the URL is <baseUrl>/chat/completions with no doubled slash', () => {
    expect(chatCompletionsUrl('https://x.test/v1/')).toBe('https://x.test/v1/chat/completions')
    expect(chatCompletionsUrl('https://x.test/v1')).toBe('https://x.test/v1/chat/completions')
  })
})

describe('registry and client wiring', () => {
  test('the openai-compatible slot is a client only when the host configured one', () => {
    const anthropic = { resolver: okResolver, captureDir: CAPTURE_DIR }
    expect(createProviderClients({ anthropic })['openai-compatible']).toBeNull()
    const withOne = createProviderClients({ anthropic, openaiCompatible: deps() })['openai-compatible']
    expect(withOne?.provider).toBe('openai-compatible')
    expect(PROVIDER_CLIENT_ABSENT['openai-compatible']).toBe('provider.not_configured')
    for (const lang of ['en', 'pt'] as const) expect(translations[lang]['provider.not_configured']).toBeDefined()
  })

  test('createOpenAICompatibleClient states provider, adapter version, and no streaming', () => {
    const c = createOpenAICompatibleClient(deps())
    expect(c.provider).toBe('openai-compatible')
    expect(c.adapterVersion).toBe('1')
    expect(c.capabilities.streaming).toBe(false)
    expect(c.capabilities.editPolicy.provider).toBe('openai-compatible')
  })
})
