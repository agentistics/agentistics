/**
 * raw.test.ts — B5a.1: the PURE Chat Completions exchange reader. No network, no fs.
 */
import { describe, expect, test } from 'bun:test'
import {
  allowlistOpenAICompatibleHeaders,
  fromChatCompletionsFinishReason,
  OPENAI_COMPATIBLE_HEADER_ALLOWLIST,
  readOpenAICompatibleExchange,
  toChatContent,
} from './raw.ts'
import type { RawExchange } from '../client.ts'

function exchange(status: number, body: unknown, headers: Record<string, string> = {}): RawExchange {
  return { status, headers, body: typeof body === 'string' ? body : JSON.stringify(body) }
}

function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-abc123',
    object: 'chat.completion',
    model: 'gpt-test-served',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 3,
      total_tokens: 23,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  }
}

describe('allowlistOpenAICompatibleHeaders — an allowlist, header by header', () => {
  test('keeps the named ones and the x-ratelimit-* family, drops account ids, cookies, cf-* and routers', () => {
    const kept = allowlistOpenAICompatibleHeaders(new Headers({
      'X-Request-Id': 'req_1',
      'Retry-After': '2',
      'Content-Type': 'application/json',
      'Date': 'Sun, 27 Sep 2026 10:00:00 GMT',
      'openai-processing-ms': '123',
      'x-ratelimit-remaining-tokens': '999',
      'x-ratelimit-limit-project-tokens': '5000',
      'x-litellm-response-cost': '0.0001',
      'x-litellm-call-id': 'call_1',
      // excluded, each for a stated reason
      'openai-organization': 'org-SECRET',
      'openai-project': 'proj_SECRET',
      'openai-version': '2020-10-01',
      'set-cookie': '__cf_bm=SECRET',
      'cf-ray': 'abc-EWR',
      'cf-cache-status': 'DYNAMIC',
      'x-litellm-key-spend': '12.5',
      'x-openrouter-anything': 'nope',
      'x-generation-id': 'gen-nope',
      'server': 'cloudflare',
    }))
    expect(Object.keys(kept).sort()).toEqual([
      'content-type', 'date', 'openai-processing-ms', 'retry-after',
      'x-litellm-call-id', 'x-litellm-response-cost',
      'x-ratelimit-limit-project-tokens', 'x-ratelimit-remaining-tokens', 'x-request-id',
    ])
    expect(JSON.stringify(kept)).not.toContain('SECRET')
  })

  test('the allowlist names no account identifier, cookie, or cf-* header', () => {
    for (const name of OPENAI_COMPATIBLE_HEADER_ALLOWLIST) {
      expect(name).not.toMatch(/organization|project|cookie|^cf-/)
    }
  })

  test('accepts a plain record (a fixture read back from JSON)', () => {
    expect(allowlistOpenAICompatibleHeaders({ 'X-Request-Id': 'r', 'openai-organization': 'o' }))
      .toEqual({ 'x-request-id': 'r' })
  })
})

describe('fromChatCompletionsFinishReason', () => {
  test('the documented values map; everything else is other, never end-turn', () => {
    expect(fromChatCompletionsFinishReason('stop')).toEqual({ kind: 'end-turn' })
    expect(fromChatCompletionsFinishReason('length')).toEqual({ kind: 'max-tokens' })
    expect(fromChatCompletionsFinishReason('tool_calls')).toEqual({ kind: 'tool-use' })
    expect(fromChatCompletionsFinishReason('content_filter')).toEqual({ kind: 'refusal', category: 'content_filter' })
    expect(fromChatCompletionsFinishReason('function_call')).toEqual({ kind: 'other', raw: 'function_call' })
    expect(fromChatCompletionsFinishReason('load')).toEqual({ kind: 'other', raw: 'load' })
    expect(fromChatCompletionsFinishReason(null)).toEqual({ kind: 'other', raw: null })
    expect(fromChatCompletionsFinishReason(undefined)).toEqual({ kind: 'other', raw: null })
  })
})

describe('toChatContent', () => {
  test('text + tool calls; arguments parsed when JSON, kept verbatim when not', () => {
    const content = toChatContent({
      role: 'assistant',
      content: 'thinking out loud',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
        { id: 'call_2', type: 'function', function: { name: 'bad', arguments: '{not json' } },
        { id: 'call_3', type: 'function', function: { name: 'obj', arguments: { already: 'object' } } },
        { nonsense: true },
      ],
      reasoning_content: 'a trace',
      refusal: null,
    })
    expect(content).toEqual([
      { type: 'text', text: 'thinking out loud' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'call_2', name: 'bad', input: '{not json' },
      { type: 'tool_use', id: 'call_3', name: 'obj', input: { already: 'object' } },
      { type: 'other', rawType: 'tool_call' },
      { type: 'other', rawType: 'reasoning_content' },
    ])
  })

  test('null content with tool calls yields only the calls; a non-object yields nothing', () => {
    expect(toChatContent({ content: null, tool_calls: [] })).toEqual([])
    expect(toChatContent('nope')).toEqual([])
  })
})

