/**
 * repeat-guard.test.ts — the pure fold behind the doom-loop guard (H18).
 */
import { describe, expect, test } from 'bun:test'
import {
  REPEAT_LIMIT,
  callIdentity,
  canonicalJson,
  emptyRepeatState,
  foldApproved,
  foldBreak,
  foldCall,
  foldResult,
  resultDigest,
  verdict,
  type RepeatState,
} from './repeat-guard.ts'

const A = callIdentity('shell.run', { command: 'ls', cwd: '.' })
const B = callIdentity('shell.run', { command: 'pwd' })
const R1 = resultDigest(true, 'a.txt')
const R2 = resultDigest(true, 'a.txt b.txt')

/** Fold `n` identical calls of `id`, each answered with `result`. */
function run(state: RepeatState, id: string, result: string, n: number): RepeatState {
  for (let i = 0; i < n; i++) state = foldResult(foldCall(state, id), result)
  return state
}

describe('identity', () => {
  test('reordered keys at every depth are the same call; array order is not', () => {
    expect(canonicalJson({ b: 2, a: { d: [1, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,2]},"b":2}')
    expect(callIdentity('t', { a: 1, b: { y: 2, x: 1 } })).toBe(callIdentity('t', { b: { x: 1, y: 2 }, a: 1 }))
    expect(callIdentity('t', { a: [1, 2] })).not.toBe(callIdentity('t', { a: [2, 1] }))
  })

  test('the tool name is part of the identity, and undefined members are dropped as JSON does', () => {
    expect(callIdentity('a', { x: 1 })).not.toBe(callIdentity('b', { x: 1 }))
    expect(callIdentity('t', { x: 1, y: undefined })).toBe(callIdentity('t', { x: 1 }))
  })

  test('the identity is a fixed-size digest whatever the input size (bounded memory)', () => {
    expect(callIdentity('file.write', { content: 'x'.repeat(1_000_000) })).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('fold', () => {
  test(`the ${REPEAT_LIMIT}rd identical call with identical results asks; the ones before pass`, () => {
    let s = emptyRepeatState
    for (let i = 1; i < REPEAT_LIMIT; i++) {
      s = foldCall(s, A)
      expect(verdict(s)).toBe('pass')
      s = foldResult(s, R1)
    }
    s = foldCall(s, A)
    expect(s.count).toBe(REPEAT_LIMIT)
    expect(verdict(s)).toBe('ask')
  })

  test('a different call resets the count', () => {
    let s = run(emptyRepeatState, A, R1, 2)
    s = run(s, B, R1, 1)
    s = foldCall(s, A)
    expect(s.count).toBe(1)
    expect(verdict(s)).toBe('pass')
  })

  test('a result that changed restarts the count (polling is not a loop)', () => {
    let s = run(emptyRepeatState, A, R1, 1)
    s = foldResult(foldCall(s, A), R2)
    expect(s.count).toBe(1)
    s = foldCall(s, A)
    expect(verdict(s)).toBe('pass')
    s = foldResult(s, R2)
    s = foldCall(s, A)
    expect(verdict(s)).toBe('ask')
  })

  test('a person allowing the repeat starts a new run from that call', () => {
    let s = run(emptyRepeatState, A, R1, 2)
    s = foldApproved(foldCall(s, A))
    expect(s.count).toBe(1)
    s = foldResult(s, R1)
    s = foldResult(foldCall(s, A), R1)
    expect(verdict(foldCall(s, A))).toBe('ask')
  })

  test('a call answered without the gate breaks the run', () => {
    const s = foldCall(foldBreak(), A)
    expect(s.count).toBe(1)
  })

  test('the state holds only the last identity, its count and its last result', () => {
    const s = run(emptyRepeatState, A, R1, 2)
    expect(Object.keys(s).sort()).toEqual(['count', 'last', 'lastResult'])
  })
})
