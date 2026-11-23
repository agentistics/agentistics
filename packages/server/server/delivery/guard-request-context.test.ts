/**
 * S2c.1 — the REST door builds its `GuardContext` from a VERIFIED session claim only.
 *
 * `body.session` is a claim. A session principal exists only when the token proves it; a claim that does not prove itself
 * is refused 403 and never degrades to the person's (unattributed) context. No claim = the person's own request.
 */
import { describe, expect, test } from 'bun:test'
import { guardContextOfRequest } from './request-deps'

const verify = async (id: unknown, token: unknown) => (id === 's1' && token === 'good' ? 's1' : null)

describe('guardContextOfRequest', () => {
  test('a real session (id + proving token) gets a session principal', async () => {
    const out = await guardContextOfRequest({ session: { id: 's1', token: 'good' } }, { verify })
    expect(out).toEqual({ ok: true, ctx: { principal: { kind: 'session', id: 's1', via: 'token' } } })
  })

  test('a forged session (right id, wrong token) gets NO session principal: refused 403', async () => {
    const out = await guardContextOfRequest({ session: { id: 's1', token: 'forged' } }, { verify })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reply.status).toBe(403)
  })

  test('a claim with no token, or a non-object claim, is refused too', async () => {
    for (const session of [{ id: 's1' }, { id: 'someone-else', token: 'good' }, 'not-an-object', 7]) {
      const out = await guardContextOfRequest({ session }, { verify })
      expect(out.ok).toBe(false)
    }
  })

  test('no claim at all is the person\'s own request: unattributed', async () => {
    for (const body of [{}, { session: null }, { session: undefined }]) {
      expect(await guardContextOfRequest(body as never, { verify })).toEqual({ ok: true, ctx: { principal: { kind: 'unattributed' } } })
    }
  })
})
