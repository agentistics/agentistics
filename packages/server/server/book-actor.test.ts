import { describe, expect, test } from 'bun:test'
import { bookActorFromRequest, bookRoleOf } from './book-actor'
import { roleOfRow } from './sessions/session-roles'

describe('bookRoleOf (slice 2)', () => {
  // Roles are stored under the CONVERSATION id once a session has one (`sessionIdentityKey`); looking up the
  // managed id alone read a real leader as a plain user (found by the official-binary probe).
  test('a leader whose role is keyed by its conversation id is a leader', async () => {
    const role = await bookRoleOf('m-1', {
      roles: async () => ({ ses_abc: 'leader' }),
      row: async id => (id === 'm-1' ? { id: 'm-1', conversationId: 'ses_abc' } : undefined),
      roleOfRow,
    })
    expect(role).toBe('leader')
  })

  test('a managed-id key still works, and a session with no row and no role is no one', async () => {
    const deps = { roles: async () => ({ 'm-2': 'worker' as const }), row: async () => undefined, roleOfRow }
    expect(await bookRoleOf('m-2', deps)).toBe('worker')
    expect(await bookRoleOf('m-3', deps)).toBeUndefined()
  })
})

const deps = (verified: string | null, role: 'leader' | 'worker' | undefined = undefined) => ({
  verify: async () => verified,
  roleOf: async () => role,
})

describe('bookActorFromRequest', () => {
  test('a request with no session proof is an unverified local user, never the owner', async () => {
    const actor = await bookActorFromRequest(new Request('http://localhost/api/book/page/x'), deps('anyone', 'leader'))
    expect(actor).toEqual({ id: 'localShell', verified: false, role: 'user' })
  })

  test('ignores a forged actor in the body and marks an invalid session unverified', async () => {
    const req = new Request('http://localhost/api/book/correct', {
      method: 'POST',
      body: JSON.stringify({ actor: { id: 'owner', verified: true, role: 'owner' }, session: { id: 'fake', token: 'fake' } }),
      headers: { 'content-type': 'application/json', 'x-agentistics-actor': 'owner' },
    })
    const actor = await bookActorFromRequest(req, deps(null))
    expect(actor).toEqual({ id: 'localShell', verified: false, role: 'user' })
  })

  test('uses the managed session id and stored role only after a valid proof', async () => {
    const req = new Request('http://localhost/api/book/correct', {
      method: 'POST',
      body: JSON.stringify({ session: { id: 'managed-1', token: 'valid' } }),
      headers: { 'content-type': 'application/json' },
    })
    const actor = await bookActorFromRequest(req, deps('managed-1', 'leader'))
    expect(actor).toEqual({ id: 'managed-1', verified: true, role: 'leader' })
  })

  test('accepts the established proof in headers without trusting actor-shaped headers', async () => {
    const req = new Request('http://localhost/api/book/page/x', {
      headers: {
        'x-agentistics-session-id': 'managed-2',
        'x-agentistics-session-token': 'valid',
        'x-agentistics-actor': 'owner',
      },
    })
    const actor = await bookActorFromRequest(req, deps('managed-2', 'worker'))
    expect(actor).toEqual({ id: 'managed-2', verified: true, role: 'worker' })
  })
})
