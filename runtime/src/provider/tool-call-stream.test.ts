/**
 * tool-call-stream.test.ts — `createToolCallAssembler` against synthetic content-block event
 * sequences shaped exactly like Anthropic's own streaming reference
 * (docs.anthropic.com/en/api/messages-streaming, "Input JSON delta"). No network, no fs.
 */
import { describe, expect, test } from 'bun:test'
import type { ProviderToolDecl } from './client.ts'
import { createToolCallAssembler, MAX_TOOL_ARGS_BYTES } from './tool-call-stream.ts'

describe('createToolCallAssembler — Anthropic docs replay', () => {
  // The exact fragment sequence from the "Input JSON delta" example in Anthropic's streaming
  // reference: a `get_weather` tool_use block whose `partial_json` arrives in four pieces, split
  // mid-object and mid-string, concatenating to `{"location": "San Francisco, CA", "unit":
  // "fahrenheit"}`.
  test('replays the get_weather example byte for byte', () => {
    const a = createToolCallAssembler()
    a.start(1, 'toolu_01T1x1fJ34qAmk2tNTrN7Up6', 'get_weather')
    a.append(1, '')
    a.append(1, '{"location": "San Fra')
    a.append(1, 'ncisco, CA", "unit": "fah')
    a.append(1, 'renheit"}')
    const step = a.stop(1)
    expect(step).toEqual({
      ok: true,
      call: {
        index: 1,
        id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
        name: 'get_weather',
        input: { location: 'San Francisco, CA', unit: 'fahrenheit' },
      },
    })
  })

  test('a tool with no arguments may stream zero input_json_delta fragments', () => {
    const a = createToolCallAssembler()
    a.start(0, 'toolu_noargs', 'ping')
    const step = a.stop(0)
    expect(step).toEqual({ ok: true, call: { index: 0, id: 'toolu_noargs', name: 'ping', input: {} } })
  })

  test('a tool with no arguments may stream a single empty-string fragment', () => {
    const a = createToolCallAssembler()
    a.start(0, 'toolu_noargs2', 'ping')
    a.append(0, '')
    const step = a.stop(0)
    expect(step).toEqual({ ok: true, call: { index: 0, id: 'toolu_noargs2', name: 'ping', input: {} } })
  })

  test('whitespace-only accumulated text is also {} — JSON never carries meaning in bare whitespace', () => {
    const a = createToolCallAssembler()
    a.start(0, 'toolu_ws', 'ping')
    a.append(0, '   \n\t')
    expect(a.stop(0)).toEqual({ ok: true, call: { index: 0, id: 'toolu_ws', name: 'ping', input: {} } })
  })
})

describe('createToolCallAssembler — awkward fragment boundaries', () => {
  test('a fragment split mid-string is still parsed correctly once concatenated', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id1', 'echo')
    // `{"text":"hello world"}` split in the middle of the string value.
    a.append(0, '{"text":"hello')
    a.append(0, ' world"}')
    expect(a.stop(0)).toEqual({ ok: true, call: { index: 0, id: 'id1', name: 'echo', input: { text: 'hello world' } } })
  })

  test('a fragment split mid-escape (inside \\u00e9) is still parsed correctly once concatenated', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id2', 'echo')
    // `{"text":"héllo"}` (JSON-escaped é) split between `\u00` and `e9llo"}`.
    a.append(0, '{"text":"h\\u00')
    a.append(0, 'e9llo"}')
    expect(a.stop(0)).toEqual({ ok: true, call: { index: 0, id: 'id2', name: 'echo', input: { text: 'héllo' } } })
  })

  test('interleaved indexes accumulate independently regardless of stop order', () => {
    const a = createToolCallAssembler()
    a.start(0, 'idA', 'toolA')
    a.start(1, 'idB', 'toolB')
    a.append(0, '{"a":')
    a.append(1, '{"b":')
    a.append(0, '1}')
    a.append(1, '2}')
    // Stop the SECOND-opened block first.
    expect(a.stop(1)).toEqual({ ok: true, call: { index: 1, id: 'idB', name: 'toolB', input: { b: 2 } } })
    expect(a.stop(0)).toEqual({ ok: true, call: { index: 0, id: 'idA', name: 'toolA', input: { a: 1 } } })
  })
})

