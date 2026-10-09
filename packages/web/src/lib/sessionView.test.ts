import { describe, expect, test } from 'bun:test'
import { initialSessionView } from './sessionView'

describe('initialSessionView', () => {
  test('opens on the chat by default, whatever the harness (it takes no harness at all)', () => {
    expect(initialSessionView({ requested: null })).toBe('chat')
    expect(initialSessionView({ requested: 'bogus' })).toBe('chat')
  })
  test('the terminal only when asked for', () => {
    expect(initialSessionView({ requested: 'terminal' })).toBe('terminal')
  })
  test('screenless (native / external) is always chat', () => {
    expect(initialSessionView({ requested: 'terminal', screenless: true })).toBe('chat')
  })
  test('relayed sessions have no readable chat', () => {
    expect(initialSessionView({ requested: null, relayed: true })).toBe('terminal')
  })
})
