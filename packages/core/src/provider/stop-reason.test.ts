import { describe, expect, it } from 'bun:test'
import { fromAnthropicStopReason, STOP_REASON_KINDS, type StopReasonKind } from './stop-reason'

describe('fromAnthropicStopReason — R12 §1.8, the seven values map one-to-one', () => {
  const table: Array<[string, Exclude<StopReasonKind, 'refusal'>]> = [
    ['end_turn', 'end-turn'],
    ['max_tokens', 'max-tokens'],
    ['stop_sequence', 'stop-sequence'],
    ['tool_use', 'tool-use'],
    ['pause_turn', 'pause-turn'],
    ['model_context_window_exceeded', 'context-window-exceeded'],
  ]

  for (const [wire, kind] of table) {
    it(`maps "${wire}" to { kind: '${kind}' }`, () => {
      expect(fromAnthropicStopReason(wire)).toEqual({ kind })
    })
  }

  it('pause_turn is its own kind, never folded into tool-use (server-tool loop continuation)', () => {
    expect(fromAnthropicStopReason('pause_turn')).not.toEqual({ kind: 'tool-use' })
  })

  it('every kind in the table is one of STOP_REASON_KINDS', () => {
    for (const [, kind] of table) {
      expect(STOP_REASON_KINDS).toContain(kind)
    }
    expect(STOP_REASON_KINDS).toContain('refusal')
  })
})

describe('fromAnthropicStopReason — refusal carries stop_details.category', () => {
  it('reads the category when stop_details.category is a string', () => {
    expect(fromAnthropicStopReason('refusal', { category: 'cyber' })).toEqual({
      kind: 'refusal',
      category: 'cyber',
    })
  })

  it('omits category when stop_details is null (the documented "populated only when refusal" case)', () => {
    expect(fromAnthropicStopReason('refusal', { category: null })).toEqual({ kind: 'refusal' })
  })

  it('omits category when stop_details is absent entirely', () => {
    expect(fromAnthropicStopReason('refusal')).toEqual({ kind: 'refusal' })
  })

  it('omits category when stop_details.category is not a string', () => {
    expect(fromAnthropicStopReason('refusal', { category: 42 })).toEqual({ kind: 'refusal' })
  })

  it('ignores stop_details on every other stop_reason', () => {
    expect(fromAnthropicStopReason('end_turn', { category: 'cyber' })).toEqual({ kind: 'end-turn' })
  })
})

describe('fromAnthropicStopReason — unknown or absent values', () => {
  it('an unrecognised string becomes other, keeping the raw value, and is specifically NOT end-turn', () => {
    const result = fromAnthropicStopReason('some_future_reason')
    expect(result).toEqual({ kind: 'other', raw: 'some_future_reason' })
    expect(result).not.toEqual({ kind: 'end-turn' })
  })

  it('null becomes other with raw: null', () => {
    expect(fromAnthropicStopReason(null)).toEqual({ kind: 'other', raw: null })
  })

  it('undefined becomes other with raw: null', () => {
    expect(fromAnthropicStopReason(undefined)).toEqual({ kind: 'other', raw: null })
  })

  it('a non-string (number) becomes other with raw: null, never coerced to a string', () => {
    expect(fromAnthropicStopReason(7)).toEqual({ kind: 'other', raw: null })
  })

  it('never throws on any input shape', () => {
    for (const input of [null, undefined, 7, {}, [], 'end_turn', 'garbage']) {
      expect(() => fromAnthropicStopReason(input)).not.toThrow()
    }
  })
})
