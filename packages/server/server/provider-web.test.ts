import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetProviderWebCaches,
  handleProviderRequest,
  matchProviderRoute,
  parsePutBody,
  PROVIDER_BODY_BYTES,
  type ProviderWebDeps,
} from './provider-web'
import { buildAuditEvent, type AuditInput } from './audit'
import { KEYED_PROVIDERS } from './config'

/** Distinctive fakes: long enough that every 8-character window is a meaningful probe. */
const ANTHROPIC_KEY = 'sk-ant-api03-FAKEk3yZXQWVUTSRQPONMLKJIHGFEDCBA9876xyz'
const ROUTER_KEY = 'sk-or-v1-QQQQzzzz1111PPPPyyyy2222ttttMMMMrouterfake'

/** Every 8-character substring of `key` — none may appear in anything a route answers. */
function windows(key: string): string[] {
  const out: string[] = []
  for (let i = 0; i + 8 <= key.length; i++) out.push(key.slice(i, i + 8))
  return out
}
function leaks(value: unknown, key: string): string[] {
  const text = JSON.stringify(value)
  return windows(key).filter(w => text.includes(w))
}

type FetchCall = { url: string; headers: Record<string, string> }

let dir: string
let audits: AuditInput[]
let calls: FetchCall[]
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
/** One stable fetch per test — the models cache is keyed by the fetch it was built over. */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } })
  return fetchImpl(url, init)
}) as typeof fetch

function deps(over: Partial<ProviderWebDeps> = {}): Partial<ProviderWebDeps> {
  return {
    isCentral: async () => false,
    flagOn: () => true,
    dir,
    fetch: fakeFetch,
    audit: (a) => { audits.push(a) },
    now: () => Date.now(),
    ...over,
  }
}

function req(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  return new Request(`http://localhost${path}`, init)
}

async function call(method: string, path: string, body?: unknown, over: Partial<ProviderWebDeps> = {}) {
  const out = await handleProviderRequest(req(method, path, body), path, '127.0.0.1', deps(over))
  if (out === null) throw new Error('not a provider route')
  return out as { status: number; body: any }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'provider-web-'))
  audits = []
  calls = []
  fetchImpl = async () => Response.json({ data: [{ id: 'model-a', owned_by: 'x', created: 1 }, { id: 'model-b', context_length: 1000 }] })
  _resetProviderWebCaches()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('matchProviderRoute / parsePutBody (pure)', () => {
  test('sub-resources are matched explicitly, never read as an id', () => {
    expect(matchProviderRoute('/api/provider')).toEqual({ kind: 'list' })
    expect(matchProviderRoute('/api/provider/openai')).toEqual({ kind: 'one', id: 'openai' })
    expect(matchProviderRoute('/api/provider/openai/test')).toEqual({ kind: 'test', id: 'openai' })
    expect(matchProviderRoute('/api/provider/openai/models')).toEqual({ kind: 'models', id: 'openai' })
    expect(matchProviderRoute('/api/provider/openai/other')).toBeNull()
    expect(matchProviderRoute('/api/providers')).toBeNull()
  })
  test('wrong field types are refused, not coerced', () => {
    expect(parsePutBody({ key: 5 })).toBeNull()
    expect(parsePutBody({ baseUrl: [] })).toBeNull()
    expect(parsePutBody({ noKey: 'yes' })).toBeNull()
    expect(parsePutBody([])).toBeNull()
    expect(parsePutBody({ key: 'k', baseUrl: 'u', noKey: false })).toEqual({ key: 'k', baseUrl: 'u', noKey: false })
  })
})

describe('GET /api/provider', () => {
  test('lists every keyed provider in order, all absent on a fresh machine', async () => {
    const r = await call('GET', '/api/provider')
    expect(r.status).toBe(200)
    expect(r.body.enabled).toBe(true)
    expect(r.body.providers.map((p: any) => p.id)).toEqual([...KEYED_PROVIDERS])
    for (const p of r.body.providers) expect(p.state).toBe('absent')
    const anthropic = r.body.providers[0]
    expect(anthropic).toEqual({
      id: 'anthropic', label: 'Anthropic', kind: 'direct', defaultBaseUrl: null,
      baseUrlEditable: false, keyOptional: false, state: 'absent',
    })
    const ollama = r.body.providers.find((p: any) => p.id === 'ollama')
    expect(ollama.keyOptional).toBe(true)
    expect(ollama.kind).toBe('local')
    const litellm = r.body.providers.find((p: any) => p.id === 'litellm')
    expect(litellm.defaultBaseUrl).toBeNull()
    // Never a path or a mode on the wire.
    expect(JSON.stringify(r.body)).not.toContain(dir)
  })

  test('flag off: 200 with enabled:false and a sentence, no provider read', async () => {
    const r = await call('GET', '/api/provider', undefined, { flagOn: () => false })
    expect(r.status).toBe(200)
    expect(r.body.enabled).toBe(false)
    expect(r.body.code).toBe('flag-off')
    expect(typeof r.body.sentence).toBe('string')
    expect(r.body.providers).toBeUndefined()
  })
})