describe('createToolCallAssembler — malformed / not-object', () => {
  test('text that is not JSON at all → malformed', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id', 'tool')
    a.append(0, '{not valid json')
    const step = a.stop(0)
    expect(step.ok).toBe(false)
    if (!step.ok) {
      expect(step.failure).toEqual({ index: 0, id: 'id', name: 'tool', reason: 'malformed', userCode: 'provider.tool_call_malformed' })
    }
  })

  for (const [label, json] of [
    ['array', '[1,2,3]'],
    ['string', '"just a string"'],
    ['null', 'null'],
    ['number', '42'],
    ['boolean', 'true'],
  ] as const) {
    test(`valid JSON that is a ${label}, not an object → not-object`, () => {
      const a = createToolCallAssembler()
      a.start(0, 'id', 'tool')
      a.append(0, json)
      const step = a.stop(0)
      expect(step.ok).toBe(false)
      if (!step.ok) {
        expect(step.failure).toEqual({ index: 0, id: 'id', name: 'tool', reason: 'not-object', userCode: 'provider.tool_call_not_object' })
      }
    })
  }
})

describe('createToolCallAssembler — truncated', () => {
  test('stop({truncated:true}) fails even when the accumulated text is otherwise malformed', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id', 'tool')
    a.append(0, '{not valid')
    const step = a.stop(0, { truncated: true })
    expect(step).toEqual({
      ok: false,
      failure: { index: 0, id: 'id', name: 'tool', reason: 'truncated', userCode: 'provider.tool_call_truncated' },
    })
  })

  test('stop({truncated:true}) fails EVEN WHEN the accumulated text happens to parse as a valid object', () => {
    // Documented decision: a max_tokens cut is a fact about the response's length budget, not about
    // this call's arguments — a coincidentally-balanced prefix is still refused.
    const a = createToolCallAssembler()
    a.start(0, 'id', 'tool')
    a.append(0, '{"a":1}')
    const step = a.stop(0, { truncated: true })
    expect(step).toEqual({
      ok: false,
      failure: { index: 0, id: 'id', name: 'tool', reason: 'truncated', userCode: 'provider.tool_call_truncated' },
    })
  })

  test('stop({truncated:false}) or an omitted opts behaves like a normal stop', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id', 'tool')
    a.append(0, '{"a":1}')
    expect(a.stop(0, { truncated: false })).toEqual({ ok: true, call: { index: 0, id: 'id', name: 'tool', input: { a: 1 } } })
  })

  test('finish() reports every block started and never stopped as truncated, sorted by index', () => {
    const a = createToolCallAssembler()
    a.start(2, 'id2', 'toolC')
    a.start(0, 'id0', 'toolA')
    a.start(1, 'id1', 'toolB')
    a.append(1, '{"x":1}') // stopped normally below — must NOT appear in finish()
    a.stop(1)
    const failures = a.finish()
    expect(failures).toEqual([
      { index: 0, id: 'id0', name: 'toolA', reason: 'truncated', userCode: 'provider.tool_call_truncated' },
      { index: 2, id: 'id2', name: 'toolC', reason: 'truncated', userCode: 'provider.tool_call_truncated' },
    ])
  })

  test('finish() on a fully-closed stream reports nothing', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id', 'tool')
    a.stop(0)
    expect(a.finish()).toEqual([])
  })
})

