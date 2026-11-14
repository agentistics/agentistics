/**
 * §3.5.15 — the principal attacks at the REST door and the CLI door, once per `ownerProof` mode. The service is a
 * fake that records what it was asked, so each negative asserts the move NEVER reached it (nothing written).
 */
import { describe, expect, test } from 'bun:test'
import { deliveryRequest, type BrowserFacts, type DeliveryWebDeps, type GrantUse } from './web'
import type { DeliveryService } from './service'
import type { OwnerProofMode, OwnerScope } from './principal'
import { screenTaskWrite } from './principal-http'
import { resolveCliPrincipal, type CliAuth } from './cli-principal'
import { withTaskWriteProof } from '../../../mcp/session-proof'

function fake() {
  const calls: { fn: string; args: unknown[] }[] = []
  const ok = (fn: string) => async (...args: unknown[]) => { calls.push({ fn, args }); return { ok: true as const, status: 200 as const, record: { subtaskId: 's1' }, warnings: [] } }
  const svc = { list: async () => [], get: async () => null, tick: async () => ({}), reconcile: async (o: unknown, actor: string) => { calls.push({ fn: 'reconcile', args: [o, actor] }); return { ok: true, status: 200, apply: false, entries: [], moved: 0, unproven: 0 } },
    transition: ok('transition'), gate: ok('gate'), block: ok('block'), unblock: ok('unblock'), approve: ok('approve'), configure: ok('configure'), step: ok('step'), stage: ok('stage'), stageRun: ok('stageRun'), dequeue: ok('dequeue'), merge: ok('merge') } as unknown as DeliveryService
  return { svc, calls }
}
const verify = async (id: unknown, token: unknown) => (id === 'w1' && token === 'good' ? 'w1' : null)
const BROWSER: BrowserFacts = { loopbackPeer: true, originOwn: true, sameOriginFetch: true }

/** A grant store with the vault's contract: scoped, single-use. */
function grants() {
  const live = new Map<string, OwnerScope>()
  return {
    mint: (token: string, scope: OwnerScope) => live.set(token, scope),
    consume: (token: string, scope: OwnerScope): GrantUse => {
      const g = live.get(token)
      if (!g) return { ok: false, code: 'grant-invalid' }
      if (g.pieceKey !== scope.pieceKey || g.move !== scope.move) return { ok: false, code: 'grant-scope' }
      live.delete(token)
      return { ok: true, grantId: 'h-' + token }
    },
  }
}

