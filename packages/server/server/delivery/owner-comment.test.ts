/**
 * ENTREGA.GARANTIDA S0d.6 (QA F6) — a comment that speaks AS THE OWNER needs the owner principal. The QA created,
 * edited and deleted "Aprovado pelo dono — pode publicar." with no proof (`tasks-writes.log`). The gate is the same
 * REST resolution as `/api/deliveries`: grant → session → (legacy only) the browser shape → unattributed.
 */
import { describe, expect, test } from 'bun:test'
import { ownerCommentGate, type PrincipalDeps } from './web'

const SCOPE = { pieceKey: 't-1', move: 'comment:create' }
const verify = async (id: unknown, token: unknown) => (id === 'w1' && token === 'ok' ? 'w1' : null)
const deps = (mode: 'legacy' | 'required', browser: Partial<NonNullable<PrincipalDeps['browser']>> = {}, grants: Record<string, string> = {}): PrincipalDeps => ({
  verify, mode: async () => mode,
  browser: { loopbackPeer: false, originOwn: false, sameOriginFetch: false, ...browser },
  consumeGrant: (token, scope) => (grants[token] === `${scope.pieceKey}|${scope.move}` ? { ok: true, grantId: 'g' } : grants[token] ? { ok: false, code: 'grant-scope' } : { ok: false, code: 'grant-invalid' }),
})
const forgedBrowser = { originOwn: true, sameOriginFetch: true, loopbackPeer: true }

describe('owner-role comments: required mode', () => {
  test('no proof (a plain curl) → 403 owner_proof_required', async () => {
    expect(await ownerCommentGate({ owner: true, body: 'Aprovado pelo dono' }, SCOPE, deps('required'))).toMatchObject({ status: 403, body: { error: 'owner_proof_required' } })
  })
  test('forged browser headers do not stand for the owner in required', async () => {
    expect(await ownerCommentGate({ owner: true }, SCOPE, deps('required', forgedBrowser))).toMatchObject({ status: 403, body: { error: 'owner_proof_required' } })
  })
  test('a fresh vault grant for exactly this comment scope passes; another scope is refused grant_scope', async () => {
    expect(await ownerCommentGate({ owner: true }, SCOPE, deps('required', { ...forgedBrowser, grantHeader: 'G' }, { G: 't-1|comment:create' }))).toBeNull()
    expect(await ownerCommentGate({ owner: true }, { pieceKey: 'c-9', move: 'comment:remove' }, deps('required', { grantHeader: 'G' }, { G: 't-1|comment:create' })))
      .toMatchObject({ status: 403, body: { error: 'grant_scope' } })
  })
  test('a proven SESSION is never the owner (it may not edit or remove an owner comment)', async () => {
    expect(await ownerCommentGate({ session: { id: 'w1', token: 'ok' } }, { pieceKey: 'c-1', move: 'comment:edit' }, deps('required'))).toMatchObject({ status: 403, body: { error: 'so_o_dono' } })
  })
  test('a reserved actor is refused before anything else', async () => {
    expect(await ownerCommentGate({ owner: true, actor: 'flow:entrega' }, SCOPE, deps('required'))).toMatchObject({ status: 400, body: { error: 'reserved_actor' } })
  })
})

describe('owner-role comments: legacy mode (unchanged for the browser)', () => {
  test('the browser shape is the owner (legacy-browser), as before', async () => {
    expect(await ownerCommentGate({ owner: true }, SCOPE, deps('legacy', forgedBrowser))).toBeNull()
  })
  test('a request with no browser shape and no proof is not the owner → so_o_dono', async () => {
    expect(await ownerCommentGate({ owner: true }, SCOPE, deps('legacy'))).toMatchObject({ status: 403, body: { error: 'so_o_dono' } })
  })
})

describe('index.ts wires the gate on every owner-speaking comment write', () => {
  test('create (owner:true), edit/remove of an owner comment, and the thread send', async () => {
    const src = await Bun.file(new URL('../index.ts', import.meta.url)).text()
    expect(src).toContain("ownerGate(ref, 'comment:create')")
    expect(src).toMatch(/commentRole\(body\.id\) === 'owner'[\s\S]{0,200}ownerGate\(body\.id, body\.remove === true \? 'comment:remove' : 'comment:edit'\)/)
    expect(src).toContain("ownerGate(ref, 'thread:send')")
  })
})
