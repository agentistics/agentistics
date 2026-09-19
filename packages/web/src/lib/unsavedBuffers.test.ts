import { beforeEach, describe, expect, test } from 'bun:test'
import {
  answerUnsaved, clearUnsaved, getUnsaved, holdIfUnsaved, reportUnsaved, resetUnsaved,
} from './unsavedBuffers'

beforeEach(() => resetUnsaved())

describe('unsavedBuffers', () => {
  test('nothing reported: a drop is not held and runs at once at the caller', () => {
    let ran = 0
    expect(holdIfUnsaved('close', () => { ran++ })).toBe(false)
    expect(ran).toBe(0)
    expect(getUnsaved().question).toBeNull()
  })

  test('a dirty buffer holds the drop; discarding runs it, exactly once', () => {
    reportUnsaved('studio-1', ['src/a.ts'])
    let ran = 0
    expect(holdIfUnsaved('close', () => { ran++ })).toBe(true)
    expect(getUnsaved().question).toEqual({ cause: 'close' })
    expect(ran).toBe(0)
    answerUnsaved(true)
    expect(ran).toBe(1)
    expect(getUnsaved().question).toBeNull()
    answerUnsaved(true)
    expect(ran).toBe(1)
  })

  test('keeping editing forgets the drop — it never runs later by accident', () => {
    reportUnsaved('studio-1', ['a'])
    let ran = 0
    holdIfUnsaved('leave', () => { ran++ })
    answerUnsaved(false)
    clearUnsaved('studio-1')
    expect(ran).toBe(0)
  })

  test('a buffer saved while the question is open lets the drop happen — nothing is left to lose', () => {
    reportUnsaved('studio-1', ['a'])
    let ran = 0
    holdIfUnsaved('close', () => { ran++ })
    reportUnsaved('studio-1', [])
    expect(ran).toBe(1)
    expect(getUnsaved()).toEqual({ files: [], question: null })
  })

  test('owners are separate: one Studio unmounting does not clear what another reported', () => {
    reportUnsaved('old', ['x'])
    reportUnsaved('new', ['y'])
    clearUnsaved('old')
    expect(getUnsaved().files).toEqual(['y'])
  })

  test('a second drop while a question is pending is held and forgotten — the answer does what was ASKED', () => {
    reportUnsaved('s', ['a'])
    const calls: string[] = []
    holdIfUnsaved('leave', () => calls.push('first'))
    const snap = getUnsaved()
    expect(holdIfUnsaved('leave', () => calls.push('second'))).toBe(true)
    expect(getUnsaved()).toBe(snap)
    answerUnsaved(true)
    expect(calls).toEqual(['first'])
  })

  test('a navigation under a pending CLOSE does not turn the question into a leave', () => {
    reportUnsaved('s', ['a'])
    const calls: string[] = []
    holdIfUnsaved('close', () => calls.push('close'))
    expect(holdIfUnsaved('leave', () => calls.push('leave'))).toBe(true)
    expect(getUnsaved().question).toEqual({ cause: 'close' })
    answerUnsaved(true)
    expect(calls).toEqual(['close'])
    // Once answered, the next drop is asked on its own.
    expect(holdIfUnsaved('leave', () => calls.push('later'))).toBe(true)
    expect(getUnsaved().question).toEqual({ cause: 'leave' })
  })

  test('an unchanged report keeps the SAME object, so no consumer re-renders', () => {
    reportUnsaved('s', ['a', 'b'])
    const snap = getUnsaved()
    reportUnsaved('s', ['a', 'b'])
    expect(getUnsaved()).toBe(snap)
  })
})
