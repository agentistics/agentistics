import { describe, expect, it } from 'bun:test'
import { resolveUsage, dedupeUsage } from './usage-dedupe'

const u = (i: number, o: number, cr = 0, cw = 0) => ({
  input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw,
})

describe('resolveUsage', () => {
  it('counts the first sighting of an id, nothing to retract', () => {
    const seen = new Map<string, ReturnType<typeof u>>()
    expect(resolveUsage('msg_1', seen, u(10, 5))).toEqual({ replace: false })
  })

  it('a REPEAT of an id says what its earlier contribution was, so the caller can retract it', () => {
    // Measured: 148 usage lines over 79 distinct ids on one real session. A subagent transcript
    // additionally proved the repeats are not always identical — a partial usage (output_tokens 5)
    // written before the final one (276) — which is exactly the case LAST-wins exists for.
    const seen = new Map<string, ReturnType<typeof u>>()
    resolveUsage('msg_1', seen, u(100, 5))
    expect(resolveUsage('msg_1', seen, u(100, 276))).toEqual({ replace: true, previous: u(100, 5) })
    // The map now holds the NEW contribution — a third sighting retracts the second, not the first.
    expect(resolveUsage('msg_1', seen, u(100, 300))).toEqual({ replace: true, previous: u(100, 276) })
    expect(resolveUsage('msg_2', seen, u(1, 1))).toEqual({ replace: false })
  })

  it('a record with NO id is never a repeat of anything', () => {
    // What cannot be shown to be a duplicate is not one — dropping it would trade an over-count
    // for an under-count, which is the worse direction for a bill.
    const seen = new Map<string, ReturnType<typeof u>>()
    expect(resolveUsage(undefined, seen, u(1, 1))).toEqual({ replace: false })
    expect(resolveUsage(undefined, seen, u(1, 1))).toEqual({ replace: false })
    expect(resolveUsage('', seen, u(1, 1))).toEqual({ replace: false })
    expect(resolveUsage(42, seen, u(1, 1))).toEqual({ replace: false })
    expect(seen.size).toBe(0)
  })
})

describe('dedupeUsage', () => {
  it('sums one response once — the defect, in miniature', () => {
    const out = dedupeUsage([
      { id: 'msg_1', usage: u(10, 5, 100, 2) },
      { id: 'msg_1', usage: u(10, 5, 100, 2) },
      { id: 'msg_1', usage: u(10, 5, 100, 2) },
      { id: 'msg_2', usage: u(1, 1, 1, 1) },
    ])
    expect(out).toEqual(u(11, 6, 101, 3))
  })

  it('takes the LAST record for an id', () => {
    // Identical in every sample measured, so this changes nothing today — and if a partial usage
    // is ever written before the final one, the last is the complete one. Taking the first would
    // under-report exactly then.
    expect(dedupeUsage([
      { id: 'msg_1', usage: u(1, 1) },
      { id: 'msg_1', usage: u(10, 10) },
    ])).toEqual(u(10, 10))
  })

  it('keeps every anonymous record', () => {
    expect(dedupeUsage([
      { usage: u(1, 1) },
      { usage: u(2, 2) },
      { id: 'msg_1', usage: u(3, 3) },
    ])).toEqual(u(6, 6))
  })

  it('ignores a line with no usage at all', () => {
    expect(dedupeUsage([{ id: 'msg_1' }, { id: 'msg_2', usage: u(1, 1) }])).toEqual(u(1, 1))
  })
})
