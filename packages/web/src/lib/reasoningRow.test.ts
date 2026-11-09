import { describe, expect, test } from 'bun:test'
import { EMPTY_REASONING_CLOCK, reasoningLabel, reasoningSpanMs, stepReasoningClock } from './reasoningRow'

describe('reasoningLabel — one line, the activity rows\' shape', () => {
  test('running reads as a gerund with the live seconds; done reads in the past', () => {
    expect(reasoningLabel(true, 12_000, true)).toBe('Raciocinando… · 12 s')
    expect(reasoningLabel(false, 12_000, true)).toBe('Raciocinou · 12 s')
    expect(reasoningLabel(true, 3_000, false)).toBe('Reasoning… · 3 s')
    expect(reasoningLabel(false, 75_000, false)).toBe('Reasoned · 1 min 15 s')
  })
  test('a span nobody observed is absent, never "0 s"', () => {
    expect(reasoningLabel(false, null, true)).toBe('Raciocinou')
    expect(reasoningLabel(true, null, false)).toBe('Reasoning…')
  })
})

describe('stepReasoningClock — measured from what the chat actually saw', () => {
  const seen = (o: Partial<{ hasReasoning: boolean; answerStarted: boolean; working: boolean; now: number }>) =>
    ({ hasReasoning: true, answerStarted: false, working: true, now: 0, ...o })
  test('starts at the first reasoning text and runs until the answer begins', () => {
    let c = stepReasoningClock(EMPTY_REASONING_CLOCK, seen({ now: 1000 }))
    expect(c).toEqual({ startedAt: 1000, endedAt: null })
    expect(reasoningSpanMs(c, 13_000)).toBe(12_000) // follows the clock while it runs
    c = stepReasoningClock(c, seen({ now: 14_000, answerStarted: true }))
    expect(c).toEqual({ startedAt: 1000, endedAt: 14_000 })
    expect(reasoningSpanMs(c, 99_000)).toBe(13_000) // frozen once over
  })
  test('the turn ending also ends it, and the end is never moved by a later look', () => {
    let c = stepReasoningClock(EMPTY_REASONING_CLOCK, seen({ now: 0 }))
    c = stepReasoningClock(c, seen({ now: 5000, working: false }))
    c = stepReasoningClock(c, seen({ now: 9000, working: false }))
    expect(c).toEqual({ startedAt: 0, endedAt: 5000 })
  })
  test('no reasoning is a new turn: the clock clears; an unchanged look returns the same object', () => {
    const c = stepReasoningClock(EMPTY_REASONING_CLOCK, seen({ now: 1 }))
    expect(stepReasoningClock(c, seen({ now: 2 }))).toBe(c)
    expect(stepReasoningClock(c, seen({ hasReasoning: false }))).toEqual(EMPTY_REASONING_CLOCK)
    expect(stepReasoningClock(EMPTY_REASONING_CLOCK, seen({ hasReasoning: false }))).toBe(EMPTY_REASONING_CLOCK)
  })
  test('a start that was never observed has no span', () => {
    expect(reasoningSpanMs(EMPTY_REASONING_CLOCK, 5000)).toBeNull()
  })
})
