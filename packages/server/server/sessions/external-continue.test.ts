import { describe, expect, test } from 'bun:test'
import { isExternalRowId, planContinueHere } from './external-continue'

describe('planContinueHere — writing to an external session (EXT.OPEN)', () => {
  test('an exact conversation on a resumable harness: ask ONCE, then continue', () => {
    expect(planContinueHere({ conversationId: 'c-1', resumable: true, confirmed: false })).toEqual({ kind: 'confirm' })
    expect(planContinueHere({ conversationId: 'c-1', resumable: true, confirmed: true })).toEqual({ kind: 'continue', conversationId: 'c-1' })
  })
  test('no exact conversation, or a harness that cannot resume by id: refused, stays read-only — even when confirmed', () => {
    expect(planContinueHere({ conversationId: undefined, resumable: true, confirmed: true })).toEqual({ kind: 'refuse', reason: 'no-conversation' })
    expect(planContinueHere({ conversationId: 'c-1', resumable: false, confirmed: true })).toEqual({ kind: 'refuse', reason: 'not-resumable' })
  })
  test('the row kind is read off the id', () => {
    expect(isExternalRowId('external:claude:c-1')).toBe(true)
    expect(isExternalRowId('agentop-1')).toBe(false)
    expect(isExternalRowId('closed:c-1')).toBe(false)
  })
})
