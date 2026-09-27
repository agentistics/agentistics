/**
 * raw.test.ts — `readAnthropicExchange` / `allowlistHeaders` / `readSdkUsageCrossCheck` against
 * SYNTHETIC bodies built inline (spec §9: "the recorded fixtures are B1.5's" — this file never
 * reads `test/fixtures/provider/anthropic/`). No network, no fs, no real home dir.
 */
import { describe, test, expect } from 'bun:test'
import { classifyProviderError } from '@agentistics/core'
import {
  allowlistHeaders,
  CAPTURED_HEADER_ALLOWLIST,
  CAPTURED_HEADER_PREFIX,
  readAnthropicExchange,
  readSdkUsageCrossCheck,
} from './raw.ts'
import type { RawExchange } from '../client.ts'

function ex(status: number, body: unknown, headers: Record<string, string> = {}): RawExchange {
  return { status, headers, body: JSON.stringify(body) }
}

describe('allowlistHeaders', () => {
  test('keeps the exact names and the rate-limit prefix, drops everything else', () => {
    const headers = {
      'request-id': 'req_1',
      'Retry-After': '30',
      'Content-Type': 'application/json',
      Date: 'Wed, 01 Jan 2026 00:00:00 GMT',
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-tokens-remaining': '1000',
      'anthropic-organization-id': 'org_1',
      'anthropic-workspace-id': 'ws_1',
      'set-cookie': 'session=abc',
      'x-foo': 'bar',
    }
    expect(allowlistHeaders(headers)).toEqual({
      'request-id': 'req_1',
      'retry-after': '30',
      'content-type': 'application/json',
      date: 'Wed, 01 Jan 2026 00:00:00 GMT',
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-tokens-remaining': '1000',
    })
  })

  test('accepts a Headers instance and an iterable of pairs, not only a plain record', () => {
    const fromHeaders = allowlistHeaders(new Headers([['request-id', 'req_2'], ['x-foo', 'bar']]))
    expect(fromHeaders).toEqual({ 'request-id': 'req_2' })

    const fromPairs = allowlistHeaders(
      new Map([['request-id', 'req_3'], ['authorization', 'Bearer nope']]).entries(),
    )
    expect(fromPairs).toEqual({ 'request-id': 'req_3' })
  })

  test('the two exported constants describe the allowlist a caller can rely on', () => {
    expect(CAPTURED_HEADER_ALLOWLIST).toEqual(['request-id', 'retry-after', 'content-type', 'date'])
    expect(CAPTURED_HEADER_PREFIX).toBe('anthropic-ratelimit-')
  })
})

