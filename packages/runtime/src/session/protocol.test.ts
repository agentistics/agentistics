import { describe, expect, test } from 'bun:test'
import {
  MAX_ANSWER_TEXT_LEN,
  MAX_CHOICE,
  MAX_CLIENT_REF_LEN,
  MAX_INBOUND_FRAME_BYTES,
  MAX_INPUT_TEXT_LEN,
  MAX_QUESTION_ID_LEN,
  MAX_RUN_ID_LEN,
  parseInboundFrame,
  textDeltaFromProviderEvent,
} from './protocol.ts'
import type { ProviderStreamEvent } from '../provider/client.ts'

describe('parseInboundFrame', () => {
  test('accepts a well-formed input frame', () => {
    const r = parseInboundFrame(JSON.stringify({ kind: 'input', clientRef: 'c1', text: 'hello' }))
    expect(r).toEqual({ ok: true, frame: { kind: 'input', clientRef: 'c1', text: 'hello' } })
  })

  test('accepts a well-formed answer frame with a choice', () => {
    const r = parseInboundFrame(JSON.stringify({ kind: 'answer', questionId: 'q1', choice: 2 }))
    expect(r).toEqual({ ok: true, frame: { kind: 'answer', questionId: 'q1', choice: 2 } })
  })

  test('accepts a well-formed answer frame with free text', () => {
    const r = parseInboundFrame(JSON.stringify({ kind: 'answer', questionId: 'q1', text: 'yes please' }))
    expect(r).toEqual({ ok: true, frame: { kind: 'answer', questionId: 'q1', text: 'yes please' } })
  })

  test('accepts a cancel frame with and without a runId', () => {
    expect(parseInboundFrame(JSON.stringify({ kind: 'cancel' }))).toEqual({
      ok: true,
      frame: { kind: 'cancel' },
    })
    expect(parseInboundFrame(JSON.stringify({ kind: 'cancel', runId: 'run_1' }))).toEqual({
      ok: true,
      frame: { kind: 'cancel', runId: 'run_1' },
    })
  })

  test('rejects an oversized raw message before parsing it', () => {
    const huge = 'x'.repeat(MAX_INBOUND_FRAME_BYTES + 1)
    const r = parseInboundFrame(huge)
    expect(r).toEqual({ ok: false, reason: 'oversized' })
  })

  test('rejects malformed JSON', () => {
    expect(parseInboundFrame('{not json')).toEqual({ ok: false, reason: 'bad-json' })
  })

  test('rejects a JSON value that is not a plain object', () => {
    expect(parseInboundFrame('[]')).toEqual({ ok: false, reason: 'bad-frame' })
    expect(parseInboundFrame('null')).toEqual({ ok: false, reason: 'bad-frame' })
    expect(parseInboundFrame('"hello"')).toEqual({ ok: false, reason: 'bad-frame' })
  })

  test('rejects an unknown kind', () => {
    const r = parseInboundFrame(JSON.stringify({ kind: 'teleport' }))
    expect(r).toEqual({ ok: false, reason: 'unknown-kind' })
  })

  test('rejects an input frame missing clientRef or text', () => {
    expect(parseInboundFrame(JSON.stringify({ kind: 'input', text: 'hi' }))).toEqual({
      ok: false,
      reason: 'missing-client-ref',
    })
    expect(parseInboundFrame(JSON.stringify({ kind: 'input', clientRef: 'c1' }))).toEqual({
      ok: false,
      reason: 'empty-text',
    })
    expect(parseInboundFrame(JSON.stringify({ kind: 'input', clientRef: 'c1', text: '' }))).toEqual({
      ok: false,
      reason: 'empty-text',
    })
  })

  test('rejects an input frame over the size bounds', () => {
    const longRef = 'r'.repeat(MAX_CLIENT_REF_LEN + 1)
    expect(
      parseInboundFrame(JSON.stringify({ kind: 'input', clientRef: longRef, text: 'hi' })),
    ).toEqual({ ok: false, reason: 'client-ref-too-long' })

    const longText = 't'.repeat(MAX_INPUT_TEXT_LEN + 1)
    expect(
      parseInboundFrame(JSON.stringify({ kind: 'input', clientRef: 'c1', text: longText })),
    ).toEqual({ ok: false, reason: 'text-too-long' })
  })

  test('rejects an answer frame with a bad choice', () => {
    expect(
      parseInboundFrame(JSON.stringify({ kind: 'answer', questionId: 'q1', choice: -1 })),
    ).toEqual({ ok: false, reason: 'bad-choice' })
    expect(
      parseInboundFrame(JSON.stringify({ kind: 'answer', questionId: 'q1', choice: 1.5 })),
    ).toEqual({ ok: false, reason: 'bad-choice' })
    expect(
      parseInboundFrame(JSON.stringify({ kind: 'answer', questionId: 'q1', choice: MAX_CHOICE + 1 })),
    ).toEqual({ ok: false, reason: 'bad-choice' })
  })

  test('rejects an answer frame missing questionId or over its size bounds', () => {
    expect(parseInboundFrame(JSON.stringify({ kind: 'answer', choice: 0 }))).toEqual({
      ok: false,
      reason: 'missing-question-id',
    })
    const longId = 'q'.repeat(MAX_QUESTION_ID_LEN + 1)
    expect(parseInboundFrame(JSON.stringify({ kind: 'answer', questionId: longId }))).toEqual({
      ok: false,
      reason: 'question-id-too-long',
    })
    const longAnswer = 'a'.repeat(MAX_ANSWER_TEXT_LEN + 1)
    expect(
      parseInboundFrame(JSON.stringify({ kind: 'answer', questionId: 'q1', text: longAnswer })),
    ).toEqual({ ok: false, reason: 'answer-text-too-long' })
  })

  test('rejects a cancel frame whose runId is over its size bound or the wrong type', () => {
    const longRunId = 'r'.repeat(MAX_RUN_ID_LEN + 1)
    expect(parseInboundFrame(JSON.stringify({ kind: 'cancel', runId: longRunId }))).toEqual({
      ok: false,
      reason: 'run-id-too-long',
    })
    expect(parseInboundFrame(JSON.stringify({ kind: 'cancel', runId: 42 }))).toEqual({
      ok: false,
      reason: 'bad-frame',
    })
  })

  test('never throws on adversarial input', () => {
    const inputs = ['', '{}', '   ', '{"kind":1}', JSON.stringify({ kind: 'input', clientRef: 1, text: 1 })]
    for (const raw of inputs) {
      expect(() => parseInboundFrame(raw)).not.toThrow()
    }
  })
})

describe('textDeltaFromProviderEvent', () => {
  test('extracts text from a text-delta event', () => {
    const e: ProviderStreamEvent = { type: 'text-delta', index: 0, text: 'hi' }
    expect(textDeltaFromProviderEvent(e)).toBe('hi')
  })

  test('yields null for every other event kind', () => {
    const events: ProviderStreamEvent[] = [
      { type: 'started' },
      { type: 'tool-call-delta', index: 0, id: 't1', name: 'foo', partialJson: '{' },
      { type: 'tool-call', index: 0, id: 't1', name: 'foo', input: {} },
      { type: 'usage', outputTokensSoFar: 3 },
    ]
    for (const e of events) expect(textDeltaFromProviderEvent(e)).toBeNull()
  })
})
