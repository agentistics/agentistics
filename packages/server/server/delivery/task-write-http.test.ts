/**
 * eg-integ r3 B1 / W3a / W3b — the WEB's real task-write payloads through the same seam index.ts uses
 * (`screenTaskRequest` with the principal deps, `authorFieldAs`), in legacy and required mode.
 *
 * B1: the board's Rename sends `{ title, actor: 'you' }` to `POST /api/tasks/<id>`. 2.212.0 answered 200; the S0d screen
 * answered 400 `reserved_actor` in every mode and the UI swallowed it. Legacy keeps 2.212.0; required asks the owner's
 * proof (grant scoped `<ref>|task:write`) and never 400s the owner's own UI.
 */
import { describe, expect, test } from 'bun:test'
import { authorFieldAs, screenTaskRequest, taskRefOfPath } from './principal-http'
import type { PrincipalDeps } from './web'

const verify = async (id: unknown, token: unknown) => (id === 'w1' && token === 'ok' ? 'w1' : null)
const deps = (mode: 'legacy' | 'required', browser: Partial<NonNullable<PrincipalDeps['browser']>> = {}, grants: Record<string, string> = {}): PrincipalDeps => ({
  verify, mode: async () => mode,
  browser: { loopbackPeer: false, originOwn: false, sameOriginFetch: false, ...browser },
  consumeGrant: (token, scope) => (grants[token] === `${scope.pieceKey}|${scope.move}` ? { ok: true, grantId: 'g' } : grants[token] ? { ok: false, code: 'grant-scope' } : { ok: false, code: 'grant-invalid' }),
})
const WEB = { originOwn: true, sameOriginFetch: true, loopbackPeer: true }
const send = (path: string, body: unknown, d: PrincipalDeps) =>
  screenTaskRequest({ path, method: 'POST', contentType: 'application/json', text: async () => JSON.stringify(body) }, d.verify, d)

// every web call that sends actor/author to /api/tasks (audit, packages/web/src):
const RENAME = { title: 'New name', actor: 'you' } // TaskHero.tsx / TasksPage.tsx → editTask

describe('B1 rename (actor "you") — legacy', () => {
  test('the web payload is accepted as in 2.212.0, from the browser and from a non-browser caller', async () => {
    expect(await send('/api/tasks/t-1', RENAME, deps('legacy', WEB))).toBeNull()
    expect(await send('/api/tasks/t-1', RENAME, deps('legacy'))).toBeNull()
    for (const actor of ['owner', 'dono', ' You ']) expect(await send('/api/tasks/t-1', { title: 'x', actor }, deps('legacy', WEB))).toBeNull()
  })
  test('flow:* stays the engine\'s: refused 400 even in legacy; an unproven session is still 403', async () => {
    expect(await send('/api/tasks/t-1', { title: 'x', actor: 'flow:entrega' }, deps('legacy', WEB))).toMatchObject({ status: 400, body: { error: 'reserved_actor' } })
    expect(await send('/api/tasks/t-1', { title: 'x', session: { id: 'w1', token: 'bad' } }, deps('legacy', WEB))).toMatchObject({ status: 403, body: { error: 'unverified_sender' } })
  })
})

describe('B1 rename (actor "you") — required', () => {
  test('without a grant: 403 owner_proof_required (the web asks the vault and repeats), never 400', async () => {
    expect(await send('/api/tasks/t-1', RENAME, deps('required', WEB))).toMatchObject({ status: 403, body: { error: 'owner_proof_required' } })
  })
  test('with the owner\'s grant for exactly <ref>|task:write → passes', async () => {
    expect(await send('/api/tasks/t-1', RENAME, deps('required', { ...WEB, grantHeader: 'G' }, { G: 't-1|task:write' }))).toBeNull()
  })
  test('a grant for another piece is refused grant_scope', async () => {
    expect(await send('/api/tasks/t-2', RENAME, deps('required', { grantHeader: 'G' }, { G: 't-1|task:write' }))).toMatchObject({ status: 403, body: { error: 'grant_scope' } })
  })
  test('a proven session claiming "you" is not the owner → 403 so_o_dono; flow:* still 400', async () => {
    expect(await send('/api/tasks/t-1', { ...RENAME, session: { id: 'w1', token: 'ok' } }, deps('required'))).toMatchObject({ status: 403, body: { error: 'so_o_dono' } })
    expect(await send('/api/tasks/t-1', { title: 'x', actor: 'flow:x' }, deps('required', { grantHeader: 'G' }, { G: 't-1|task:write' }))).toMatchObject({ status: 400 })
  })
  test('a non-reserved actor is unaffected in both modes', async () => {
    expect(await send('/api/tasks/t-1', { title: 'x', actor: 'claude:3f5f' }, deps('required'))).toBeNull()
  })
  test('the ref is read off the path the way index.ts reads it (verb tail dropped)', () => {
    expect(taskRefOfPath('/api/tasks/t-1')).toBe('t-1')
    expect(taskRefOfPath('/api/tasks/t-1/comments')).toBe('t-1')
    expect(taskRefOfPath('/api/tasks/t%2D1/threads')).toBe('t-1')
  })
})

describe('authorFieldAs — the free-text author of comments/threads (legacy shortcut + W3a/W3b)', () => {
  const author = (raw: string, d: PrincipalDeps, known?: Parameters<typeof authorFieldAs>[3], move = 'thread:open') =>
    authorFieldAs(raw, move, 't-1', known, {}, d)

  test('legacy keeps the typed name for EVERY caller, with no grant consumed (kills "remove the legacy shortcut")', async () => {
    for (const d of [deps('legacy'), deps('legacy', WEB), deps('legacy', { grantHeader: 'G' }, { G: 'nothing|else' })])
      expect(await author('you', d)).toEqual({ ok: true, value: 'you' })
  })
  test('required, no proof → unattributed (never the owner\'s name)', async () => {
    expect(await author('you', deps('required', WEB))).toEqual({ ok: true, value: 'unattributed' })
  })
  test('W3a: required + a proven session on a thread open → the session id', async () => {
    const r = await authorFieldAs('owner', 'thread:open', 't-1', undefined, { session: { id: 'w1', token: 'ok' } }, deps('required'))
    expect(r).toEqual({ ok: true, value: 'w1' })
  })
  test('W3b: required + the owner\'s grant for thread:open → the owner keeps the name', async () => {
    const r = await authorFieldAs('you', 'thread:open', 't-1', undefined, {}, deps('required', { grantHeader: 'G' }, { G: 't-1|thread:open' }))
    expect(r).toEqual({ ok: true, value: 'you' })
  })
  test('required + flow:* is refused', async () => {
    expect(await author('flow:x', deps('required'))).toMatchObject({ ok: false, reply: { status: 400 } })
  })
})

describe('index.ts uses the seams (not inline copies)', () => {
  test('screen and author field go through principal-http', async () => {
    const src = await Bun.file(new URL('../index.ts', import.meta.url)).text()
    expect(src).toMatch(/screenTaskRequest\([\s\S]{0,400}principalDeps/)
    expect(src).toContain('taskAuthorField(') // request-deps.ts wraps authorFieldAs (r4); its HTTP test drives it
    expect(src).not.toContain('freeTextAuthorAs(text')
    expect(src).toContain('threadOpenKnown(') // the owner gate for a topic open lives in request-deps.ts (r4), driven by its HTTP test
    expect(await Bun.file(new URL('./request-deps.ts', import.meta.url)).text()).toContain("ownerGate(ref, 'thread:open')")
  })
})