describe('central refusal', () => {
  test('every route answers 403 central, even with the flag off', async () => {
    for (const [m, p] of [
      ['GET', '/api/provider'], ['PUT', '/api/provider/anthropic'], ['DELETE', '/api/provider/openai'],
      ['POST', '/api/provider/openai/test'], ['GET', '/api/provider/openai/models'],
    ] as const) {
      const r = await call(m, p, m === 'PUT' ? { key: ANTHROPIC_KEY } : undefined, {
        isCentral: async () => true, flagOn: () => false,
      })
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('central')
      expect(leaks(r.body, ANTHROPIC_KEY)).toEqual([])
    }
    await expect(stat(join(dir, 'anthropic.json'))).rejects.toThrow()
  })
})

describe('flag off', () => {
  test('every verb but the list answers 409 flag-off and writes nothing', async () => {
    for (const [m, p] of [
      ['PUT', '/api/provider/anthropic'], ['DELETE', '/api/provider/openai'],
      ['POST', '/api/provider/openai/test'], ['GET', '/api/provider/openai/models'],
    ] as const) {
      const r = await call(m, p, m === 'PUT' ? { key: ANTHROPIC_KEY } : undefined, { flagOn: () => false })
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('flag-off')
    }
    await expect(stat(join(dir, 'anthropic.json'))).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('unknown id and bad requests', () => {
  test('an id outside the closed set is 404 and never echoed', async () => {
    const leakyId = 'sk-ant-mistyped-key-in-the-id-slot-1234567890'
    for (const [m, p] of [
      ['PUT', `/api/provider/${leakyId}`], ['DELETE', `/api/provider/${leakyId}`],
      ['POST', `/api/provider/${leakyId}/test`], ['GET', `/api/provider/${leakyId}/models`],
    ] as const) {
      const r = await call(m, p, m === 'PUT' ? { key: ANTHROPIC_KEY } : undefined)
      expect(r.status).toBe(404)
      expect(r.body.code).toBe('unknown_provider')
      expect(JSON.stringify(r.body)).not.toContain('mistyped')
    }
    // `test` is not an id either.
    expect((await call('PUT', '/api/provider/test', { key: ANTHROPIC_KEY })).status).toBe(404)
  })

  test('an oversized body is refused before it is parsed', async () => {
    const big = { key: 'x'.repeat(PROVIDER_BODY_BYTES + 10) }
    const r = await call('PUT', '/api/provider/anthropic', big)
    expect(r.status).toBe(413)
    expect(r.body.code).toBe('too_large')
  })

  test('invalid JSON and wrong types are 400', async () => {
    expect((await call('PUT', '/api/provider/anthropic', '{not json')).status).toBe(400)
    const r = await call('PUT', '/api/provider/anthropic', { key: 12345 })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('bad_request')
  })

  test('a method a path does not take is 405', async () => {
    expect((await call('POST', '/api/provider')).status).toBe(405)
    expect((await call('GET', '/api/provider/openai')).status).toBe(405)
    expect((await call('GET', '/api/provider/openai/test')).status).toBe(405)
  })

  test('a path that is not a provider route is not answered', async () => {
    const out = await handleProviderRequest(req('GET', '/api/other'), '/api/other', '127.0.0.1', deps())
    expect(out).toBeNull()
  })
})

describe('PUT anthropic', () => {
  test('stores the key; neither the answer, a later GET nor the audit carries it', async () => {
    const r = await call('PUT', '/api/provider/anthropic', { key: ANTHROPIC_KEY })
    expect(r.status).toBe(200)
    expect(r.body.provider.state).toBe('present')
    expect(r.body.provider.fingerprint).toMatch(/^sha256:[0-9a-f]{8}$/)
    expect(r.body.provider.last4).toBe(ANTHROPIC_KEY.slice(-4))
    expect(leaks(r.body, ANTHROPIC_KEY)).toEqual([])

    const list = await call('GET', '/api/provider')
    expect(leaks(list.body, ANTHROPIC_KEY)).toEqual([])
    expect(list.body.providers[0].fingerprint).toBe(r.body.provider.fingerprint)

    expect(audits).toHaveLength(1)
    expect(audits[0]!.action).toBe('provider.set')
    expect(audits[0]!.targetId).toBe('anthropic')
    expect(audits[0]!.meta).toMatchObject({ provider: 'anthropic', fingerprint: r.body.provider.fingerprint })
    expect(leaks(audits, ANTHROPIC_KEY)).toEqual([])
    // And through the persisted builder, which keeps every non-redacted field.
    expect(leaks(buildAuditEvent(audits[0]!, new Date()), ANTHROPIC_KEY)).toEqual([])

    const s = await stat(join(dir, 'anthropic.json'))
    expect(s.mode & 0o777).toBe(0o600)
  })

  test('a malformed key is refused with a code and a sentence that does not echo it', async () => {
    const bad = 'zz-wrongprefix-QWERTYUIOPASDFGHJKL0987'
    const r = await call('PUT', '/api/provider/anthropic', { key: bad })
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('key_prefix')
    expect(leaks(r.body, bad)).toEqual([])
    expect(audits).toEqual([])
  })

  test('key omitted: required when nothing is stored, kept when something is', async () => {
    const none = await call('PUT', '/api/provider/anthropic', {})
    expect(none.status).toBe(422)
    expect(none.body.code).toBe('key_required')

    const first = await call('PUT', '/api/provider/anthropic', { key: ANTHROPIC_KEY })
    const again = await call('PUT', '/api/provider/anthropic', {})
    expect(again.status).toBe(200)
    expect(again.body.provider.fingerprint).toBe(first.body.provider.fingerprint)
    expect(leaks(again.body, ANTHROPIC_KEY)).toEqual([])
  })

  test('a base URL is refused — Anthropic stores none', async () => {
    const r = await call('PUT', '/api/provider/anthropic', { key: ANTHROPIC_KEY, baseUrl: 'https://evil.test' })
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('base_url_not_editable')
  })

  test('replacing the key is allowed and audited with the previous fingerprint', async () => {
    const a = await call('PUT', '/api/provider/anthropic', { key: ANTHROPIC_KEY })
    const other = 'sk-ant-api03-SECONDfakeKEY0000111122223333444455556666'
    const b = await call('PUT', '/api/provider/anthropic', { key: other })
    expect(b.status).toBe(200)
    expect(b.body.provider.fingerprint).not.toBe(a.body.provider.fingerprint)
    expect(audits[1]!.meta).toMatchObject({ previousFingerprint: a.body.provider.fingerprint })
    expect(leaks(audits, other)).toEqual([])
  })
})

describe('PUT an endpoint', () => {
  test('stores key + preset base URL, then a base-URL-only PUT keeps the key', async () => {
    const r = await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })
    expect(r.status).toBe(200)
    expect(r.body.provider.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(r.body.provider.kind).toBe('router')
    const fp = r.body.provider.fingerprint
    expect(leaks(r.body, ROUTER_KEY)).toEqual([])

    // Same ORIGIN, another path: the stored key is kept (a different origin needs the key again —
    // see "UI.4" below).
    const moved = await call('PUT', '/api/provider/openrouter', { baseUrl: 'https://openrouter.ai/api/v2/' })
    expect(moved.status).toBe(200)
    expect(moved.body.provider.baseUrl).toBe('https://openrouter.ai/api/v2')
    expect(moved.body.provider.fingerprint).toBe(fp)
    expect(moved.body.provider.last4).toBe(ROUTER_KEY.slice(-4))
    expect(audits[1]!.meta).toMatchObject({ keyChanged: false, fingerprint: fp })
    expect(leaks([moved.body, audits], ROUTER_KEY)).toEqual([])

    // The key really is still there: a test goes out with it.
    const t = await call('POST', '/api/provider/openrouter/test')
    expect(t.body.ok).toBe(true)
    expect(calls.at(-1)!.url).toBe('https://openrouter.ai/api/v2/models')
  })

  test('UI.4: a base-URL-only PUT to a DIFFERENT origin is refused — whoever lacks the key cannot point it elsewhere', async () => {
    // The exfiltration chain this closes: the routes are unauthenticated on a `local` profile and the
    // server binds 0.0.0.0, so any peer that reaches the port (LAN, tailnet, a DNS-rebinding page)
    // could PUT `{baseUrl: 'https://attacker/v1'}` and then POST /test — and the STORED key would go
    // out in the Authorization header to the attacker. Moving a key to a new origin now requires
    // the key itself, which such a caller does not have.
    const stored = await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })
    const fp = stored.body.provider.fingerprint
    for (const baseUrl of [
      'https://attacker.example.test/v1',  // another host
      'https://openrouter.ai:8443/api/v1', // another port
      'http://localhost:4000/v1',          // another scheme + host (a local listener)
    ]) {
      const r = await call('PUT', '/api/provider/openrouter', { baseUrl })
      expect(r.status).toBe(422)
      expect(r.body.code).toBe('key_required_new_origin')
      expect(JSON.stringify(r.body)).not.toContain('attacker')
      expect(leaks(r.body, ROUTER_KEY)).toEqual([])
    }
    // Nothing moved, nothing was audited as a change, and a test still goes to the original host.
    const list = await call('GET', '/api/provider')
    const row = list.body.providers.find((p: { id: string }) => p.id === 'openrouter')
    expect(row.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(row.fingerprint).toBe(fp)
    expect(audits.length).toBe(1)
    await call('POST', '/api/provider/openrouter/test')
    expect(calls.map(c => c.url)).toEqual(['https://openrouter.ai/api/v1/models'])

    // Re-entering the key with the new origin is the legitimate path and still works.
    const withKey = await call('PUT', '/api/provider/openrouter', { baseUrl: 'https://proxy.example.test/v1', key: ROUTER_KEY })
    expect(withKey.status).toBe(200)
    expect(withKey.body.provider.baseUrl).toBe('https://proxy.example.test/v1')

    // A KEYLESS record has no secret to redirect, so it may move anywhere without one.
    await call('PUT', '/api/provider/ollama', { noKey: true })
    const keyless = await call('PUT', '/api/provider/ollama', { baseUrl: 'http://127.0.0.1:9999/v1' })
    expect(keyless.status).toBe(200)
  })

  test('key omitted with nothing stored is key_required, even for a keyless-capable endpoint', async () => {
    expect((await call('PUT', '/api/provider/openai', {})).body.code).toBe('key_required')
    expect((await call('PUT', '/api/provider/ollama', {})).body.code).toBe('key_required')
  })

  test('noKey: accepted only where the preset allows it', async () => {
    const ok = await call('PUT', '/api/provider/ollama', { noKey: true })
    expect(ok.status).toBe(200)
    expect(ok.body.provider.keyless).toBe(true)
    expect(ok.body.provider.baseUrl).toBe('http://localhost:11434/v1')
    // A keyless record survives a base-URL-only PUT as keyless.
    const moved = await call('PUT', '/api/provider/ollama', { baseUrl: 'http://127.0.0.1:9999/v1' })
    expect(moved.body.provider.keyless).toBe(true)

    const refused = await call('PUT', '/api/provider/openai', { noKey: true })
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe('key_required')

    const both = await call('PUT', '/api/provider/ollama', { noKey: true, key: ROUTER_KEY })
    expect(both.status).toBe(422)
    expect(leaks(both.body, ROUTER_KEY)).toEqual([])
  })

  test('base URL refusals carry a base_url_<reason> code and never the URL', async () => {
    const empty = await call('PUT', '/api/provider/litellm', { key: 'sk-1234' })
    expect(empty.body.code).toBe('base_url_empty')
    const insecure = await call('PUT', '/api/provider/openai', { key: ROUTER_KEY, baseUrl: 'http://remote.example.test/v1' })
    expect(insecure.status).toBe(422)
    expect(insecure.body.code).toBe('base_url_insecure_remote')
    const userinfo = await call('PUT', '/api/provider/openai', { key: ROUTER_KEY, baseUrl: 'https://u:hunter2secret@h.test' })
    expect(userinfo.body.code).toBe('base_url_userinfo')
    expect(JSON.stringify(userinfo.body)).not.toContain('hunter2secret')
    expect(leaks([empty.body, insecure.body, userinfo.body], ROUTER_KEY)).toEqual([])
  })

  test('an Anthropic key is refused on an endpoint (foreign-prefix), without echoing it', async () => {
    const r = await call('PUT', '/api/provider/openai', { key: ANTHROPIC_KEY })
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('key_foreign_prefix')
    expect(leaks(r.body, ANTHROPIC_KEY)).toEqual([])
  })
})

describe('DELETE', () => {
  test('removes the record, answers the absent entry, audits the fingerprint only', async () => {
    const put = await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })
    const r = await call('DELETE', '/api/provider/openrouter')
    expect(r.status).toBe(200)
    expect(r.body.provider.state).toBe('absent')
    expect(r.body.provider.fingerprint).toBeUndefined()
    const removal = audits.find(a => a.action === 'provider.remove')!
    expect(removal.meta).toEqual({ provider: 'openrouter', fingerprint: put.body.provider.fingerprint })
    expect(leaks(audits, ROUTER_KEY)).toEqual([])
  })

  test('removing nothing is idempotent and audits nothing', async () => {
    const r = await call('DELETE', '/api/provider/openai')
    expect(r.status).toBe(200)
    expect(r.body.provider.state).toBe('absent')
    expect(audits).toEqual([])
  })
})