describe('createToolCallAssembler — unknown tool', () => {
  const tools: ProviderToolDecl[] = [
    { name: 'get_weather', inputSchema: { type: 'object', properties: { location: { type: 'string' } } } },
    { name: 'search', inputSchema: { type: 'object' } },
  ]

  test('a name not among the declared tools → unknown-tool', () => {
    const a = createToolCallAssembler(tools)
    a.start(0, 'id', 'delete_everything')
    a.append(0, '{}')
    const step = a.stop(0)
    expect(step).toEqual({
      ok: false,
      failure: { index: 0, id: 'id', name: 'delete_everything', reason: 'unknown-tool', userCode: 'provider.tool_call_unknown_tool' },
    })
  })

  test('a declared name is accepted', () => {
    const a = createToolCallAssembler(tools)
    a.start(0, 'id', 'search')
    a.append(0, '{"q":"weather"}')
    expect(a.stop(0)).toEqual({ ok: true, call: { index: 0, id: 'id', name: 'search', input: { q: 'weather' } } })
  })

  test('when tools is undefined, the unknown-tool check is skipped entirely', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id', 'anything_at_all')
    a.append(0, '{}')
    expect(a.stop(0)).toEqual({ ok: true, call: { index: 0, id: 'id', name: 'anything_at_all', input: {} } })
  })

  test('an empty tools array also skips the check — it states a closed set of zero names, not "everything unknown"', () => {
    const a = createToolCallAssembler([])
    a.start(0, 'id', 'anything_at_all')
    expect(a.stop(0)).toEqual({ ok: true, call: { index: 0, id: 'id', name: 'anything_at_all', input: {} } })
  })

  test('malformed/not-object take priority over unknown-tool', () => {
    const a = createToolCallAssembler(tools)
    a.start(0, 'id', 'delete_everything')
    a.append(0, 'not json')
    const step = a.stop(0)
    expect(step).toEqual({
      ok: false,
      failure: { index: 0, id: 'id', name: 'delete_everything', reason: 'malformed', userCode: 'provider.tool_call_malformed' },
    })
  })
})

describe('createToolCallAssembler — required-key validation is deliberately NOT done here (B3\'s job)', () => {
  test('a well-formed object missing a schema-required key still succeeds', () => {
    const tools: ProviderToolDecl[] = [
      { name: 'get_weather', inputSchema: { type: 'object', required: ['location'], properties: { location: { type: 'string' } } } },
    ]
    const a = createToolCallAssembler(tools)
    a.start(0, 'id', 'get_weather')
    a.append(0, '{}') // `location` is required and absent
    expect(a.stop(0)).toEqual({ ok: true, call: { index: 0, id: 'id', name: 'get_weather', input: {} } })
  })
})

describe('createToolCallAssembler — the memory cap', () => {
  test('accumulating exactly MAX_TOOL_ARGS_BYTES fits; one more byte tips it over and fails malformed', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id', 'tool')
    a.append(0, 'x'.repeat(MAX_TOOL_ARGS_BYTES))
    a.append(0, 'y') // now over the cap
    const step = a.stop(0)
    expect(step).toEqual({
      ok: false,
      failure: { index: 0, id: 'id', name: 'tool', reason: 'malformed', userCode: 'provider.tool_call_malformed' },
    })
  })

  test('further appends past the cap are dropped too, not merely the one that crossed it', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id', 'tool')
    a.append(0, 'x'.repeat(MAX_TOOL_ARGS_BYTES + 1))
    a.append(0, '{"a":1}') // would otherwise be perfectly valid on its own
    const step = a.stop(0)
    expect(step.ok).toBe(false)
    if (!step.ok) expect(step.failure.reason).toBe('malformed')
  })

  test('an over-cap call fails malformed even when the stop also carries truncated:true', () => {
    // Priority: bytes are already gone, so there is nothing left for the truncation question to be
    // about — the over-cap check runs first.
    const a = createToolCallAssembler()
    a.start(0, 'id', 'tool')
    a.append(0, 'x'.repeat(MAX_TOOL_ARGS_BYTES + 1))
    const step = a.stop(0, { truncated: true })
    expect(step.ok).toBe(false)
    if (!step.ok) expect(step.failure.reason).toBe('malformed')
  })

  test('a body of exactly MAX_TOOL_ARGS_BYTES total length still parses normally — the cap is exclusive', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id', 'tool')
    const padLen = MAX_TOOL_ARGS_BYTES - '{"a":""}'.length
    const text = `{"a":"${'x'.repeat(padLen)}"}`
    expect(text.length).toBe(MAX_TOOL_ARGS_BYTES)
    a.append(0, text)
    expect(a.stop(0).ok).toBe(true)
  })
})

