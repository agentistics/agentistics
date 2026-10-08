import { describe, expect, test } from 'bun:test'
import { callerSessionId } from './cli-session'
import { inheritedIdentity } from './reopen-inherit'
import { resolveContextParent } from './spawn-context'
import type { ManagedSession } from './types'

describe('parent of a started session', () => {
  test('recorded from AGENTOP_MANAGED_ID of the caller; absent outside a managed pane', () => {
    expect(callerSessionId({ AGENTOP_MANAGED_ID: ' agentop-abc ' })).toBe('agentop-abc')
    expect(callerSessionId({})).toBeUndefined()
    expect(callerSessionId({ AGENTOP_MANAGED_ID: '  ' })).toBeUndefined()
  })
  test('a reopen keeps the parent', () => {
    const prev = { id: 'x', harness: 'claude', cwd: '/', createdAt: '', parentSessionId: 'p1' } as ManagedSession
    expect(inheritedIdentity(prev).parentSessionId).toBe('p1')
  })
  test('context parent: empty id yields nothing, an unknown id still yields the id', async () => {
    expect(await resolveContextParent(undefined)).toEqual({})
    expect((await resolveContextParent('no-such-session')).parentId).toBe('no-such-session')
  })
})

describe('parentLinkOf', () => {
  test('records the parent\'s conversation id from the registry; unknown parent keeps the managed id only', async () => {
    const { parentLinkOf } = await import('./spawn-context')
    expect(await parentLinkOf(undefined)).toEqual({})
    expect(await parentLinkOf('no-such')).toEqual({ parentSessionId: 'no-such' })
  })
  test('a reopen keeps the parent conversation id', () => {
    const prev = { id: 'x', harness: 'claude', cwd: '/', createdAt: '', parentSessionId: 'p1', parentConversationId: 'cp' } as ManagedSession
    expect(inheritedIdentity(prev).parentConversationId).toBe('cp')
  })
})
