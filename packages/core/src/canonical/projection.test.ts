import { describe, expect, test } from 'bun:test'
import { project, type Projection } from './projection'

/**
 * A toy event and a toy projection — deliberately NOT `AnyAgentisticsEvent`. The contract this
 * file tests is generic over the event type; borrowing the real event shape would only make the
 * fixtures noisier and would couple this test to a sibling module's schedule.
 */
interface ToyEvent {
  n: number
}

interface ToyState {
  sum: number
  seen: number[]
}

interface ToyResult {
  sum: number
  seen: number[]
  count: number
}

/** Running sum + a collected list of every `n` seen — enough to exercise resumability (the sum
 *  must agree whichever way the input is sliced) and aliasing (the list must not leak the live
 *  array `finish` built it from). */
const toyProjection: Projection<ToyState, ToyResult, ToyEvent> = {
  name: 'toy-sum',
  version: 1,
  empty: () => ({ sum: 0, seen: [] }),
  fold: (state, events) => {
    for (const e of events) {
      state.sum += e.n
      state.seen.push(e.n)
    }
  },
  finish: (state) => ({ sum: state.sum, seen: [...state.seen], count: state.seen.length }),
}

function events(n: number): ToyEvent[] {
  return Array.from({ length: n }, (_, i) => ({ n: i + 1 })) // 1..n
}

describe('project()', () => {
  test('equals empty + fold + finish run by hand', () => {
    const input = events(7)

    const viaHelper = project(toyProjection, input)

    const state = toyProjection.empty()
    toyProjection.fold(state, input)
    const viaHand = toyProjection.finish(state)

    expect(viaHelper).toEqual(viaHand)
    expect(viaHelper).toEqual({ sum: 28, seen: [1, 2, 3, 4, 5, 6, 7], count: 7 })
  })

  test('empty input yields the empty state finished', () => {
    expect(project(toyProjection, [])).toEqual({ sum: 0, seen: [], count: 0 })
  })
})

describe('resumability — the property the fold/finish split exists for', () => {
  test('folding in one go equals folding in several uneven slices, over many split points', () => {
    const input = events(23) // 1..23, sum = 276

    const whole = project(toyProjection, input)

    // Try every single split point, plus a few multi-slice splits.
    for (let cut = 0; cut <= input.length; cut++) {
      const state = toyProjection.empty()
      toyProjection.fold(state, input.slice(0, cut))
      toyProjection.fold(state, input.slice(cut))
      const resumed = toyProjection.finish(state)
      expect(resumed).toEqual(whole)
    }

    // A genuinely uneven multi-slice walk (sizes 1, 4, 0, 9, rest) — the "several uneven slices"
    // case named in the brief, not just a single two-way cut.
    const slices = [input.slice(0, 1), input.slice(1, 5), input.slice(5, 5), input.slice(5, 14), input.slice(14)]
    const state = toyProjection.empty()
    for (const slice of slices) toyProjection.fold(state, slice)
    expect(toyProjection.finish(state)).toEqual(whole)
  })

  test('an empty slice anywhere in the walk changes nothing', () => {
    const input = events(5)
    const whole = project(toyProjection, input)

    const state = toyProjection.empty()
    toyProjection.fold(state, [])
    toyProjection.fold(state, input.slice(0, 2))
    toyProjection.fold(state, [])
    toyProjection.fold(state, input.slice(2))
    toyProjection.fold(state, [])
    expect(toyProjection.finish(state)).toEqual(whole)
  })
})

describe('finish() does not alias live state', () => {
  test('mutating the returned collection does not change a later finish()', () => {
    const state = toyProjection.empty()
    toyProjection.fold(state, events(3))

    const first = toyProjection.finish(state)
    first.seen.push(999) // mutate the caller's copy
    first.seen[0] = -1

    const second = toyProjection.finish(state)
    expect(second.seen).toEqual([1, 2, 3])
    expect(second).not.toEqual(first)
  })

  test('folding more after finish() does not change an earlier result', () => {
    const state = toyProjection.empty()
    toyProjection.fold(state, events(3))
    const before = toyProjection.finish(state)

    toyProjection.fold(state, events(10).slice(3)) // append 4..10
    const after = toyProjection.finish(state)

    expect(before).toEqual({ sum: 6, seen: [1, 2, 3], count: 3 })
    expect(after).toEqual({ sum: 55, seen: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], count: 10 })
    // `before` must still read as it did — it must not have been mutated by the later fold.
    expect(before).toEqual({ sum: 6, seen: [1, 2, 3], count: 3 })
  })
})

describe('name and version are exposed', () => {
  test('the projection carries its own stable name and version', () => {
    expect(toyProjection.name).toBe('toy-sum')
    expect(toyProjection.version).toBe(1)
  })

  test('project() does not need name/version to run — they are metadata for the caller, not the fold', () => {
    const bumped: Projection<ToyState, ToyResult, ToyEvent> = { ...toyProjection, version: 2 }
    expect(project(bumped, events(3))).toEqual({ sum: 6, seen: [1, 2, 3], count: 3 })
  })
})
