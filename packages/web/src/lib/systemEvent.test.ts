import { describe, expect, test } from 'bun:test'
import { parseSystemEvent, systemEventLine } from './systemEvent'

describe('parseSystemEvent', () => {
  test('agentistics headers', () => {
    expect(parseSystemEvent('[from agentistics · away]\nAway off')).toEqual({ kind: 'away', body: 'Away off' })
    expect(parseSystemEvent('[from agentistics · question]\nhand off?')?.kind).toBe('question')
  })
  test('session headers carry the sender', () => {
    expect(parseSystemEvent('[from session child-1 · handback]\ndone')).toEqual({ kind: 'handback', sender: 'child-1', body: 'done' })
    expect(parseSystemEvent('[from session ab12 · block]\nx')?.kind).toBe('block')
    expect(parseSystemEvent('[from session ab12 · question]\nx')?.kind).toBe('session-question')
  })
  test('ordinary text and unknown kinds are not events', () => {
    expect(parseSystemEvent('hello [from agentistics · away]')).toBeNull()
    expect(parseSystemEvent('[from agentistics · nope]\nx')).toBeNull()
    expect(parseSystemEvent('[from session a · nope]\nx')).toBeNull()
  })
  test('lines are localized', () => {
    const e = parseSystemEvent('[from session s1 · block]\nx')!
    expect(systemEventLine(e, true)).toBe('Sessão s1 está bloqueada')
    expect(systemEventLine(e, false, 'Title')).toBe('Session Title is blocked')
  })
})