describe.each(['required', 'legacy'] as const)('§3.5.15 principal attacks at the REST door — ownerProof %s', (mode: OwnerProofMode) => {
  const legacy = mode === 'legacy'
  const deps = (svc: DeliveryService, extra: Partial<DeliveryWebDeps> = {}): DeliveryWebDeps => ({ service: svc, verify, mode: async () => mode, ...extra })
  const approve = { action: 'approve', phase: 'publicado', decision: 'approve' }

  test('(i) a plain curl approve (no session, no browser headers) is refused and never reaches the service', async () => {
    const { svc, calls } = fake()
    const r = await deliveryRequest('POST', '/api/deliveries/s1', approve, deps(svc))
    expect(r.status).toBe(403)
    expect((r.body as { error: string }).error).toBe(legacy ? 'so_o_dono' : 'owner_proof_required')
    expect(calls).toEqual([])
  })
  test.each(['you', 'owner', 'flow:entrega'])('(ii-iv) actor %s → 400 reserved_actor, nothing runs', async actor => {
    const { svc, calls } = fake()
    const r = await deliveryRequest('POST', '/api/deliveries/s1', { ...approve, actor }, deps(svc, { browser: BROWSER }))
    expect(r).toMatchObject({ status: 400, body: { error: 'reserved_actor' } })
    expect(calls).toEqual([])
  })
  test('(v) forged browser headers: required → still refused; legacy → the owner (legacy-browser)', async () => {
    const { svc, calls } = fake()
    const r = await deliveryRequest('POST', '/api/deliveries/s1', approve, deps(svc, { browser: BROWSER }))
    if (legacy) { expect(r.status).toBe(200); expect(calls.at(-1)!.fn).toBe('approve') } else { expect(r.status).toBe(403); expect((r.body as { error: string }).error).toBe('owner_proof_required'); expect(calls).toEqual([]) }
  })
  test('(v-remote) a browser on ANOTHER machine (tailnet): legacy approves as in 2.210.1; required is refused (a grant is local-only)', async () => {
    const { svc, calls } = fake()
    const r = await deliveryRequest('POST', '/api/deliveries/s1', approve, deps(svc, { browser: { ...BROWSER, loopbackPeer: false } }))
    if (legacy) { expect(r.status).toBe(200); expect(calls.at(-1)!.fn).toBe('approve') } else { expect(r.status).toBe(403); expect(calls).toEqual([]) }
  })
  test('a plain curl (no browser headers) never reads as the owner in either mode', async () => {
    const { svc, calls } = fake()
    expect((await deliveryRequest('POST', '/api/deliveries/s1', approve, deps(svc, { browser: { loopbackPeer: true, originOwn: false, sameOriginFetch: false } }))).status).toBe(403)
    expect(calls).toEqual([])
  })
  test('(vi) a valid delivery grant for exactly this move makes the owner (vault-credential) in both modes', async () => {
    const { svc, calls } = fake(); const g = grants(); g.mint('G1', { pieceKey: 's1', move: 'approve:publicado' })
    const r = await deliveryRequest('POST', '/api/deliveries/s1', approve, deps(svc, { browser: { ...BROWSER, grantHeader: 'G1' }, consumeGrant: g.consume }))
    expect(r.status).toBe(200)
    expect(calls.at(-1)!.fn).toBe('approve')
  })
  test('(vii) a grant scoped to ANOTHER piece or move is grant_scope; a spent grant is refused', async () => {
    const { svc, calls } = fake(); const g = grants()
    g.mint('G2', { pieceKey: 'other', move: 'approve:publicado' })
    const wrong = await deliveryRequest('POST', '/api/deliveries/s1', approve, deps(svc, { browser: { ...BROWSER, grantHeader: 'G2' }, consumeGrant: g.consume }))
    expect(wrong).toMatchObject({ status: 403, body: { error: 'grant_scope' } })
    g.mint('G3', { pieceKey: 's1', move: 'approve:publicado' })
    expect((await deliveryRequest('POST', '/api/deliveries/s1', approve, deps(svc, { browser: { ...BROWSER, grantHeader: 'G3' }, consumeGrant: g.consume }))).status).toBe(200)
    const reuse = await deliveryRequest('POST', '/api/deliveries/s1', approve, deps(svc, { browser: { ...BROWSER, grantHeader: 'G3' }, consumeGrant: g.consume }))
    expect(reuse).toMatchObject({ status: 403, body: { error: 'grant_invalid' } })
    expect(calls.filter(c => c.fn === 'approve')).toHaveLength(1)
  })
  test('a grant header with no consumer wired is refused, never ignored into legacy-browser', async () => {
    const { svc, calls } = fake()
    const r = await deliveryRequest('POST', '/api/deliveries/s1', approve, deps(svc, { browser: { ...BROWSER, grantHeader: 'X' } }))
    expect(r.status).toBe(403)
    expect(calls).toEqual([])
  })
  test('(viii) a session-proven request carrying browser headers and a grant is the session — refused so_o_dono, grant not spent', async () => {
    const { svc, calls } = fake(); const g = grants(); g.mint('G4', { pieceKey: 's1', move: 'approve:publicado' })
    const r = await deliveryRequest('POST', '/api/deliveries/s1', { ...approve, session: { id: 'w1', token: 'good' } }, deps(svc, { browser: { ...BROWSER, grantHeader: 'G4' }, consumeGrant: g.consume }))
    expect(r).toMatchObject({ status: 403, body: { error: 'so_o_dono' } })
    expect(calls).toEqual([])
    expect(g.consume('G4', { pieceKey: 's1', move: 'approve:publicado' }).ok).toBe(true) // still unspent
  })
  test('a session proof that fails is 403 unverified_sender', async () => {
    const { svc } = fake()
    expect((await deliveryRequest('POST', '/api/deliveries/s1', { ...approve, session: { id: 'w1', token: 'bad' } }, deps(svc, { browser: BROWSER }))).body).toMatchObject({ error: 'unverified_sender' })
  })
  test('an ordinary move by an unattributed caller is attributed `unattributed` (never `owner`) in the service', async () => {
    const { svc, calls } = fake()
    await deliveryRequest('POST', '/api/deliveries/s1', { action: 'dequeue', reason: 'x' }, deps(svc))
    expect(calls.at(-1)).toEqual({ fn: 'dequeue', args: ['s1', 'x', 'unattributed'] })
  })
})

