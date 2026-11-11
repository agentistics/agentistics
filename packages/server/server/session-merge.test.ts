import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { sessionKey } from './session-merge'

const row = (o: Partial<SessionMeta>): SessionMeta => ({ session_id: 's1', ...o }) as SessionMeta

describe('sessionKey', () => {
  it('includes the harness, so an id never collides across harnesses', () => {
    expect(sessionKey(row({ harness: 'codex' }))).toBe('codex:s1')
    expect(sessionKey(row({ harness: 'claude' }))).not.toBe(sessionKey(row({ harness: 'codex' })))
  })

  it('reads a row with no harness as claude', () => {
    expect(sessionKey(row({}))).toBe('claude:s1')
  })
})