describe('POST /test', () => {
  test('not configured', async () => {
    const r = await call('POST', '/api/provider/openai/test')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: false, code: 'not_configured' })
    expect(calls).toEqual([])
    const a = await call('POST', '/api/provider/anthropic/test')
    expect(a.body).toMatchObject({ ok: false, code: 'not_configured' })
  })

  test('an endpoint: one GET <baseUrl>/models over the stored key, a count and a latency', async () => {
    await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })
    const r = await call('POST', '/api/provider/openrouter/test')
    expect(r.body).toMatchObject({ ok: true, modelCount: 2 })
    expect(typeof r.body.latencyMs).toBe('number')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/models')
    expect(leaks(r.body, ROUTER_KEY)).toEqual([])
    // A test is never served from cache.
    await call('POST', '/api/provider/openrouter/test')
    expect(calls).toHaveLength(2)
  })

  test('Anthropic: GET /v1/models (not billed) with the key in its own header', async () => {
    await call('PUT', '/api/provider/anthropic', { key: ANTHROPIC_KEY })
    fetchImpl = async () => Response.json({ data: [{ type: 'model', id: 'claude-x', display_name: 'X', created_at: '2026-01-01T00:00:00Z' }], has_more: false })
    const r = await call('POST', '/api/provider/anthropic/test')
    expect(r.body).toMatchObject({ ok: true, modelCount: 1 })
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(calls[0]!.headers['x-api-key']).toBe(ANTHROPIC_KEY)
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01')
    expect(leaks(r.body, ANTHROPIC_KEY)).toEqual([])
  })

  // keyChecked: a "test connection" that hits a keyless model-list endpoint proves the endpoint
  // answers, never that a key is valid — a browser run against OpenRouter with a FAKE key still
  // said "Connected — 458 models" because GET /models needs no auth there. `keyChecked` states
  // what the call actually verified: 'yes' where the model-list endpoint DOCUMENTED-ly requires
  // the key (anthropic/openai/deepseek — a bad key there is a 401, not a model list), 'no' for a
  // public or operator-configured list (openrouter/litellm/9router), 'keyless' when the stored
  // record itself carries no key at all (ollama --no-key).
  test('keyChecked: yes for anthropic/openai/deepseek — their model list requires the key', async () => {
    await call('PUT', '/api/provider/anthropic', { key: ANTHROPIC_KEY })
    fetchImpl = async () => Response.json({ data: [{ type: 'model', id: 'claude-x' }], has_more: false })
    expect((await call('POST', '/api/provider/anthropic/test')).body.keyChecked).toBe('yes')

    await call('PUT', '/api/provider/openai', { key: ROUTER_KEY })
    fetchImpl = async () => Response.json({ data: [{ id: 'gpt-x' }] })
    expect((await call('POST', '/api/provider/openai/test')).body.keyChecked).toBe('yes')

    await call('PUT', '/api/provider/deepseek', { key: ROUTER_KEY })
    expect((await call('POST', '/api/provider/deepseek/test')).body.keyChecked).toBe('yes')
  })

  test('keyChecked: no for openrouter/litellm/9router — a public or operator-configured list, not a key check', async () => {
    await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })
    expect((await call('POST', '/api/provider/openrouter/test')).body.keyChecked).toBe('no')

    await call('PUT', '/api/provider/litellm', { key: ROUTER_KEY, baseUrl: 'https://proxy.example.test/v1' })
    expect((await call('POST', '/api/provider/litellm/test')).body.keyChecked).toBe('no')

    await call('PUT', '/api/provider/9router', { key: ROUTER_KEY })
    expect((await call('POST', '/api/provider/9router/test')).body.keyChecked).toBe('no')
  })

  test('keyChecked: keyless when the stored record has no key (ollama --no-key)', async () => {
    await call('PUT', '/api/provider/ollama', { noKey: true })
    const r = await call('POST', '/api/provider/ollama/test')
    expect(r.body).toMatchObject({ ok: true, keyChecked: 'keyless' })
  })

  test('keyChecked: a keyed ollama record is "no" — ollama is never in the requires-key set', async () => {
    await call('PUT', '/api/provider/ollama', { key: ROUTER_KEY })
    const r = await call('POST', '/api/provider/ollama/test')
    expect(r.body).toMatchObject({ ok: true, keyChecked: 'no' })
  })

  test('failures carry a code and status, never the upstream body', async () => {
    await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })
    fetchImpl = async () => new Response(`bad key ${ROUTER_KEY} UPSTREAM-SECRET-BODY`, { status: 401 })
    const u = await call('POST', '/api/provider/openrouter/test')
    expect(u.body).toMatchObject({ ok: false, code: 'unauthorized', status: 401 })
    expect(JSON.stringify(u.body)).not.toContain('UPSTREAM-SECRET-BODY')
    expect(leaks(u.body, ROUTER_KEY)).toEqual([])

    fetchImpl = async () => new Response('oops UPSTREAM-SECRET-BODY', { status: 500 })
    const h = await call('POST', '/api/provider/openrouter/test')
    expect(h.body).toMatchObject({ ok: false, code: 'http-error', status: 500 })
    expect(JSON.stringify(h.body)).not.toContain('UPSTREAM-SECRET-BODY')

    fetchImpl = async () => { throw new Error(`boom ${ROUTER_KEY}`) }
    const n = await call('POST', '/api/provider/openrouter/test')
    expect(n.body).toMatchObject({ ok: false, code: 'network' })
    expect(leaks(n.body, ROUTER_KEY)).toEqual([])

    fetchImpl = async () => Response.json([{ id: 'bare-array' }])
    expect((await call('POST', '/api/provider/openrouter/test')).body.code).toBe('bad-shape')
  })
})

