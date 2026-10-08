import { describe, expect, test } from 'bun:test'
import { createdByLabel, sessionParent } from './sessionParent'

const rows = [{ id: 'p', conversationId: 'cp', title: 'Leader' }]

describe('sessionParent', () => {
  test('none for a session a person started', () => expect(sessionParent({}, rows)).toBeNull())
  test('resolves by managed id or conversation id', () => {
    expect(sessionParent({ parentSessionId: 'p' }, rows)).toEqual({ id: 'p', title: 'Leader', openable: true })
    expect(sessionParent({ parentSessionId: 'cp' }, rows)?.id).toBe('p')
  })
  test('a parent that left the fleet is named by id and not openable', () => {
    const p = sessionParent({ parentSessionId: 'abcdef123456' }, rows)!
    expect(p.openable).toBe(false)
    expect(createdByLabel(p, false)).toBe('created by abcdef12')
  })
  test('label in both languages', () => {
    const p = sessionParent({ parentSessionId: 'p' }, rows)!
    expect(createdByLabel(p, true)).toBe('criada por Leader')
    expect(createdByLabel(p, false)).toBe('created by Leader')
  })
})

describe('sessionParent after the parent was reopened', () => {
  const now = [{ id: 'p2', conversationId: 'cp', title: 'Leader' }]
  test('the stored conversation id finds the new managed row even though the old managed id is gone', () => {
    const p = sessionParent({ parentSessionId: 'p1', parentConversationId: 'cp' }, now)
    expect(p).toEqual({ id: 'p2', title: 'Leader', openable: true })
  })
  test('without a conversation id the old managed id no longer resolves (legacy rows)', () => {
    expect(sessionParent({ parentSessionId: 'p1' }, now)?.openable).toBe(false)
  })
})
