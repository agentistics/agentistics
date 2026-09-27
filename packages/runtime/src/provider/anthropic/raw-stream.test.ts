/**
 * raw-stream.test.ts — the PURE SSE decoder and Anthropic stream reader (`./raw-stream.ts`). No
 * network, no key. The streams replayed here are the documented ones in
 * `packages/runtime/test/fixtures/provider/anthropic/*.documented.sse`, each citing its source
 * (https://docs.anthropic.com/en/api/messages-streaming) in its own header comment, plus small
 * hand-built streams for the cases the docs describe in words (cumulative `message_delta` usage, a
 * body cut short, a tool call cut by `max_tokens`).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyInBandError,
  createAnthropicStreamReader,
  createSseDecoder,
  type SseFrame,
  type StreamBodyEnd,
} from './raw-stream.ts'
import { createToolCallAssembler, type ToolCallAssembler, type ToolCallStep } from '../tool-call-stream.ts'
import type { ProviderStreamEvent, ToolCallFailure } from '../client.ts'

const FIXTURES = join(import.meta.dir, '../../../test/fixtures/provider/anthropic')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

const TEXT = fixture('stream-text.documented.sse')
const TOOL = fixture('stream-tool-use.documented.sse')
const ERROR = fixture('stream-error-overloaded.documented.sse')

function decodeAll(chunks: string[]): SseFrame[] {
  const d = createSseDecoder()
  const out: SseFrame[] = []
  for (const c of chunks) out.push(...d.push(c))
  out.push(...d.end())
  return out
}

/** One SSE frame per event, the wire form (`event:` + `data:` + blank line). */
function sse(events: Array<Record<string, unknown>>): string {
  return events.map(e => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function run(
  text: string,
  end: StreamBodyEnd = 'complete',
  opts: { assembler?: ToolCallAssembler; requestId?: string } = {},
) {
  const reader = createAnthropicStreamReader({
    assembler: opts.assembler ?? createToolCallAssembler(),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  })
  const events: ProviderStreamEvent[] = []
  for (const frame of decodeAll([text])) events.push(...reader.accept(frame))
  const verdict = reader.finish(end)
  events.push(...verdict.events)
  return { events, verdict }
}

const START = (usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 1 }) => ({
  type: 'message_start',
  message: { id: 'msg_x', type: 'message', role: 'assistant', content: [], model: 'claude-served', stop_reason: null, stop_sequence: null, usage },
})
const TEXT_BLOCK = (index: number, text: string) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index },
]
const TOOL_BLOCK = (index: number, fragments: string[], stop = true) => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${index}`, name: 'get_weather', input: {} } },
  ...fragments.map(partial_json => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
  ...(stop ? [{ type: 'content_block_stop', index }] : []),
]
const DELTA = (stop_reason: string, usage: Record<string, unknown>) => ({
  type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage,
})
const STOP = { type: 'message_stop' }

describe('createSseDecoder — framing survives any chunk boundary', () => {
  test('the documented text stream yields its nine events, comments and pings included as data', () => {
    const frames = decodeAll([TEXT])
    expect(frames.map(f => f.event)).toEqual([
      'message_start', 'content_block_start', 'ping', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ])
    expect(JSON.parse(frames[0]!.data).message.id).toBe('msg_documented_stream_text_0001')
  })

  test('split at EVERY position (mid-line, mid-field, mid-event) gives the same frames', () => {
    const whole = decodeAll([TOOL])
    for (let i = 1; i < TOOL.length; i++) {
      expect(decodeAll([TOOL.slice(0, i), TOOL.slice(i)])).toEqual(whole)
    }
  })

  test('one character at a time gives the same frames', () => {
    expect(decodeAll([...TOOL])).toEqual(decodeAll([TOOL]))
  })

  test('CRLF and lone-CR line endings, including a CRLF split between two chunks', () => {
    const lf = 'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'
    const crlf = lf.replace(/\n/g, '\r\n')
    const cr = lf.replace(/\n/g, '\r')
    const expected = [{ event: 'a', data: '1' }, { event: 'b', data: '2' }]
    expect(decodeAll([crlf])).toEqual(expected)
    expect(decodeAll([cr])).toEqual(expected)
    for (let i = 1; i < crlf.length; i++) expect(decodeAll([crlf.slice(0, i), crlf.slice(i)])).toEqual(expected)
    // A CR as the last character is held (it may be half of a CRLF); at the end of the body a held
    // lone CR still terminated its line, so the blank line it formed dispatches the frame.
    const d = createSseDecoder()
    expect(d.push('data: z\r')).toEqual([])
    expect(d.push('\r')).toEqual([])
    expect(d.end()).toEqual([{ data: 'z' }])
  })

  test('multi-line data joins with \\n; one leading space is stripped; comments, id and retry are ignored; a BOM is dropped', () => {
    const frames = decodeAll(['﻿: a comment\nid: 7\nretry: 100\nevent: x\ndata:  two spaces\ndata:none\n\n'])
    expect(frames).toEqual([{ event: 'x', data: ' two spaces\nnone' }])
  })

  test('an event cut off by the end of the body is NEVER dispatched', () => {
    expect(decodeAll(['event: message_stop\ndata: {"type":"message_stop"}\n'])).toEqual([])
    expect(decodeAll(['event: message_stop\ndata: {"type":"message_st'])).toEqual([])
  })
})

describe('createAnthropicStreamReader — the documented text stream', () => {
  test('started, the text deltas, one usage figure; completed with facts read off the events', () => {
    const { events, verdict } = run(TEXT, 'complete', { requestId: 'req_1' })
    expect(events).toEqual([
      { type: 'started', requestId: 'req_1', messageId: 'msg_documented_stream_text_0001', servedModel: 'claude-opus-4-6' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'text-delta', index: 0, text: '!' },
      { type: 'usage', outputTokensSoFar: 15 },
    ])
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.messageId).toBe('msg_documented_stream_text_0001')
    expect(verdict.servedModel).toBe('claude-opus-4-6')
    expect(verdict.content).toEqual([{ type: 'text', text: 'Hello!' }])
    expect(verdict.stopReason.kind).toBe('end-turn')
    // Input from message_start, output from the LAST message_delta; the cache counters the stream
    // never stated are MISSING (D21), not 0-as-fact.
    expect(verdict.usage.input).toBe(25)
    expect(verdict.usage.output).toBe(15)
    expect(verdict.usage.missing).toEqual(['cacheRead', 'cacheWrite'])
    expect(verdict.toolCallFailures).toEqual([])
  })
})

describe('usage: message_delta is CUMULATIVE — the last one wins, nothing is summed', () => {
  test('three running figures 5 → 10 → 42 read as 42, never 57', () => {
    const { events, verdict } = run(sse([
      START({ input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }),
      ...TEXT_BLOCK(0, 'a'),
      DELTA('end_turn', { output_tokens: 5 }),
      { type: 'message_delta', delta: {}, usage: { output_tokens: 10 } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 42 } },
      STOP,
    ]))
    expect(events.filter(e => e.type === 'usage')).toEqual([
      { type: 'usage', outputTokensSoFar: 5 },
      { type: 'usage', outputTokensSoFar: 10 },
      { type: 'usage', outputTokensSoFar: 42 },
    ])
    if (!verdict.ok) throw new Error('expected completed')
    expect(verdict.usage).toMatchObject({ input: 100, output: 42, cacheRead: 7, cacheWrite: 3, contextTokens: 110 })
    expect(verdict.usage.missing).toBeUndefined()
    // A later delta without a stop_reason does not erase the one already stated.
    expect(verdict.stopReason.kind).toBe('end-turn')
  })

  test('a message_delta that restates the input side overrides message_start key by key', () => {
    const { verdict } = run(sse([
      START({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      DELTA('end_turn', { input_tokens: 900, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }),
      STOP,
    ]))
    if (!verdict.ok) throw new Error('expected completed')
    expect(verdict.usage).toMatchObject({ input: 900, output: 20, cacheRead: 50, cacheWrite: 0 })
  })

  test('the TTL split goes through the same fromAnthropicUsage rule as the non-streamed path', () => {
    const { verdict } = run(sse([
      START({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } }),
      DELTA('end_turn', { output_tokens: 3 }),
      STOP,
    ]))
    if (!verdict.ok) throw new Error('expected completed')
    expect(verdict.usage.cacheWriteByTtl).toEqual({ ephemeral5m: 10, ephemeral1h: 20 })
  })

  test('a stream that never states usage at all reports every counter missing, never four zeros', () => {
    const bare = { type: 'message_start', message: { id: 'msg_x', model: 'claude-served' } }
    const { verdict } = run(sse([bare, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, STOP]))
    if (!verdict.ok) throw new Error('expected completed')
    expect(verdict.usage.missing).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(verdict.usageAnomalies).toEqual(['usage-not-an-object'])
  })
})

describe('failures — never a half-completed `completed`', () => {
  test('an in-band error on a 200 (the documented overloaded_error) fails as overloaded, usage unknown', () => {
    const { events, verdict } = run(ERROR, 'complete', { requestId: 'req_e' })
    // The text that streamed before the error was shown live; the verdict still fails.
    expect(events.map(e => e.type)).toEqual(['started', 'text-delta'])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.error).toMatchObject({
      kind: 'overloaded', retryable: true, usageOutcome: 'unknown', httpStatus: 200,
      errorType: 'overloaded_error', requestId: 'req_e', requestIdSource: 'header',
    })
    expect('usage' in verdict).toBe(false)
  })

  test('an in-band error is a failure even when message_stop was never reached or came after it', () => {
    const { verdict } = run(sse([START(), { type: 'error', error: { type: 'api_error', message: 'x' } }, STOP]))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatchObject({ kind: 'api-error', httpStatus: 200, usageOutcome: 'unknown' })
  })

  test('classifyInBandError: every type the status table knows maps to its kind; an unknown type is http-other', () => {
    expect(classifyInBandError('rate_limit_error').kind).toBe('rate-limited')
    expect(classifyInBandError('invalid_request_error').kind).toBe('invalid-request')
    expect(classifyInBandError('timeout_error').kind).toBe('provider-timeout')
    const unknown = classifyInBandError('brand_new_error')
    expect(unknown).toMatchObject({ kind: 'http-other', retryable: false, errorType: 'brand_new_error', httpStatus: 200, usageOutcome: 'unknown' })
    expect(classifyInBandError(undefined)).toMatchObject({ kind: 'http-other', httpStatus: 200 })
  })

  test('a body that ends before message_stop fails as network with usage UNKNOWN — the provider may have billed it', () => {
    const cut = sse([START(), ...TEXT_BLOCK(0, 'partial'), DELTA('end_turn', { output_tokens: 9 })])
    for (const end of ['complete', 'errored'] as const) {
      const { verdict } = run(cut, end)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.error).toMatchObject({ kind: 'network', usageOutcome: 'unknown', retryable: false })
    }
  })

  test('a final frame cut mid-line (no blank line) never counts as message_stop', () => {
    const full = sse([START(), ...TEXT_BLOCK(0, 'x'), DELTA('end_turn', { output_tokens: 2 }), STOP])
    const { verdict } = run(full.slice(0, full.length - 3))
    expect(verdict.ok).toBe(false)
  })

  test('an abort before message_stop is `aborted`; after message_stop the response was received whole', () => {
    const cut = sse([START(), ...TEXT_BLOCK(0, 'x')])
    const a = run(cut, 'aborted').verdict
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error).toMatchObject({ kind: 'aborted', usageOutcome: 'unknown' })
    const whole = run(sse([START(), ...TEXT_BLOCK(0, 'x'), DELTA('end_turn', { output_tokens: 2 }), STOP]), 'aborted').verdict
    expect(whole.ok).toBe(true)
  })

  test('a frame whose data is not JSON makes the response unreadable (it might have been the usage)', () => {
    const text = sse([START(), ...TEXT_BLOCK(0, 'x')]) + 'event: message_delta\ndata: {not json\n\n' + sse([STOP])
    const { verdict } = run(text)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error.kind).toBe('response-unreadable')
  })

  test('a complete body that never began a message is unreadable, not a network failure', () => {
    const { verdict } = run('')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error.kind).toBe('response-unreadable')
  })

  test('message_stop without a readable message_start (no id) is unreadable — no made-up identity', () => {
    const { verdict } = run(sse([{ type: 'message_start', message: { model: 'm', usage: {} } }, STOP]))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error.kind).toBe('response-unreadable')
  })
})

describe('tool calls through the B2.2 assembler', () => {
  test('the documented get_weather stream: deltas as partial JSON text, one assembled tool-call', () => {
    const { events, verdict } = run(TOOL)
    const deltas = events.filter(e => e.type === 'tool-call-delta')
    expect(deltas.length).toBe(9)
    expect(deltas[1]).toEqual({ type: 'tool-call-delta', index: 1, id: 'toolu_documented_stream_0001', name: 'get_weather', partialJson: '{"location":' })
    const call = events.find(e => e.type === 'tool-call')
    expect(call).toEqual({
      type: 'tool-call', index: 1, id: 'toolu_documented_stream_0001', name: 'get_weather',
      input: { location: 'San Francisco, CA', unit: 'fahrenheit' },
    })
    // The held tool call is settled by message_delta, and emitted before its usage figure.
    const types = events.map(e => e.type)
    expect(types.indexOf('tool-call')).toBeLessThan(types.indexOf('usage'))
    if (!verdict.ok) throw new Error('expected completed')
    expect(verdict.stopReason.kind).toBe('tool-use')
    expect(verdict.content).toEqual([
      { type: 'text', text: "Okay, let's check the weather for San Francisco, CA:" },
      { type: 'tool_use', id: 'toolu_documented_stream_0001', name: 'get_weather', input: { location: 'San Francisco, CA', unit: 'fahrenheit' } },
    ])
    expect(verdict.usage).toMatchObject({ input: 472, output: 89 })
  })

  test('a tool call cut by max_tokens is FAILED (truncated) — never offered, never in content as tool_use; the invocation still completes', () => {
    const { events, verdict } = run(sse([
      START(),
      ...TOOL_BLOCK(0, ['{"location": "Lis']),
      DELTA('max_tokens', { output_tokens: 64 }),
      STOP,
    ]))
    expect(events.some(e => e.type === 'tool-call')).toBe(false)
    const failed = events.find(e => e.type === 'tool-call-failed')
    expect(failed).toEqual({ type: 'tool-call-failed', failure: expect.objectContaining({ index: 0, id: 'toolu_0', reason: 'truncated' }) })
    if (!verdict.ok) throw new Error('the response was billed; the invocation completes')
    expect(verdict.content).toEqual([{ type: 'other', rawType: 'tool_use' }])
    expect(verdict.toolCallFailures.map(f => f.reason)).toEqual(['truncated'])
    expect(verdict.usage.output).toBe(64)
  })

  test('a tool block that is NOT last is settled by the next block start — max_tokens cannot have cut it', () => {
    const { events, verdict } = run(sse([
      START(),
      ...TOOL_BLOCK(0, ['{"location":"Lisbon"}']),
      ...TEXT_BLOCK(1, 'and then the budget ran o'),
      DELTA('max_tokens', { output_tokens: 64 }),
      STOP,
    ]))
    const types = events.map(e => e.type)
    // settled on content_block_start of block 1, i.e. before block 1's text
    expect(types.indexOf('tool-call')).toBeLessThan(types.lastIndexOf('text-delta'))
    if (!verdict.ok) throw new Error('expected completed')
    expect(verdict.toolCallFailures).toEqual([])
    expect(verdict.content[0]).toEqual({ type: 'tool_use', id: 'toolu_0', name: 'get_weather', input: { location: 'Lisbon' } })
  })

  test('malformed arguments fail the CALL, not the invocation', () => {
    const { events, verdict } = run(sse([START(), ...TOOL_BLOCK(0, ['{"a": nope}']), DELTA('tool_use', { output_tokens: 3 }), STOP]))
    expect(events.find(e => e.type === 'tool-call-failed')).toMatchObject({ failure: { reason: 'malformed' } })
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.content).toEqual([{ type: 'other', rawType: 'tool_use' }])
  })

  test('a tool block that never stopped is reported by assembler.finish as truncated', () => {
    const { events, verdict } = run(sse([START(), ...TOOL_BLOCK(0, ['{"a":1'], false), DELTA('tool_use', { output_tokens: 3 }), STOP]))
    expect(events.find(e => e.type === 'tool-call-failed')).toMatchObject({ failure: { reason: 'truncated', id: 'toolu_0' } })
    if (verdict.ok) expect(verdict.content).toEqual([{ type: 'other', rawType: 'tool_use' }])
  })

  test('a failed INVOCATION emits no tool-call for a held block (nothing from a failed attempt is offered)', () => {
    const { events, verdict } = run(sse([START(), ...TOOL_BLOCK(0, ['{"a":1}'])]))
    expect(verdict.ok).toBe(false)
    expect(events.some(e => e.type === 'tool-call')).toBe(false)
  })

  test('the reader drives an injected assembler exactly: start, append per fragment, one stop with the truncation decision', () => {
    const calls: string[] = []
    const stub: ToolCallAssembler = {
      start: (i, id, name) => { calls.push(`start ${i} ${id} ${name}`) },
      append: (i, p) => { calls.push(`append ${i} ${p}`) },
      stop: (i, o): ToolCallStep => {
        calls.push(`stop ${i} ${o?.truncated === true}`)
        return { ok: true, call: { index: i, id: `toolu_${i}`, name: 'get_weather', input: {} } }
      },
      finish: (): ToolCallFailure[] => { calls.push('finish'); return [] },
    }
    run(sse([START(), ...TOOL_BLOCK(0, ['{', '}']), ...TOOL_BLOCK(1, ['{}']), DELTA('max_tokens', { output_tokens: 1 }), STOP]), 'complete', { assembler: stub })
    expect(calls).toEqual([
      'start 0 toolu_0 get_weather', 'append 0 {', 'append 0 }',
      'stop 0 false', // settled by block 1's start: not the last block
      'start 1 toolu_1 get_weather', 'append 1 {}',
      'stop 1 true', // the last block, and the response stopped on max_tokens
      'finish',
    ])
  })

  test('an assembler that throws is a defect there, never a throw here', () => {
    const throwing: ToolCallAssembler = {
      start: () => { throw new Error('boom') }, append: () => {}, stop: () => { throw new Error('boom') }, finish: () => [],
    }
    expect(() => run(sse([START(), ...TOOL_BLOCK(0, ['{}']), DELTA('tool_use', { output_tokens: 1 }), STOP]), 'complete', { assembler: throwing })).not.toThrow()
  })
})
