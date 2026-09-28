/**
 * raw.fixtures.test.ts — `readGoogleExchange` and `createGoogleStreamReader` against the on-disk
 * fixtures in `packages/runtime/test/fixtures/provider/google/`. No network, no key.
 *
 * Every fixture is `documented-shape` (`.documented.json`, like the Anthropic ones): built from
 * Google's own reference pages with illustrative counters — NOT recorded from a live call (a live
 * call costs money and is the owner's; B5b.2 reconciles against a bill). Each carries `meta.source`.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyProviderError, decideRetry, DEFAULT_RETRY_POLICY } from '@agentistics/core'
import type { ProviderStreamEvent, RawExchange } from '../client.ts'
import { createToolCallAssembler } from '../tool-call-stream.ts'
import { createSseDecoder } from '../anthropic/raw-stream.ts'
import { allowlistGoogleHeaders, fromGoogleFinishReason, readGoogleExchange } from './raw.ts'
import { createGoogleStreamReader, type StreamVerdict } from './raw-stream.ts'

const DIR = join(import.meta.dir, '../../../test/fixtures/provider/google')

interface Fixture {
  meta: { provenance: string; scenario: string; source: string }
  status: number
  headers: Record<string, string>
  body: string
}

// Directory order is not a contract: sorted here, and asserted sorted below.
const names = readdirSync(DIR).filter(f => f.endsWith('.documented.json')).sort()
const fixtures = new Map(names.map(n => [n.replace('.documented.json', ''), JSON.parse(readFileSync(join(DIR, n), 'utf8')) as Fixture]))

function exchange(name: string): RawExchange {
  const f = fixtures.get(name)
  if (!f) throw new Error(`missing fixture ${name}`)
  return { status: f.status, headers: allowlistGoogleHeaders(f.headers), body: f.body }
}

function readStream(name: string, chunkSize = Number.POSITIVE_INFINITY): { events: ProviderStreamEvent[]; verdict: StreamVerdict } {
  const ex = exchange(name)
  const sse = createSseDecoder()
  const reader = createGoogleStreamReader({ requestedModel: 'gemini-2.5-flash', assembler: createToolCallAssembler() })
  const events: ProviderStreamEvent[] = []
  const text = ex.body
  const step = Number.isFinite(chunkSize) ? chunkSize : text.length || 1
  for (let i = 0; i < text.length; i += step) {
    for (const frame of sse.push(text.slice(i, i + step))) events.push(...reader.accept(frame))
  }
  for (const frame of sse.end()) events.push(...reader.accept(frame))
  const verdict = reader.finish('complete')
  events.push(...verdict.events)
  return { events, verdict }
}

describe('fixtures directory', () => {
  test('non-vacuity: the fixtures are listed in a stable, SORTED order and each cites its source', () => {
    expect(names).toEqual([...names].sort())
    expect([...fixtures.keys()]).toEqual([
      'blocked-prompt', 'cached', 'error-429', 'plain', 'stream-cut-off', 'stream-midstream-error',
      'stream-tool-call', 'stream-usage-every-chunk', 'thoughts', 'tool-use',
    ])
    for (const [name, f] of fixtures) {
      expect({ name, provenance: f.meta.provenance, sourced: f.meta.source.length > 0 })
        .toEqual({ name, provenance: 'documented-shape', sourced: true })
    }
  })

  test('the scenarios the brief names are all present: thoughts, cached, streamed tool call, mid-stream error', () => {
    for (const n of ['thoughts', 'cached', 'stream-tool-call', 'stream-midstream-error']) expect(fixtures.has(n)).toBe(true)
  })
})

describe('finishReason → stop reason (never end-turn for a word not recognised)', () => {
  test.each([
    ['STOP', false, { kind: 'end-turn' }],
    ['STOP', true, { kind: 'tool-use' }],
    ['MAX_TOKENS', false, { kind: 'max-tokens' }],
    ['SAFETY', false, { kind: 'refusal', category: 'SAFETY' }],
    ['PROHIBITED_CONTENT', false, { kind: 'refusal', category: 'PROHIBITED_CONTENT' }],
    ['IMAGE_PROHIBITED_CONTENT', false, { kind: 'refusal', category: 'IMAGE_PROHIBITED_CONTENT' }],
    ['MALFORMED_FUNCTION_CALL', false, { kind: 'other', raw: 'MALFORMED_FUNCTION_CALL' }],
    ['MISSING_THOUGHT_SIGNATURE', false, { kind: 'other', raw: 'MISSING_THOUGHT_SIGNATURE' }],
    ['SOME_FUTURE_REASON', false, { kind: 'other', raw: 'SOME_FUTURE_REASON' }],
    [undefined, false, { kind: 'other', raw: null }],
    [42, false, { kind: 'other', raw: null }],
  ])('%p (function call: %p) → %p', (raw, hasCall, expected) => {
    expect(fromGoogleFinishReason(raw, hasCall)).toEqual(expected as never)
  })
})

describe('non-streamed responses', () => {
  test('plain: completed, no ids invented, cache-unstated is read conservatively', () => {
    const r = readGoogleExchange(exchange('plain'), 'gemini-2.5-flash')
    if (!r.ok) throw new Error('expected ok')
    expect(r.messageId).toBe('')
    expect(r.servedModel).toBe('gemini-2.5-flash')
    expect(r.usage).toMatchObject({ input: 12, output: 4, contextTokens: 12 })
    expect(r.usage.missing).toEqual(['cacheRead', 'cacheWrite'])
    expect(r.usageNotes).toContain('input-may-include-cache')
    expect(r.stopReason).toEqual({ kind: 'end-turn' })
    expect(r.content).toEqual([{ type: 'text', text: 'Hello there.' }])
    expect(r.usageCertainty).toBe('provider-stated')
    expect(r.cost).toEqual({ kind: 'unavailable', reason: 'no-verified-price' })
  })

  test('thoughts: additive reasoning is carried beside output, never inside it, never dropped', () => {
    const r = readGoogleExchange(exchange('thoughts'), 'gemini-2.5-flash')
    if (!r.ok) throw new Error('expected ok')
    expect(r.usage.output).toBe(6)
    expect(r.usage.reasoning).toEqual({ tokens: 300, billing: 'additive' })
    expect(r.usageNotes).not.toContain('total-mismatch')
  })

  test('cached: the cache is SUBTRACTED from the prompt count (Google includes it)', () => {
    const r = readGoogleExchange(exchange('cached'), 'gemini-2.5-flash')
    if (!r.ok) throw new Error('expected ok')
    expect(r.usage).toMatchObject({ input: 200, cacheRead: 800, output: 5, contextTokens: 1000 })
    expect(r.usage.missing).toEqual(['cacheWrite'])
  })

  test('tool-use: the call is assembled from an already-parsed object; toolUsePrompt is carried as unknown', () => {
    const r = readGoogleExchange(exchange('tool-use'), 'gemini-2.5-flash')
    if (!r.ok) throw new Error('expected ok')
    expect(r.content).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'google-call-0', name: 'get_weather', input: { city: 'Lisbon' } },
    ])
    expect(r.stopReason).toEqual({ kind: 'tool-use' }) // STOP + a functionCall is a tool turn, not "finished"
    expect(r.toolUsePrompt).toEqual({ tokens: 45, billing: 'unknown' })
    expect(r.usage.input).toBe(300) // the tool-use prompt is in NO counter
    expect(r.usageNotes).toContain('total-excludes-tool-use-prompt') // 300 + 20 === 320
  })

  test('blocked-prompt: a refusal with the block reason, still a completed (accepted) response', () => {
    const r = readGoogleExchange(exchange('blocked-prompt'), 'gemini-2.5-flash')
    if (!r.ok) throw new Error('expected ok')
    expect(r.stopReason).toEqual({ kind: 'refusal', category: 'PROHIBITED_CONTENT' })
    expect(r.content).toEqual([])
    expect(r.usage.input).toBe(9)
  })

  test('error-429: classified from the status and retry-after alone, retryable, outcome known', () => {
    const r = readGoogleExchange(exchange('error-429'), 'gemini-2.5-flash')
    if (r.ok) throw new Error('expected failure')
    const err = classifyProviderError(r.classifier)
    expect(err).toMatchObject({ kind: 'rate-limited', retryable: true, retryAfterMs: 7000, usageOutcome: 'none-reported' })
    expect(err.requestId).toBeUndefined() // Google documents no id: none is invented
  })

  test('a 200 with an in-band error object, or with neither candidates nor a block, is UNREADABLE', () => {
    for (const body of ['{"error":{"code":500,"status":"INTERNAL"}}', '{"usageMetadata":{"promptTokenCount":1}}', '[]', 'not json', '']) {
      const r = readGoogleExchange({ status: 200, headers: {}, body }, 'm')
      if (r.ok) throw new Error(`expected failure for ${body}`)
      expect(classifyProviderError(r.classifier)).toMatchObject({ kind: 'response-unreadable', usageOutcome: 'unknown' })
    }
  })

  test('no modelVersion: the requested id stands in and the substitution is SAID', () => {
    const r = readGoogleExchange({ status: 200, headers: {}, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }) }, 'gemini-x')
    if (!r.ok) throw new Error('expected ok')
    expect(r.servedModel).toBe('gemini-x')
    expect(r.usageNotes).toContain('served-model-unstated')
    expect(r.usageCertainty).toBe('absent') // and no usage object → nothing is claimed
  })

  test('the header allowlist keeps three names and drops everything else, request ids included', () => {
    const kept = allowlistGoogleHeaders({
      'Content-Type': 'application/json', Date: 'x', 'Retry-After': '3',
      'x-request-id': 'req_1', 'request-id': 'req_2', 'set-cookie': 'a=b', 'x-goog-request-params': 'p', server: 'ESF',
    })
    expect(Object.keys(kept).sort()).toEqual(['content-type', 'date', 'retry-after'])
  })
})

describe('streamed responses', () => {
  test('stream-tool-call: text deltas, then the assembled call, usage from the final chunk', () => {
    const { events, verdict } = readStream('stream-tool-call')
    expect(events.map(e => e.type)).toEqual(['started', 'text-delta', 'text-delta', 'tool-call', 'usage'])
    expect(events[0]).toEqual({ type: 'started', servedModel: 'gemini-2.5-flash' }) // no requestId / messageId: none exists
    expect(events[3]).toMatchObject({ type: 'tool-call', name: 'get_weather', input: { city: 'Lisbon' } })
    expect(events[4]).toEqual({ type: 'usage', outputTokensSoFar: 25 }) // candidates only: thoughts are their own counter
    if (!verdict.ok) throw new Error('expected ok')
    expect(verdict.usage).toMatchObject({ input: 300, output: 25, reasoning: { tokens: 40, billing: 'additive' } })
    expect(verdict.content).toEqual([
      { type: 'text', text: 'Checking the weather.' },
      { type: 'tool_use', id: 'google-call-0', name: 'get_weather', input: { city: 'Lisbon' } },
    ])
    expect(verdict.stopReason).toEqual({ kind: 'tool-use' })
    expect(verdict.toolCallFailures).toEqual([])
    expect(verdict.messageId).toBe('')
  })

  test('every chunk boundary gives the same answer (1, 2, 7 and 64 bytes at a time)', () => {
    const whole = readStream('stream-tool-call')
    for (const size of [1, 2, 7, 64]) expect(readStream('stream-tool-call', size)).toEqual(whole)
  })

  test('stream-usage-every-chunk: the LAST usage wins and nothing is summed; the repetition is recorded', () => {
    const { verdict } = readStream('stream-usage-every-chunk')
    if (!verdict.ok) throw new Error('expected ok')
    expect(verdict.usage.output).toBe(3) // not 1 + 2 + 3
    expect(verdict.usage.input).toBe(50) // not 150
    expect(verdict.usageNotes).toContain('usage-on-multiple-chunks')
    expect(verdict.usageNotes).not.toContain('usage-not-monotonic')
  })

  test('a usage figure that goes DOWN between chunks is evidence that "the last" is wrong, and is recorded', () => {
    const chunk = (out: number, finish?: string) =>
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a' }] }, ...(finish ? { finishReason: finish } : {}) }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: out } })}\n\n`
    const sse = createSseDecoder()
    const reader = createGoogleStreamReader({ requestedModel: 'm', assembler: createToolCallAssembler() })
    for (const frame of sse.push(chunk(7) + chunk(2, 'STOP'))) reader.accept(frame)
    const verdict = reader.finish('complete')
    if (!verdict.ok) throw new Error('expected ok')
    expect(verdict.usageNotes).toContain('usage-not-monotonic')
  })

  test('stream-midstream-error: HTTP 200 with an in-band error is a FAILURE, outcome unknown, never retried', () => {
    const { events, verdict } = readStream('stream-midstream-error')
    expect(events.filter(e => e.type === 'text-delta')).toHaveLength(1) // it did stream some text first…
    if (verdict.ok) throw new Error('a mid-stream error must not be a success')
    expect(verdict.error).toMatchObject({ httpStatus: 200, usageOutcome: 'unknown' })
    // …and the failure carries no usage at all: `ProviderError` has no field for one.
    expect(JSON.stringify(verdict.error)).not.toContain('promptTokenCount')
    expect(decideRetry({ attempt: 1, error: verdict.error, elapsedMs: 0, policy: DEFAULT_RETRY_POLICY }))
      .toMatchObject({ retry: false, reason: 'ambiguous-outcome' })
  })

  test('stream-cut-off: a body that ends with no finishReason is a failure with unknown billing, not a completed answer', () => {
    const { verdict } = readStream('stream-cut-off')
    if (verdict.ok) throw new Error('a cut stream must not be a success')
    expect(verdict.error).toMatchObject({ kind: 'network', usageOutcome: 'unknown', retryable: false })
  })

  test('an unparseable chunk makes the whole response unreadable — no usage is read around a hole', () => {
    const sse = createSseDecoder()
    const reader = createGoogleStreamReader({ requestedModel: 'm', assembler: createToolCallAssembler() })
    for (const frame of sse.push('data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"STOP"}]}\n\ndata: {oops\n\n')) reader.accept(frame)
    const verdict = reader.finish('complete')
    if (verdict.ok) throw new Error('expected failure')
    expect(verdict.error.kind).toBe('response-unreadable')
  })

  test('the finishing chunk need not be the last: usage on a trailing chunk is still read', () => {
    const sse = createSseDecoder()
    const reader = createGoogleStreamReader({ requestedModel: 'm', assembler: createToolCallAssembler() })
    const a = { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }
    const b = { usageMetadata: { promptTokenCount: 4, cachedContentTokenCount: 1, candidatesTokenCount: 2 } }
    for (const frame of sse.push(`data: ${JSON.stringify(a)}\n\ndata: ${JSON.stringify(b)}\n\n`)) reader.accept(frame)
    const verdict = reader.finish('complete')
    if (!verdict.ok) throw new Error('expected ok')
    expect(verdict.usage).toMatchObject({ input: 3, cacheRead: 1, output: 2 })
  })

  test('an aborted body with no finishReason is an abort; one that had finished is still complete', () => {
    const sse = createSseDecoder()
    const mk = () => createGoogleStreamReader({ requestedModel: 'm', assembler: createToolCallAssembler() })
    const partial = mk()
    for (const frame of sse.push('data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\n')) partial.accept(frame)
    const v1 = partial.finish('aborted')
    if (v1.ok) throw new Error('expected failure')
    expect(v1.error.kind).toBe('aborted')

    const whole = mk()
    const sse2 = createSseDecoder()
    for (const frame of sse2.push('data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"STOP"}]}\n\n')) whole.accept(frame)
    expect(whole.finish('aborted').ok).toBe(true)
  })

  test('a closing `text: ""` chunk opens no block: streamed content equals the non-streamed reading of the same answer', () => {
    const chunks = [
      { candidates: [{ content: { parts: [{ text: 'Looking. ' }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] } }] },
      { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, cachedContentTokenCount: 0, candidatesTokenCount: 2 } },
    ]
    const sse = createSseDecoder()
    const reader = createGoogleStreamReader({ requestedModel: 'm', assembler: createToolCallAssembler() })
    for (const frame of sse.push(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join(''))) reader.accept(frame)
    const streamed = reader.finish('complete')
    if (!streamed.ok) throw new Error('expected ok')
    expect(streamed.content).toEqual([
      { type: 'text', text: 'Looking. ' },
      { type: 'tool_use', id: 'google-call-0', name: 'f', input: { a: 1 } },
    ])
    const whole = readGoogleExchange({
      status: 200, headers: {},
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Looking. ' }, { functionCall: { name: 'f', args: { a: 1 } } }, { text: '' }] }, finishReason: 'STOP' }] }),
    }, 'm')
    if (!whole.ok) throw new Error('expected ok')
    expect(whole.content).toEqual(streamed.content)
  })

  test('a call to an undeclared tool fails to assemble: named failure, never a tool_use, attempt still completes', () => {
    const sse = createSseDecoder()
    const reader = createGoogleStreamReader({
      requestedModel: 'm',
      assembler: createToolCallAssembler([{ name: 'declared', inputSchema: { type: 'object' } }]),
    })
    const chunk = { candidates: [{ content: { parts: [{ functionCall: { name: 'sneaky', args: {} } }] }, finishReason: 'STOP' }] }
    const events: ProviderStreamEvent[] = []
    for (const frame of sse.push(`data: ${JSON.stringify(chunk)}\n\n`)) events.push(...reader.accept(frame))
    expect(events.map(e => e.type)).toEqual(['started', 'tool-call-failed'])
    const verdict = reader.finish('complete')
    if (!verdict.ok) throw new Error('expected ok')
    expect(verdict.toolCallFailures).toMatchObject([{ reason: 'unknown-tool', name: 'sneaky' }])
    expect(verdict.content).toEqual([{ type: 'other', rawType: 'functionCall' }])
  })
})
