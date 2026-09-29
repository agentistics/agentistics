import { describe, expect, test } from 'bun:test'
import { emptyClaudeParse, foldClaudeParse, iterLines, type ClaudeParseState } from '../../jsonl'

/**
 * `foldClaudeParse`'s optional third parameter (`sink`) is an OBSERVER: it must see exactly what
 * the walk parsed, once per line, and it must be able to do NOTHING to the walk's own result —
 * not even by throwing on every call. This is what lets `replay.ts` ride the same pass `jsonl.ts`
 * already makes over a transcript instead of re-`JSON.parse`-ing it a second time.
 */

const LINE_1 = JSON.stringify({
  type: 'user', cwd: '/home/u/app', timestamp: '2026-08-01T10:00:00.000Z',
  message: { role: 'user', content: 'hello there' },
})
const LINE_2 = JSON.stringify({
  type: 'assistant', timestamp: '2026-08-01T10:00:05.000Z',
  message: {
    id: 'm1', role: 'assistant', model: 'claude-opus-4-6',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/home/u/app/a.ts' } }],
  },
})
const LINE_3 = JSON.stringify({
  type: 'user', cwd: '/home/u/app', timestamp: '2026-08-01T10:00:09.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
})

// A blank line in the middle: it must consume a line number (so later lines still line up with
// `sed -n <lineNo>p`) but must never reach the sink — there is no entry to hand it.
const TRANSCRIPT = [LINE_1, '', LINE_2, LINE_3].join('\n')

/** Deep-equality that treats a `Map`/`Set` by its entries, the same trick `transcript-state.test.ts`
 *  uses for the same reason: `toEqual` alone can be surprised by two structurally-identical but
 *  not-reference-equal container instances depending on the runner. */
function plain(state: ClaudeParseState): unknown {
  return JSON.parse(JSON.stringify(state, (_k, v) => {
    if (v instanceof Map) return [...v.entries()]
    if (v instanceof Set) return [...v]
    return v
  }))
}

describe('foldClaudeParse sink', () => {
  test('no sink, a recording sink, and a throwing sink all fold the SAME state', () => {
    const withoutSink = emptyClaudeParse()
    foldClaudeParse(withoutSink, iterLines(TRANSCRIPT))

    const seen: Array<{ lineNo: number; type: unknown }> = []
    const withRecordingSink = emptyClaudeParse()
    foldClaudeParse(withRecordingSink, iterLines(TRANSCRIPT), (entry, lineNo) => {
      seen.push({ lineNo, type: entry.type })
    })

    const withThrowingSink = emptyClaudeParse()
    foldClaudeParse(withThrowingSink, iterLines(TRANSCRIPT), () => {
      throw new Error('a sink bug must never reach the walk')
    })

    // The walk's own result — every counter, every Map, every Set — is byte-identical regardless
    // of whether a sink was given at all, and regardless of what that sink did.
    expect(plain(withRecordingSink)).toEqual(plain(withoutSink))
    expect(plain(withThrowingSink)).toEqual(plain(withoutSink))

    // The recording sink saw each of the three real lines exactly once, numbered the way
    // `foldClaudeParse` numbers every raw line (1-based, blanks included) — so line 2 is the
    // blank one and is never delivered, and line 3 (the assistant entry) keeps its own number
    // rather than shifting down to fill the gap.
    expect(seen).toEqual([
      { lineNo: 1, type: 'user' },
      { lineNo: 3, type: 'assistant' },
      { lineNo: 4, type: 'user' },
    ])
  })

  test('a sink observes the SAME state across an uneven multi-chunk fold as it does in one pass', () => {
    // Mirrors `foldClaudeParse`'s own resumability contract (CLAUDE.md: "A LIVE transcript is read
    // by what it has WRITTEN SINCE LAST TIME") — a sink riding that walk must see the same lines,
    // by the same numbers, whether the caller hands them over whole or in slices.
    const wholeSeen: number[] = []
    const whole = emptyClaudeParse()
    foldClaudeParse(whole, iterLines(TRANSCRIPT), (_e, lineNo) => { wholeSeen.push(lineNo) })

    const chunkedSeen: number[] = []
    const chunked = emptyClaudeParse()
    const sink = (_e: Record<string, unknown>, lineNo: number): void => { chunkedSeen.push(lineNo) }
    foldClaudeParse(chunked, iterLines([LINE_1, ''].join('\n') + '\n'), sink)
    foldClaudeParse(chunked, iterLines([LINE_2, LINE_3].join('\n')), sink)

    expect(chunkedSeen).toEqual(wholeSeen)
    expect(plain(chunked)).toEqual(plain(whole))
  })
})