describe('readAnthropicExchange — completed (2xx)', () => {
  test('plain completion', () => {
    const body = {
      id: 'msg_01ABC',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    const result = readAnthropicExchange(ex(200, body, { 'request-id': 'req_1' }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.messageId).toBe('msg_01ABC')
    expect(result.servedModel).toBe('claude-opus-5')
    expect(result.requestId).toBe('req_1')
    expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, contextTokens: 10 })
    expect(result.usageAnomalies).toEqual([])
    expect(result.stopReason).toEqual({ kind: 'end-turn' })
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  test('a tool_use block and a tool_use stop reason', () => {
    const body = {
      id: 'msg_02',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'sf' } }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    const result = readAnthropicExchange(ex(200, body))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.stopReason).toEqual({ kind: 'tool-use' })
    expect(result.content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'sf' } }])
  })

  test('an unrecognised content block is carried by its own raw type, never dropped', () => {
    const body = {
      id: 'msg_03',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'reasoning…' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    const result = readAnthropicExchange(ex(200, body))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.content).toEqual([{ type: 'other', rawType: 'thinking' }])
  })

  test('cache 5m + 1h split → cacheWriteByTtl is set', () => {
    const body = {
      id: 'msg_04',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      },
    }
    const result = readAnthropicExchange(ex(200, body))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.usage.cacheWriteByTtl).toEqual({ ephemeral5m: 100, ephemeral1h: 200 })
    expect(result.usage.cacheWrite).toBe(300)
    expect(result.usageAnomalies).toEqual([])
  })

  test('usage.iterations → iterations carried, iterationsRelation is unmeasured, never folded into the four counters', () => {
    const body = {
      id: 'msg_05',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [
          { type: 'compaction', input_tokens: 500, output_tokens: 50 },
          { type: 'advisor_message', model: 'claude-opus-4-8', input_tokens: 20, output_tokens: 10 },
        ],
      },
    }
    const result = readAnthropicExchange(ex(200, body))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.usage.input).toBe(10)
    expect(result.usage.output).toBe(5)
    expect(result.usage.iterationsRelation).toBe('unmeasured')
    expect(result.usage.iterations).toHaveLength(2)
    expect(result.usage.iterations?.[0]?.kind).toBe('compaction')
    expect(result.usage.iterations?.[1]?.kind).toBe('advisor_message')
    expect(result.usage.iterations?.[1]?.model).toBe('claude-opus-4-8')
  })

  test('request-id header absent → requestId field absent, never synthesised', () => {
    const body = {
      id: 'msg_06',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    const result = readAnthropicExchange(ex(200, body, {}))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect('requestId' in result).toBe(false)
  })

  test('2xx without an id is response-unreadable, never a completed invocation with a made-up identity', () => {
    const result = readAnthropicExchange(ex(200, { model: 'claude-opus-5' }, { 'request-id': 'req_7' }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failed')
    expect(result.classifier).toMatchObject({ responseUnreadable: true, httpStatus: 200 })
    expect(result.requestId).toBe('req_7')
    expect(result.requestIdSource).toBe('header')
  })

  test('a 2xx body that is not JSON at all is response-unreadable, never a throw', () => {
    const result = readAnthropicExchange({ status: 200, headers: {}, body: 'not json{' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failed')
    expect(result.classifier.responseUnreadable).toBe(true)
  })
})

describe('readAnthropicExchange — failed (non-2xx)', () => {
  test('401 authentication_error → classifier fields, no requestId when the header is absent and the body carries none', () => {
    const body = { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
    const result = readAnthropicExchange(ex(401, body))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failed')
    expect(result.classifier).toEqual({ httpStatus: 401, requestSent: true, errorType: 'authentication_error' })
    expect(classifyProviderError(result.classifier).kind).toBe('authentication')
  })

  test('429 with retry-after → classifier carries the header verbatim; requestId falls back to the body', () => {
    const body = { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' }, request_id: 'req_body_1' }
    const result = readAnthropicExchange(ex(429, body, { 'retry-after': '12' }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failed')
    expect(result.classifier.retryAfterHeader).toBe('12')
    expect(result.classifier.errorType).toBe('rate_limit_error')
    expect(result.requestId).toBe('req_body_1')
    expect(result.requestIdSource).toBe('body')
    const classified = classifyProviderError(result.classifier)
    expect(classified.kind).toBe('rate-limited')
    expect(classified.retryAfterMs).toBe(12_000)
  })

  test('529 overloaded_error', () => {
    const body = { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }
    const result = readAnthropicExchange(ex(529, body))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failed')
    expect(classifyProviderError(result.classifier).kind).toBe('overloaded')
  })

  test('400 with error_code enforced_spend_limit_reached → the classifier carries the code, and classify() reads it as spend-cap over invalid-request', () => {
    const body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'spend limit reached',
        details: { error_code: 'enforced_spend_limit_reached' },
      },
    }
    const result = readAnthropicExchange(ex(400, body))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failed')
    expect(result.classifier.errorCode).toBe('enforced_spend_limit_reached')
    expect(result.classifier.errorType).toBe('invalid_request_error')
    const classified = classifyProviderError(result.classifier)
    expect(classified.kind).toBe('spend-cap')
    expect(classified.retryable).toBe(false)
  })

  test('never reads or returns the error message text', () => {
    const body = { type: 'error', error: { type: 'authentication_error', message: 'sk-ant-super-secret-leaked-value' } }
    const result = readAnthropicExchange(ex(401, body))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failed')
    expect(JSON.stringify(result)).not.toContain('sk-ant-super-secret-leaked-value')
  })

  test('request-id header wins over the body request_id when both are present', () => {
    const body = { type: 'error', error: { type: 'api_error' }, request_id: 'req_from_body' }
    const result = readAnthropicExchange(ex(500, body, { 'request-id': 'req_from_header' }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failed')
    expect(result.requestId).toBe('req_from_header')
    expect(result.requestIdSource).toBe('header')
  })

  test('a non-JSON error body still classifies by status alone, never throws', () => {
    const result = readAnthropicExchange({ status: 500, headers: {}, body: 'gateway timeout' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failed')
    expect(result.classifier).toEqual({ httpStatus: 500, requestSent: true })
    expect(classifyProviderError(result.classifier).kind).toBe('api-error')
  })
})

describe('readSdkUsageCrossCheck', () => {
  const raw = { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }

  test('no divergence when the SDK-shaped counters agree (nested LanguageModelV4Usage shape)', () => {
    const sdkUsage = {
      inputTokens: { total: 15, noCache: 10, cacheRead: 2, cacheWrite: 3 },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    }
    expect(readSdkUsageCrossCheck(sdkUsage, raw)).toEqual({ divergent: false, fields: [] })
  })

  test('no divergence when the SDK-shaped counters agree (flat ai LanguageModelUsage shape)', () => {
    const sdkUsage = {
      inputTokens: 10,
      inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3 },
      outputTokens: 5,
      outputTokenDetails: { textTokens: 5, reasoningTokens: undefined },
      totalTokens: 15,
    }
    expect(readSdkUsageCrossCheck(sdkUsage, raw)).toEqual({ divergent: false, fields: [] })
  })

  test('a divergence is reported per field, never silently corrected', () => {
    const sdkUsage = { inputTokens: { total: 999, noCache: 999, cacheRead: 2, cacheWrite: 3 }, outputTokens: { total: 5 } }
    const result = readSdkUsageCrossCheck(sdkUsage, raw)
    expect(result.divergent).toBe(true)
    expect(result.fields).toEqual(['input'])
  })

  test('an unreadable or empty SDK usage is never a divergence', () => {
    expect(readSdkUsageCrossCheck(undefined, raw)).toEqual({ divergent: false, fields: [] })
    expect(readSdkUsageCrossCheck('not an object', raw)).toEqual({ divergent: false, fields: [] })
    expect(readSdkUsageCrossCheck({}, raw)).toEqual({ divergent: false, fields: [] })
  })
})
