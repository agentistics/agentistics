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

import { sessionChildren, sessionLinks } from './sessionParent'

describe('sessionChildren / sessionLinks', () => {
  const fleet = [
    { id: 'p', conversationId: 'cp', title: 'Leader', harness: 'claude', state: 'working' as const },
    { id: 'c1', title: 'Kid', harness: 'codex', state: 'waiting' as const, parentSessionId: 'p' },
    { id: 'c2', title: 'Kid2', harness: 'claude', state: 'working' as const, parentConversationId: 'cp' },
    { id: 'x', title: 'Other', harness: 'claude', state: 'working' as const },
  ]
  test('children by managed id or conversation id', () => {
    expect(sessionChildren({ id: 'p', conversationId: 'cp' }, fleet).map(r => r.id)).toEqual(['c1', 'c2'])
    expect(sessionChildren({ id: 'x' }, fleet)).toEqual([])
  })
  test('no link at all -> null', () => expect(sessionLinks({ id: 'x' }, fleet)).toBeNull())
  test('task alone is a link', () => {
    expect(sessionLinks({ id: 'x', taskId: 't1', task: 'Do it' }, fleet)?.task).toEqual({ id: 't1', label: 'Do it' })
  })
  test('parent and children', () => {
    const l = sessionLinks({ id: 'c1', parentSessionId: 'p' }, fleet)!
    expect(l.parent?.id).toBe('p')
    expect(l.children).toEqual([])
    expect(sessionLinks({ id: 'p', conversationId: 'cp' }, fleet)?.children.length).toBe(2)
  })
})
