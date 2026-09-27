/**
 * models.test.ts — `parseModelList` (pure, table + adversarial) and `createModelLister` (injected
 * fetch, injected clock, cache). No network call — every `fetch` here is a stub.
 */
import { describe, test, expect } from 'bun:test'
import type { CredentialHandle } from '../credential.ts'
import { createModelLister, parseModelList, type ListedModel } from './models.ts'

// Shaped like a real key so the sentinel test is meaningful — never a literal that greps as a
// genuine secret in this file's own history.
const KEY_SENTINEL = 'sk-' + 'sentinel-' + 'q'.repeat(40)

/** A handle over the sentinel that counts how often the key is revealed. */
function countingHandle(value: string): { handle: CredentialHandle; reveals: () => number } {
  let n = 0
  const handle: CredentialHandle = {
    provider: 'openai-compatible',
    fingerprint: 'sha256:00000000',
    reveal: () => { n++; return value },
  }
  return { handle, reveals: () => n }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })) as unknown as typeof fetch
}

function textResponse(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
}

function throwingFetch(err: unknown): typeof fetch {
  return (async () => { throw err }) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// parseModelList — documented shapes
// ---------------------------------------------------------------------------

describe('parseModelList — documented provider shapes', () => {
  test('OpenAI GET /v1/models', () => {
    // https://platform.openai.com/docs/api-reference/models/list (2026-09-27)
    const body = {
      object: 'list',
      data: [
        { id: 'gpt-5.1', object: 'model', created: 1700000000, owned_by: 'openai' },
        { id: 'gpt-5.1-mini', object: 'model', created: 1700000001, owned_by: 'openai' },
      ],
    }
    const result = parseModelList(body)
    expect(result).not.toBeNull()
    expect(result!.dropped).toBe(0)
    expect(result!.models).toEqual([
      { id: 'gpt-5.1', ownedBy: 'openai', created: 1700000000 },
      { id: 'gpt-5.1-mini', ownedBy: 'openai', created: 1700000001 },
    ])
  })

  test('OpenRouter GET /api/v1/models', () => {
    // https://openrouter.ai/docs/overview/models (fetched 2026-09-27)
    const body = {
      data: [
        {
          id: 'anthropic/claude-sonnet-5',
          canonical_slug: 'anthropic/claude-sonnet-5',
          name: 'Claude Sonnet 5',
          created: 1700000010,
          context_length: 200000,
          pricing: { prompt: '0.000003', completion: '0.000015' },
          top_provider: { context_length: 200000, max_completion_tokens: 8192, is_moderated: true },
        },
      ],
      total_count: 1,
      links: { next: null },
    }
    const result = parseModelList(body)
    expect(result).not.toBeNull()
    expect(result!.dropped).toBe(0)
    expect(result!.models).toEqual([
      { id: 'anthropic/claude-sonnet-5', contextLength: 200000, created: 1700000010 },
    ])
  })

  test('Ollama /v1/models — the OpenAI shape, verified against openai/openai.go', () => {
    // github.com/ollama/ollama, openai/openai.go (main, fetched 2026-09-27):
    // type Model struct { Id string; Object string; Created int64; OwnedBy string }
    // type ListCompletion struct { Object string; Data []Model }
    const body = {
      object: 'list',
      data: [{ id: 'llama3.2', object: 'model', created: 1700000020, owned_by: 'library' }],
    }
    const result = parseModelList(body)
    expect(result).not.toBeNull()
    expect(result!.models).toEqual([{ id: 'llama3.2', ownedBy: 'library', created: 1700000020 }])
  })
})

// ---------------------------------------------------------------------------
// parseModelList — adversarial
// ---------------------------------------------------------------------------

describe('parseModelList — adversarial input', () => {
  test('null body → null', () => {
    expect(parseModelList(null)).toBeNull()
  })

  test('undefined body → null', () => {
    expect(parseModelList(undefined)).toBeNull()
  })

  test('a scalar body → null', () => {
    expect(parseModelList('just a string')).toBeNull()
    expect(parseModelList(42)).toBeNull()
  })

  test('an object with no data field → null', () => {
    expect(parseModelList({ object: 'list' })).toBeNull()
  })

  test('data is not an array (an object) → null', () => {
    expect(parseModelList({ data: { id: 'x' } })).toBeNull()
  })

  test('a bare array at the top level → null (no documented provider returns one)', () => {
    expect(parseModelList([{ id: 'x' }])).toBeNull()
  })

  test('an id that is a number is dropped and counted', () => {
    const result = parseModelList({ data: [{ id: 42 }, { id: 'ok' }] })
    expect(result).not.toBeNull()
    expect(result!.dropped).toBe(1)
    expect(result!.models).toEqual([{ id: 'ok' }])
  })

  test('an empty-string id is dropped and counted', () => {
    const result = parseModelList({ data: [{ id: '' }, { id: 'ok' }] })
    expect(result!.dropped).toBe(1)
    expect(result!.models).toEqual([{ id: 'ok' }])
  })

  test('a missing id is dropped and counted', () => {
    const result = parseModelList({ data: [{ owned_by: 'x' }, { id: 'ok' }] })
    expect(result!.dropped).toBe(1)
    expect(result!.models).toEqual([{ id: 'ok' }])
  })

  test('a non-object entry (a string, a number, null) is dropped and counted', () => {
    const result = parseModelList({ data: ['nope', 7, null, { id: 'ok' }] })
    expect(result!.dropped).toBe(3)
    expect(result!.models).toEqual([{ id: 'ok' }])
  })

  test('duplicate ids are de-duplicated, first occurrence wins, and it is NOT counted in dropped', () => {
    const result = parseModelList({
      data: [
        { id: 'dup', owned_by: 'first', context_length: 1000 },
        { id: 'dup', owned_by: 'second', context_length: 9999 },
      ],
    })
    expect(result!.dropped).toBe(0)
    expect(result!.models).toEqual([{ id: 'dup', ownedBy: 'first', contextLength: 1000 }])
  })

  test('context_length of 0, negative, NaN, or a string is never accepted', () => {
    const result = parseModelList({
      data: [
        { id: 'a', context_length: 0 },
        { id: 'b', context_length: -5 },
        { id: 'c', context_length: Number.NaN },
        { id: 'd', context_length: '200000' },
        { id: 'e', context_length: 200000 },
      ],
    })
    expect(result!.models).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e', contextLength: 200000 },
    ])
  })

  test('owned_by is accepted only as a non-empty string', () => {
    const result = parseModelList({
      data: [
        { id: 'a', owned_by: '' },
        { id: 'b', owned_by: 123 },
        { id: 'c', owned_by: 'openai' },
      ],
    })
    expect(result!.models).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c', ownedBy: 'openai' }])
  })

  test('created is accepted only as a finite number', () => {
    const result = parseModelList({
      data: [
        { id: 'a', created: '1700000000' },
        { id: 'b', created: Number.POSITIVE_INFINITY },
        { id: 'c', created: 1700000000 },
      ],
    })
    expect(result!.models).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c', created: 1700000000 }])
  })

  test('models are sorted by id regardless of source order', () => {
    const result = parseModelList({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'mid' }] })
    expect(result!.models.map(m => m.id)).toEqual(['alpha', 'mid', 'zeta'])
  })

  test('an HTML error body parses as JSON.parse failure upstream, but parseModelList itself only ever sees a value — a plain string body is still bad-shape', () => {
    expect(parseModelList('<html>not json</html>')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// createModelLister — the network/parsing layer, injected fetch
// ---------------------------------------------------------------------------

describe('createModelLister', () => {
  test('a successful call returns ok:true, fromCache:false, and the parsed models', async () => {
    const lister = createModelLister({ fetch: jsonResponse(200, { data: [{ id: 'm1' }] }) })
    const result = await lister.list({ endpointId: 'openai', baseUrl: 'https://api.openai.com/v1', credential: null })
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'm1' }],
      fetchedAt: expect.any(String) as unknown as string,
      fromCache: false,
      dropped: 0,
    })
  })

  test('GET <baseUrl>/models with Accept: application/json, no Authorization header when the credential is null', async () => {
    let seenUrl: unknown
    let seenInit: RequestInit | undefined
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seenUrl = url
      seenInit = init
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const lister = createModelLister({ fetch: fetchImpl })
    await lister.list({ endpointId: 'ollama', baseUrl: 'http://localhost:11434/v1', credential: null })

    expect(seenUrl).toBe('http://localhost:11434/v1/models')
    const headers = seenInit?.headers as Record<string, string>
    expect(headers['Accept']).toBe('application/json')
    expect(headers['Authorization']).toBeUndefined()
  })

  test('a Bearer header is added only when a key is present', async () => {
    let seenInit: RequestInit | undefined
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seenInit = init
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const lister = createModelLister({ fetch: fetchImpl })
    await lister.list({ endpointId: 'openai', baseUrl: 'https://api.openai.com/v1', credential: countingHandle(KEY_SENTINEL).handle })

    const headers = seenInit?.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${KEY_SENTINEL}`)
  })

  test('the key is revealed once per SENT request and never on a cache hit', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 })) as unknown as typeof fetch
    let t = 0
    const lister = createModelLister({ fetch: fetchImpl, now: () => t, ttlMs: 1000 })
    const { handle, reveals } = countingHandle(KEY_SENTINEL)
    const args = { endpointId: 'openai', baseUrl: 'https://api.openai.com/v1', credential: handle }
    await lister.list(args)
    expect(reveals()).toBe(1)
    t = 500
    const hit = await lister.list(args)
    expect(hit.ok && hit.fromCache).toBe(true)
    expect(reveals()).toBe(1)
    t = 2000
    await lister.list(args)
    expect(reveals()).toBe(2)
  })

  test('401 → unauthorized, with status, and the body is never echoed', async () => {
    const lister = createModelLister({ fetch: jsonResponse(401, { error: 'nope, and here is a secret: ' + KEY_SENTINEL }) })
    const result = await lister.list({ endpointId: 'openai', baseUrl: 'https://api.openai.com/v1', credential: countingHandle(KEY_SENTINEL).handle })
    expect(result).toEqual({ ok: false, reason: 'unauthorized', status: 401 })
  })

  test('403 → unauthorized, with status', async () => {
    const lister = createModelLister({ fetch: jsonResponse(403, { error: 'forbidden' }) })
    const result = await lister.list({ endpointId: 'openai', baseUrl: 'https://api.openai.com/v1', credential: null })
    expect(result).toEqual({ ok: false, reason: 'unauthorized', status: 403 })
  })

  test('a 500 → http-error, with status', async () => {
    const lister = createModelLister({ fetch: jsonResponse(500, { error: 'boom' }) })
    const result = await lister.list({ endpointId: 'openai', baseUrl: 'https://api.openai.com/v1', credential: null })
    expect(result).toEqual({ ok: false, reason: 'http-error', status: 500 })
  })

  test('an HTML body (a captive portal, a proxy error page) → not-json', async () => {
    const lister = createModelLister({ fetch: textResponse(200, '<html><body>not json</body></html>') })
    const result = await lister.list({ endpointId: 'litellm', baseUrl: 'http://localhost:4000/v1', credential: null })
    expect(result).toEqual({ ok: false, reason: 'not-json' })
  })

  test('a well-formed JSON body with the wrong shape → bad-shape', async () => {
    const lister = createModelLister({ fetch: jsonResponse(200, { models: ['not', 'the', 'right', 'key'] }) })
    const result = await lister.list({ endpointId: '9router', baseUrl: 'http://localhost:20128/v1', credential: null })
    expect(result).toEqual({ ok: false, reason: 'bad-shape' })
  })

  test('fetch throwing (DNS failure, connection refused, an abort) → network, never throws out', async () => {
    const lister = createModelLister({ fetch: throwingFetch(new TypeError('fetch failed')) })
    const result = await lister.list({ endpointId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', credential: null })
    expect(result).toEqual({ ok: false, reason: 'network' })
  })

  test('fetch throwing a DOMException AbortError (a timeout) → network', async () => {
    const lister = createModelLister({ fetch: throwingFetch(new DOMException('The operation was aborted.', 'AbortError')) })
    const result = await lister.list({ endpointId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', credential: null })
    expect(result).toEqual({ ok: false, reason: 'network' })
  })

  // -------------------------------------------------------------------------
  // cache — injected clock
  // -------------------------------------------------------------------------

  test('a hit within the TTL is served from cache (fromCache:true) without calling fetch again', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
    }) as unknown as typeof fetch

    let clock = 1_000_000
    const lister = createModelLister({ fetch: fetchImpl, now: () => clock, ttlMs: 60_000 })
    const args = { endpointId: 'openai', baseUrl: 'https://api.openai.com/v1', credential: null }

    const first = await lister.list(args)
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.fromCache).toBe(false)
    expect(calls).toBe(1)

    clock += 30_000 // well within the 60s TTL
    const second = await lister.list(args)
    expect(calls).toBe(1) // no second fetch
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.fromCache).toBe(true)
      expect(second.models).toEqual([{ id: 'm1' }])
      expect(second.fetchedAt).toBe((first as { fetchedAt: string }).fetchedAt) // the ORIGINAL fetch time
    }
  })

  test('a miss after the TTL calls fetch again', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
    }) as unknown as typeof fetch

    let clock = 1_000_000
    const lister = createModelLister({ fetch: fetchImpl, now: () => clock, ttlMs: 60_000 })
    const args = { endpointId: 'openai', baseUrl: 'https://api.openai.com/v1', credential: null }

    await lister.list(args)
    expect(calls).toBe(1)

    clock += 60_001 // just past the TTL
    const second = await lister.list(args)
    expect(calls).toBe(2)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.fromCache).toBe(false)
  })

  test('a failure is never cached — the very next call tries fetch again', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return calls === 1
        ? new Response('{"error":"boom"}', { status: 500 })
        : new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const lister = createModelLister({ fetch: fetchImpl, now: () => 1_000_000 })
    const args = { endpointId: 'openai', baseUrl: 'https://api.openai.com/v1', credential: null }

    const first = await lister.list(args)
    expect(first).toEqual({ ok: false, reason: 'http-error', status: 500 })
    expect(calls).toBe(1)

    const second = await lister.list(args)
    expect(calls).toBe(2) // retried, not served a cached failure
    expect(second.ok).toBe(true)
  })

  test('the cache key is per endpointId+baseUrl — two endpoints never share a cached answer', async () => {
    let calls = 0
    const fetchImpl = (async (url: unknown) => {
      calls += 1
      const id = String(url).includes('openai') ? 'openai-model' : 'other-model'
      return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 })
    }) as unknown as typeof fetch

    const lister = createModelLister({ fetch: fetchImpl, now: () => 1_000_000 })
    const a = await lister.list({ endpointId: 'openai', baseUrl: 'https://api.openai.com/v1', credential: null })
    const b = await lister.list({ endpointId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', credential: null })

    expect(calls).toBe(2)
    if (a.ok) expect(a.models[0]!.id).toBe('openai-model')
    if (b.ok) expect(b.models[0]!.id).toBe('other-model')
  })

  // -------------------------------------------------------------------------
  // key sentinel — the key is never in a result
  // -------------------------------------------------------------------------

  test('the key never appears in any ModelListResult, success or failure', async () => {
    async function resultFor(fetchImpl: typeof fetch): Promise<ModelListResultLike> {
      const lister = createModelLister({ fetch: fetchImpl })
      return (await lister.list({
        endpointId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        credential: countingHandle(KEY_SENTINEL).handle,
      })) as unknown as ModelListResultLike
    }

    const outcomes: ModelListResultLike[] = await Promise.all([
      resultFor(jsonResponse(200, { data: [{ id: `model-${KEY_SENTINEL}` }] })),
      resultFor(jsonResponse(401, { error: KEY_SENTINEL })),
      resultFor(jsonResponse(500, { error: KEY_SENTINEL })),
      resultFor(textResponse(200, KEY_SENTINEL)),
      resultFor(jsonResponse(200, { wrong: KEY_SENTINEL })),
      resultFor(throwingFetch(new Error(KEY_SENTINEL))),
    ])

    for (const outcome of outcomes) {
      const serialized = JSON.stringify(outcome)
      // The FIRST case deliberately puts the key inside a MODEL id — that is data the endpoint
      // itself returned (never something this reader may launder away), so it is excluded from
      // the sentinel check; every other branch must never carry the key at all.
      if (outcome.ok && outcome.models.some((m: ListedModel) => m.id.includes(KEY_SENTINEL))) continue
      expect(serialized.includes(KEY_SENTINEL)).toBe(false)
    }
  })
})

type ModelListResultLike =
  | { ok: true; models: ListedModel[]; fetchedAt: string; fromCache: boolean; dropped: number }
  | { ok: false; reason: string; status?: number }