describe('readOpenAICompatibleExchange', () => {
  test('a 2xx reads identity, served model, stop reason and content from the RAW body', () => {
    const r = readOpenAICompatibleExchange(exchange(200, chatBody(), { 'x-request-id': 'req_9' }), 'direct')
    if (!r.ok) throw new Error('expected ok')
    expect(r.messageId).toBe('chatcmpl-abc123')
    expect(r.servedModel).toBe('gpt-test-served')
    expect(r.requestId).toBe('req_9')
    expect(r.stopReason).toEqual({ kind: 'end-turn' })
    expect(r.content).toEqual([{ type: 'text', text: 'ok' }])
    // Contract D4: input EXCLUDES the cached sub-count on this wire.
    expect(r.usage.input).toBe(12)
    expect(r.usage.cacheRead).toBe(8)
    expect(r.usage.output).toBe(3)
    expect(r.usageCertainty).toBe('provider-stated')
    expect(r.cost.kind).toBe('unavailable')
  })

  test('OpenRouter: the body id is the generation id, no request-id is invented, router cost is carried', () => {
    const r = readOpenAICompatibleExchange(exchange(200, chatBody({
      id: 'gen-777',
      model: 'anthropic/claude-sonnet-4.6',
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.00042 },
    })), 'router')
    if (!r.ok) throw new Error('expected ok')
    expect(r.messageId).toBe('gen-777')
    expect(r.requestId).toBeUndefined()
    expect(r.usageCertainty).toBe('router-stated')
    expect(r.cost.kind).toBe('router-reported')
    if (r.cost.kind === 'router-reported') expect(r.cost.usd).toBe(0.00042)
  })

  test('a local endpoint is graded local-unbilled', () => {
    const r = readOpenAICompatibleExchange(exchange(200, chatBody()), 'local')
    if (!r.ok) throw new Error('expected ok')
    expect(r.usageCertainty).toBe('local-unbilled')
    expect(r.cost).toEqual({ kind: 'unavailable', reason: 'local-unbilled' })
  })

  test('a 2xx without an id, without choices, unparseable, or carrying an in-band error is response-unreadable', () => {
    const cases: RawExchange[] = [
      exchange(200, chatBody({ id: undefined })),
      exchange(200, chatBody({ id: '' })),
      exchange(200, chatBody({ choices: [] })),
      exchange(200, '<html>proxy</html>'),
      exchange(200, chatBody({ error: { code: 502, message: 'upstream said something' } })),
      exchange(200, chatBody({ choices: [{ index: 0, message: { content: '' }, finish_reason: 'error' }] })),
    ]
    for (const ex of cases) {
      const r = readOpenAICompatibleExchange(ex, 'router')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.classifier.responseUnreadable).toBe(true)
    }
  })

  test('a non-2xx carries status, retry-after and request id — and never the error message', () => {
    const r = readOpenAICompatibleExchange(exchange(429, {
      error: { message: 'Rate limit reached for SECRET-ORG', type: 'tokens', code: 'rate_limit_exceeded' },
    }, { 'retry-after': '3', 'x-request-id': 'req_429' }), 'direct')
    expect(r).toEqual({
      ok: false,
      requestId: 'req_429',
      classifier: { httpStatus: 429, requestSent: true, retryAfterHeader: '3', requestIdHeader: 'req_429' },
    })
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })

  test('a vendor error.type is withheld (401 classifies by status), except quota exhaustion', () => {
    const auth = readOpenAICompatibleExchange(exchange(401, {
      error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' },
    }), 'direct')
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.classifier.errorType).toBeUndefined()

    const quota = readOpenAICompatibleExchange(exchange(429, {
      error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' },
    }), 'direct')
    if (!quota.ok) expect(quota.classifier.errorType).toBe('insufficient_quota')
  })

  test('never throws on garbage', () => {
    for (const body of ['', 'null', '[]', '{"choices":"x"}', '{"id":1,"model":2,"choices":[1]}']) {
      expect(() => readOpenAICompatibleExchange(exchange(200, body), 'direct')).not.toThrow()
      expect(() => readOpenAICompatibleExchange(exchange(500, body), 'direct')).not.toThrow()
    }
  })
})