describe('task writes — the screen before every /api/tasks handler', () => {
  test('reserved actors and unprovable sessions are refused; ordinary bodies pass', async () => {
    expect(await screenTaskWrite({ status: 'done', actor: 'owner' }, verify)).toMatchObject({ status: 400, body: { error: 'reserved_actor' } })
    expect(await screenTaskWrite({ status: 'done', actor: 'you' }, verify)).toMatchObject({ status: 400 })
    expect(await screenTaskWrite({ status: 'done', actor: 'flow:custody' }, verify)).toMatchObject({ status: 400 })
    expect(await screenTaskWrite({ status: 'done', session: { id: 'w1', token: 'bad' } }, verify)).toMatchObject({ status: 403, body: { error: 'unverified_sender' } })
    expect(await screenTaskWrite({ status: 'done', session: { id: 'w1', token: 'good' }, actor: 'claude:3f5f' }, verify)).toBeNull()
    expect(await screenTaskWrite({ title: 'x' }, verify)).toBeNull()
    expect(await screenTaskWrite(null, verify)).toBeNull()
  })
})

describe('MCP — every task write carries the session proof', () => {
  const proof = { id: 'w1', token: 'abc' }
  test('task, subtask, file writes get `session`; reads, other paths and a body that already has one do not', () => {
    for (const p of ['/api/tasks', '/api/tasks/t1', '/api/tasks/t1/subtasks', '/api/tasks/statuses', '/api/task-files/f1']) {
      expect(withTaskWriteProof('POST', p, { status: 'in_progress' }, proof)).toEqual({ status: 'in_progress', session: proof })
    }
    expect(withTaskWriteProof('GET', '/api/tasks/t1', undefined, proof)).toBeUndefined()
    expect(withTaskWriteProof('POST', '/api/preferences', { a: 1 }, proof)).toEqual({ a: 1 })
    expect(withTaskWriteProof('POST', '/api/tasks/t1', { session: { id: 'x', token: 'y' } }, proof)).toEqual({ session: { id: 'x', token: 'y' } })
    expect(withTaskWriteProof('POST', '/api/tasks/t1', { a: 1 }, undefined)).toEqual({ a: 1 })
  })
})

describe('CLI principal (§2.3): the tree proves, the env does not, --owner needs a terminal and the vault', () => {
  const auth = (o: Partial<CliAuth> = {}): CliAuth => ({ prove: async id => id === 'real', stepUp: async () => true, interactive: true, ...o })
  const scope = { pieceKey: 's1', move: 'approve:publicado' }
  test('a proven ancestor session is a session; an exported id that is not is unattributed', async () => {
    expect((await resolveCliPrincipal({ AGENTOP_MANAGED_ID: 'real' }, false, scope, auth())).principal).toEqual({ kind: 'session', id: 'real', via: 'process-tree' })
    expect((await resolveCliPrincipal({ AGENTOP_MANAGED_ID: 'forged' }, false, scope, auth())).principal).toEqual({ kind: 'unattributed' })
  })
  test('no id and no --owner is unattributed, never owner (the old "no id = owner" is gone)', async () => {
    expect((await resolveCliPrincipal({}, false, scope, auth())).principal).toEqual({ kind: 'unattributed' })
  })
  test('--owner on a terminal with the vault accepting → owner; refused proof, or no terminal → unattributed', async () => {
    expect((await resolveCliPrincipal({}, true, scope, auth())).principal).toMatchObject({ kind: 'owner', via: 'vault-credential' })
    expect((await resolveCliPrincipal({}, true, scope, auth({ stepUp: async () => false }))).principal).toEqual({ kind: 'unattributed' })
    const piped = await resolveCliPrincipal({}, true, scope, auth({ interactive: false }))
    expect(piped.principal).toEqual({ kind: 'unattributed' })
    expect(piped.note).toContain('interactive')
  })
  test('--owner inside a proven session is still the session', async () => {
    expect((await resolveCliPrincipal({ AGENTOP_MANAGED_ID: 'real' }, true, scope, auth())).principal.kind).toBe('session')
  })
})