describe('GET /models', () => {
  test('lists id/ownedBy/contextLength only, caches, and a write drops the cache', async () => {
    await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })
    const first = await call('GET', '/api/provider/openrouter/models')
    expect(first.body.ok).toBe(true)
    expect(first.body.fromCache).toBe(false)
    expect(first.body.models).toEqual([
      { id: 'model-a', ownedBy: 'x' },
      { id: 'model-b', contextLength: 1000 },
    ])
    expect(typeof first.body.fetchedAt).toBe('string')
    const second = await call('GET', '/api/provider/openrouter/models')
    expect(second.body.fromCache).toBe(true)
    expect(calls).toHaveLength(1)

    await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })
    const third = await call('GET', '/api/provider/openrouter/models')
    expect(third.body.fromCache).toBe(false)
    expect(calls).toHaveLength(2)
    expect(leaks([first.body, second.body, third.body], ROUTER_KEY)).toEqual([])
  })

  test('not configured', async () => {
    const r = await call('GET', '/api/provider/deepseek/models')
    expect(r.body).toMatchObject({ ok: false, code: 'not_configured' })
  })
})

// ── UI.4 — the security review's sink tests (docs: scratchpad ui4-review.md) ────────────────────
describe('UI.4 sinks', () => {
  test('no console / stdout / stderr output carries the key on ANY verb, including malformed and failed calls', async () => {
    const out: string[] = []
    const orig = {
      log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug,
      so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr),
    }
    const grab = (...a: unknown[]) => { out.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
    console.log = grab; console.error = grab; console.warn = grab; console.info = grab; console.debug = grab
    process.stdout.write = ((c: unknown) => { out.push(String(c)); return true }) as typeof process.stdout.write
    process.stderr.write = ((c: unknown) => { out.push(String(c)); return true }) as typeof process.stderr.write
    const answers: unknown[] = []
    try {
      answers.push((await call('PUT', '/api/provider/anthropic', { key: ANTHROPIC_KEY })).body)
      answers.push((await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })).body)
      // Malformed JSON that CONTAINS the key: Bun's SyntaxError message quotes the input — it must be
      // swallowed by readJsonLimited, never surfaced.
      answers.push((await call('PUT', '/api/provider/openrouter', `{"key": "${ROUTER_KEY}", oops`)).body)
      // Oversized body carrying the key.
      answers.push((await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY, pad: 'x'.repeat(PROVIDER_BODY_BYTES) })).body)
      // Wrong type next to the key.
      answers.push((await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY, noKey: 'yes' })).body)
      // A refused shape.
      answers.push((await call('PUT', '/api/provider/openai', { key: ANTHROPIC_KEY })).body)
      // Upstream failure whose BODY echoes the key back (a hostile or verbose endpoint).
      fetchImpl = async () => new Response(`bad key ${ROUTER_KEY} ${ANTHROPIC_KEY}`, { status: 401 })
      answers.push((await call('POST', '/api/provider/openrouter/test')).body)
      answers.push((await call('POST', '/api/provider/anthropic/test')).body)
      answers.push((await call('GET', '/api/provider/openrouter/models')).body)
      // A network failure.
      fetchImpl = async () => { throw new Error(`connect failed with ${ROUTER_KEY}`) }
      answers.push((await call('POST', '/api/provider/openrouter/test')).body)
      answers.push((await call('DELETE', '/api/provider/openrouter')).body)
      answers.push((await call('DELETE', '/api/provider/anthropic')).body)
      answers.push((await call('GET', '/api/provider')).body)
    } finally {
      console.log = orig.log; console.error = orig.error; console.warn = orig.warn; console.info = orig.info; console.debug = orig.debug
      process.stdout.write = orig.so as typeof process.stdout.write
      process.stderr.write = orig.se as typeof process.stderr.write
    }
    for (const key of [ANTHROPIC_KEY, ROUTER_KEY]) {
      expect(leaks(out, key)).toEqual([])
      expect(leaks(answers, key)).toEqual([])
      expect(leaks(audits.map(a => buildAuditEvent(a, new Date())), key)).toEqual([])
    }
    // Never more than the last four characters of either key on any answer.
    const text = JSON.stringify(answers)
    expect(text).not.toContain(ROUTER_KEY.slice(-5))
    expect(text).not.toContain(ANTHROPIC_KEY.slice(-5))
  })

  test('an endpoint record stays 0600 in a 0700 directory after a store AND a base-URL-only rebase, with no tmp left', async () => {
    await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })
    await call('PUT', '/api/provider/openrouter', { baseUrl: 'https://openrouter.ai/api/v2' })
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(dir)
    expect(names.filter(n => n.startsWith('.tmp-'))).toEqual([])
    for (const n of names) expect((await stat(join(dir, n))).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  test('no path of this route reaches the runtime raw-capture store (capture.ts / CONTENT_DIR)', async () => {
    const { readFileSync } = await import('node:fs')
    for (const f of ['./provider-web.ts', './provider/anthropic-models.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      for (const needle of ['createCapturing' + 'Fetch', 'write' + 'Capture', 'CONTENT' + '_DIR', 'capture']) {
        expect(src.includes(needle)).toBe(false)
      }
    }
  })
})

