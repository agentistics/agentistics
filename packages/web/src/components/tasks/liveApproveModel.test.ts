import { describe, expect, test } from 'bun:test'
import { approveSentence } from './liveApproveModel'

describe('approve sentence', () => {
  test('names the phase the delivery wants to enter, in both languages', () => {
    expect(approveSentence('pr_merge', true)).toContain('PR e merge')
    expect(approveSentence('revisao_lider', false)).toBe('Needs your approval to enter the leader review.')
  })
  test('an unknown phase is named as it is', () => {
    expect(approveSentence('auditoria', false)).toContain('auditoria')
  })
})
