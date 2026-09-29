import { describe, expect, it } from 'bun:test'
import { sessionIdentityKey } from './sessionIdentity'

describe('sessionIdentityKey', () => {
  it('prefers the conversation id, which survives a reopen', () => {
    expect(sessionIdentityKey({ id: 'agentop-123', conversationId: 'conv-abc' })).toBe('conv-abc')
  })

  it('falls back to the managed id when there is no conversation link (conversationBlind harnesses)', () => {
    expect(sessionIdentityKey({ id: 'agentop-123' })).toBe('agentop-123')
  })
})
