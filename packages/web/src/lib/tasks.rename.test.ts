/**
 * eg-integ r3 B1 / W3b — the board's Rename and "open a topic" through the REAL web functions, with a stubbed server:
 * legacy answers 200 to the web's payload (2.212.0), required asks the owner's proof and repeats with the grant,
 * and a refusal is announced (never silent). (No `mock.module`: bun applies it to every file in the run.)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { editRefusalNotice, editTask, openThread } from './tasks'
import { readNotifications } from './notifications'

type Call = { url: string; body: Record<string, unknown>; grant: string | null }
let calls: Call[] = []
const realFetch = globalThis.fetch
function serve(handler: (c: Call) => { status: number; body: unknown }) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const c: Call = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')), grant: new Headers(init?.headers).get('x-agentop-owner-grant') }
    calls.push(c)
    const r = c.url.includes('/api/vault/delivery-owner') ? { status: 200, body: { ok: true, ownerGrant: 'GRANT-1' } } : handler(c)
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as unknown as typeof fetch
}
beforeEach(() => { calls = [] })
afterEach(() => { globalThis.fetch = realFetch })

describe('Rename (editTask with actor "you")', () => {
  test('legacy: the web payload goes through once and is accepted', async () => {
    serve(() => ({ status: 200, body: { ok: true } }))
    expect(await editTask('t-1', { title: 'New', actor: 'you' } as never)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toMatchObject({ title: 'New', actor: 'you' })
  })
  test('required: 403 owner_proof_required → asks the vault → the SAME request is repeated with the grant', async () => {
    serve(c => (c.grant ? { status: 200, body: { ok: true } } : { status: 403, body: { error: 'owner_proof_required' } }))
    expect(await editTask('t-1', { title: 'New', actor: 'you' } as never)).toBe(true)
    expect(calls.map(c => c.grant)).toEqual([null, null, 'GRANT-1'])
    expect(calls[1]!.url).toContain('/api/vault/delivery-owner')
    expect(calls[1]!.body).toEqual({ pieceKey: 't-1', move: 'task:write' })
    expect(calls[2]!.body).toMatchObject({ title: 'New', actor: 'you' })
  })
  test('a refused or unreachable write returns false (the caller announces it)', async () => {
    serve(() => ({ status: 403, body: { error: 'so_o_dono', sentence: 'only the owner may do this' } }))
    expect(await editTask('t-1', { title: 'New', actor: 'you' } as never)).toBe(false)
    globalThis.fetch = (async () => { throw new Error('down') }) as unknown as typeof fetch
    expect(await editTask('t-1', { title: 'New' })).toBe(false)
  })
  test('r4 Q4: a refused editTask shows the error toast through the real notification store (never silent)', async () => {
    serve(() => ({ status: 403, body: { error: 'so_o_dono', sentence: 'only the owner may do this' } }))
    const before = readNotifications().length
    expect(await editTask('t-1', { title: 'New', actor: 'you' } as never)).toBe(false)
    const shown = readNotifications()
    expect(shown.length).toBe(before + 1)
    expect(shown[0]).toMatchObject({ type: 'error' })
    expect(shown[0]!.title).toMatch(/could not be saved|Não foi possível salvar/)
  })
  test('the refusal toast says what happened, in both languages', () => {
    expect(editRefusalNotice({ status: 403, body: { error: 'reserved_actor' } }, false)).toMatchObject({ type: 'error', title: 'The change could not be saved' })
    expect(editRefusalNotice({ status: 400, body: { error: 'reserved_actor' } }, true).message).toContain('decididos pelo agentistics')
    expect(editRefusalNotice({ status: 422, body: { sentence: 'nope' } }, false).message).toBe('nope')
    expect(editRefusalNotice(null, true).message).toBe('Sem resposta do servidor.')
  })
})

describe('openThread (W3b)', () => {
  test('sends owner:true and, in required, repeats with the thread:open grant', async () => {
    serve(c => (c.grant ? { status: 200, body: { ok: true, thread: { id: 'th-1' } } } : { status: 403, body: { error: 'owner_proof_required' } }))
    const r = await openThread('t-1', 'A topic')
    expect(r.ok).toBe(true)
    expect(calls[0]!.body).toMatchObject({ action: 'open', author: 'you', owner: true })
    expect(calls[1]!.body).toEqual({ pieceKey: 't-1', move: 'thread:open' })
  })
  test('a refusal comes back as ok:false with its sentence', async () => {
    serve(() => ({ status: 422, body: { ok: false, reason: 'x', message: 'nope' } }))
    expect(await openThread('t-1', 'A topic')).toMatchObject({ ok: false, message: 'nope' })
  })
})