describe('createToolCallAssembler — deterministic handling of untrusted index lifecycles', () => {
  test('a second start() on an already-open index replaces it, discarding the earlier text', () => {
    const a = createToolCallAssembler()
    a.start(0, 'first-id', 'first-tool')
    a.append(0, '{"first":true')
    a.start(0, 'second-id', 'second-tool')
    a.append(0, '{"second":true}')
    expect(a.stop(0)).toEqual({
      ok: true,
      call: { index: 0, id: 'second-id', name: 'second-tool', input: { second: true } },
    })
  })

  test('stop() on an index nothing ever started → malformed with empty id/name', () => {
    const a = createToolCallAssembler()
    const step = a.stop(7)
    expect(step).toEqual({
      ok: false,
      failure: { index: 7, id: '', name: '', reason: 'malformed', userCode: 'provider.tool_call_malformed' },
    })
  })

  test('a second stop() on an index already stopped behaves like an unknown index', () => {
    const a = createToolCallAssembler()
    a.start(0, 'id', 'tool')
    expect(a.stop(0).ok).toBe(true)
    const second = a.stop(0)
    expect(second).toEqual({
      ok: false,
      failure: { index: 0, id: '', name: '', reason: 'malformed', userCode: 'provider.tool_call_malformed' },
    })
  })

  test('append() on an index nothing started is silently dropped, never throws', () => {
    const a = createToolCallAssembler()
    expect(() => a.append(3, '{"a":1}')).not.toThrow()
    // The index still does not exist — a later start on it begins from empty text.
    a.start(3, 'id', 'tool')
    expect(a.stop(3)).toEqual({ ok: true, call: { index: 3, id: 'id', name: 'tool', input: {} } })
  })
})

describe('createToolCallAssembler — never throws on garbage input', () => {
  test('non-numeric / non-string arguments never throw and produce a total, sane result', () => {
    const a = createToolCallAssembler()
    // biome-ignore lint: deliberately adversarial, past the type system
    const garbageIndex = 'not-a-number' as any
    // biome-ignore lint: deliberately adversarial
    const garbageString = { toString: () => 'x' } as any

    expect(() => a.start(garbageIndex, garbageString, garbageString)).not.toThrow()
    expect(() => a.append(garbageIndex, garbageString)).not.toThrow()
    expect(() => a.append(0, garbageString)).not.toThrow()
    expect(() => a.append(0, null as any)).not.toThrow()
    expect(() => a.append(0, undefined as any)).not.toThrow()
    let step: unknown
    expect(() => {
      step = a.stop(garbageIndex)
    }).not.toThrow()
    expect((step as { ok: boolean }).ok).toBe(false)

    expect(() => a.stop(Number.NaN)).not.toThrow()
    expect(() => a.stop(Number.POSITIVE_INFINITY)).not.toThrow()
    expect(() => a.finish()).not.toThrow()
  })

  test('createToolCallAssembler(tools) tolerates a non-array and a garbage-filled array', () => {
    expect(() => createToolCallAssembler('not-an-array' as any)).not.toThrow()
    const a = createToolCallAssembler([null, 42, { name: 'ok_tool', inputSchema: {} }, { inputSchema: {} }] as any)
    a.start(0, 'id', 'unknown_name')
    expect(a.stop(0).ok).toBe(false) // 'ok_tool' was the only valid declared name, this isn't it
    const b = createToolCallAssembler([null, 42, { name: 'ok_tool', inputSchema: {} }, { inputSchema: {} }] as any)
    b.start(0, 'id', 'ok_tool')
    expect(b.stop(0).ok).toBe(true)
  })

  test('a NaN index passed to start() is ignored rather than corrupting the map', () => {
    const a = createToolCallAssembler()
    expect(() => a.start(Number.NaN, 'id', 'tool')).not.toThrow()
    expect(a.finish()).toEqual([])
  })
})