describe('UI.4 — browser provenance (CSRF) is refused by the SERVER, not only by the browser', () => {
  // A solo machine has no session cookie, so `csrf.ts` exempts every request as "token-authenticated";
  // the only thing stopping a hostile page is the browser's CORS preflight — which a simple POST (the
  // `/test` verb, no body) never triggers. These routes refuse any request a browser marks as
  // coming from another site, whatever the method.
  const hostile = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    handleProviderRequest(
      new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      path, '127.0.0.1', deps(),
    ) as Promise<{ status: number; body: any }>

  test('a cross-site request is refused on every verb and touches nothing', async () => {
    await call('PUT', '/api/provider/openrouter', { key: ROUTER_KEY })
    calls = []
    const cross = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }
    for (const [m, p, b] of [
      ['POST', '/api/provider/openrouter/test', undefined],
      ['GET', '/api/provider/openrouter/models', undefined],
      ['GET', '/api/provider', undefined],
      ['PUT', '/api/provider/openrouter', { baseUrl: 'https://openrouter.ai/api/v9' }],
      ['DELETE', '/api/provider/openrouter', undefined],
    ] as const) {
      const r = await hostile(m, p, cross, b)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('cross_site')
    }
    // An Origin that is not this host, with no Sec-Fetch-Site (an older browser), is refused too.
    expect((await hostile('POST', '/api/provider/openrouter/test', { origin: 'https://evil.example' })).status).toBe(403)
    expect(calls).toEqual([])
    const row = (await call('GET', '/api/provider')).body.providers.find((p: { id: string }) => p.id === 'openrouter')
    expect(row.baseUrl).toBe('https://openrouter.ai/api/v1')
  })

  test('a SAME-SITE page on another localhost port is refused too (ports do not make a site)', async () => {
    // `Sec-Fetch-Site: same-site` is what a browser sends from http://localhost:3000 to
    // http://localhost:47291 — any other local dev server, or a page a malicious package serves. Only
    // the dashboard itself (same-origin) and an explicitly allowlisted origin may act here.
    const r = await hostile('POST', '/api/provider/openrouter/test', { 'sec-fetch-site': 'same-site', origin: 'http://localhost:3000' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('cross_site')
    expect(calls).toEqual([])
  })

  test('the dashboard itself (same-origin), the CLI (no browser headers) and an allowlisted origin still work', async () => {
    expect((await hostile('GET', '/api/provider', { 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    expect((await hostile('GET', '/api/provider', { origin: 'http://localhost' })).status).toBe(200)
    expect((await hostile('GET', '/api/provider', {})).status).toBe(200)
    const allowed = await handleProviderRequest(
      new Request('http://localhost/api/provider', { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://ok.example' } }),
      '/api/provider', '127.0.0.1', deps({ allowedOrigins: ['https://ok.example'] }),
    )
    expect(allowed!.status).toBe(200)
  })
})

// ── B5b — Google's Gemini key over the same routes ──────────────────────────────────────────────

const GOOGLE_KEY = 'AIzaSyFAKEg00gleK3yQQQQzzzz1111PPPPyyyy' // B5b.1-SEC G-2: trimmed to the real 39-char shape

describe('google (B5b) — a second key vendor on the same routes', () => {
  test('listed right after anthropic, as a key vendor: fixed address, always a key', async () => {
    const r = await call('GET', '/api/provider')
    expect(r.body.providers.map((p: any) => p.id).slice(0, 2)).toEqual(['anthropic', 'google'])
    expect(r.body.providers[1]).toEqual({
      id: 'google', label: 'Google Gemini', kind: 'direct', defaultBaseUrl: null,
      baseUrlEditable: false, keyOptional: false, state: 'absent',
    })
  })

  test('PUT stores the key, answers only a fingerprint and last 4, and audits without the key', async () => {
    const r = await call('PUT', '/api/provider/google', { key: GOOGLE_KEY })
    expect(r.status).toBe(200)
    expect(r.body.provider).toMatchObject({ id: 'google', state: 'present', last4: GOOGLE_KEY.slice(-4) })
    expect(r.body.provider.fingerprint).toMatch(/^sha256:[0-9a-f]{8}$/)
    expect(leaks(r.body, GOOGLE_KEY)).toEqual([])
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: 'provider.set', targetId: 'google' })
    expect(leaks(audits, GOOGLE_KEY)).toEqual([])
    expect((await stat(join(dir, 'google.json'))).mode & 0o777).toBe(0o600)
  })

  test('PUT with no key keeps the stored one; with none stored it says a key is required', async () => {
    expect((await call('PUT', '/api/provider/google', {})).body.code).toBe('key_required')
    await call('PUT', '/api/provider/google', { key: GOOGLE_KEY })
    const kept = await call('PUT', '/api/provider/google', {})
    expect(kept.status).toBe(200)
    expect(kept.body.provider.state).toBe('present')
  })

  test('a base URL is refused (the address is fixed) and an Anthropic key is refused for it, never echoed', async () => {
    const base = await call('PUT', '/api/provider/google', { key: GOOGLE_KEY, baseUrl: 'https://example.com' })
    expect(base.status).toBe(422)
    expect(base.body.code).toBe('base_url_not_editable')
    const foreign = await call('PUT', '/api/provider/google', { key: ANTHROPIC_KEY })
    expect(foreign.status).toBe(422)
    expect(foreign.body.code).toBe('key_foreign_prefix')
    expect(leaks(foreign.body, ANTHROPIC_KEY)).toEqual([])
    await expect(stat(join(dir, 'google.json'))).rejects.toThrow()
  })

  test('DELETE removes only the google record', async () => {
    await call('PUT', '/api/provider/anthropic', { key: ANTHROPIC_KEY })
    await call('PUT', '/api/provider/google', { key: GOOGLE_KEY })
    const r = await call('DELETE', '/api/provider/google')
    expect(r.body.provider.state).toBe('absent')
    expect((await call('GET', '/api/provider')).body.providers[0].state).toBe('present')
  })

  test('test and models answer "not supported" in words — no request leaves, no fake success', async () => {
    await call('PUT', '/api/provider/google', { key: GOOGLE_KEY })
    for (const [m, p] of [['POST', '/api/provider/google/test'], ['GET', '/api/provider/google/models']] as const) {
      const r = await call(m, p)
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(false)
      expect(r.body.code).toBe('not_supported')
      expect(typeof r.body.sentence).toBe('string')
    }
    expect(calls).toEqual([])
  })
})
