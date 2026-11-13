import { describe, expect, test } from 'bun:test'
import { actorOf, isReservedActor, ownerMove, ownerRefusal, parseOwnerProofMode, resolveRestPrincipal, type RestFacts } from './principal'
import { browserFactsOf, originIsOwn } from './browser-facts'
import { analyzeOwnerProof } from './owner-health'
import type { HealthIssue } from '@agentistics/core'

const BROWSER = { loopbackPeer: true, originOwn: true, sameOriginFetch: true }
const facts = (o: Partial<RestFacts> = {}): RestFacts => ({ mode: 'legacy', sessionClaimed: false, sessionVerified: null, loopbackPeer: false, originOwn: false, sameOriginFetch: false, ...o })

describe('mode preference', () => {
  test('absent / junk reads as legacy; only the exact word `required` is required', () => {
    expect(parseOwnerProofMode(undefined)).toBe('legacy')
    expect(parseOwnerProofMode(null)).toBe('legacy')
    expect(parseOwnerProofMode('REQUIRED')).toBe('legacy')
    expect(parseOwnerProofMode({})).toBe('legacy')
    expect(parseOwnerProofMode('required')).toBe('required')
    expect(parseOwnerProofMode('legacy')).toBe('legacy')
  })
})

describe('reserved actors', () => {
  test.each(['you', 'owner', 'dono', 'OWNER', ' You ', 'flow:entrega', 'flow:x', 'Flow:custody'])('%s is reserved', a => expect(isReservedActor(a)).toBe(true))
  test.each(['claude:3f5f', 'w1', '', undefined, 42, 'flowing'])('%p is not', a => expect(isReservedActor(a)).toBe(false))
})

describe.each(['legacy', 'required'] as const)('REST resolution — mode %s (spec §2.3 order)', mode => {
  const legacy = mode === 'legacy'
  test('(i) no proof and no browser headers (a plain curl) is unattributed, never the owner', () => {
    const r = resolveRestPrincipal(facts({ mode }))
    expect(r).toEqual({ ok: true, principal: { kind: 'unattributed' } })
    expect(r.ok && actorOf(r.principal)).toBe('unattributed')
  })
  test.each(['you', 'owner', 'flow:entrega'])('(ii-iv) actor %s is refused reserved_actor, even with a grant or a browser', actor => {
    expect(resolveRestPrincipal(facts({ mode, actor }))).toMatchObject({ ok: false, status: 400, code: 'reserved_actor' })
    expect(resolveRestPrincipal(facts({ mode, actor, ...BROWSER, grant: { id: 'g' } }))).toMatchObject({ ok: false, code: 'reserved_actor' })
  })
  test('(v) forged browser headers: required → unattributed; legacy → owner/legacy-browser', () => {
    const r = resolveRestPrincipal(facts({ mode, ...BROWSER }))
    expect(r).toEqual({ ok: true, principal: legacy ? { kind: 'owner', via: 'legacy-browser' } : { kind: 'unattributed' } })
  })
  test('(v-remote) a browser on ANOTHER machine (tailnet; loopbackPeer false): legacy keeps approving as in 2.210.1, required refuses', () => {
    const r = resolveRestPrincipal(facts({ mode, ...BROWSER, loopbackPeer: false }))
    expect(r).toEqual({ ok: true, principal: legacy ? { kind: 'owner', via: 'legacy-browser' } : { kind: 'unattributed' } })
  })
  test.each([
    ['foreign origin', { loopbackPeer: true, originOwn: false, sameOriginFetch: true }],
    ['cross-site fetch', { loopbackPeer: true, originOwn: true, sameOriginFetch: false }],
  ])('a browser shape missing a leg (%s) is never the owner', (_n, b) => {
    expect(resolveRestPrincipal(facts({ mode, ...b }))).toEqual({ ok: true, principal: { kind: 'unattributed' } })
  })
  test('(viii) a proven session with browser headers is the session, never the owner', () => {
    expect(resolveRestPrincipal(facts({ mode, ...BROWSER, sessionClaimed: true, sessionVerified: 'w1' }))).toEqual({ ok: true, principal: { kind: 'session', id: 'w1', via: 'token' } })
  })
  test('a session proof that fails is 403 unverified_sender, headers or not', () => {
    expect(resolveRestPrincipal(facts({ mode, ...BROWSER, sessionClaimed: true }))).toMatchObject({ ok: false, status: 403, code: 'unverified_sender' })
  })
  test('a session that proves itself never becomes the owner by carrying a grant', () => {
    expect(resolveRestPrincipal(facts({ mode, sessionClaimed: true, sessionVerified: 'w1', grant: { id: 'g' } }))).toMatchObject({ principal: { kind: 'session' } })
  })
  test('a spent grant is owner/vault-credential in both modes (stronger than legacy-browser)', () => {
    expect(resolveRestPrincipal(facts({ mode, grant: { id: 'abc' } }))).toEqual({ ok: true, principal: { kind: 'owner', via: 'vault-credential', grantId: 'abc' } })
  })
})

describe('owner-only moves', () => {
  test('required: unattributed → owner_proof_required; legacy: unattributed → so_o_dono; sessions → so_o_dono; owners pass', () => {
    expect(ownerRefusal({ kind: 'unattributed' }, 'required')?.code).toBe('owner_proof_required')
    expect(ownerRefusal({ kind: 'unattributed' }, 'legacy')?.code).toBe('so_o_dono')
    expect(ownerRefusal({ kind: 'session', id: 'w', via: 'token' }, 'required')?.code).toBe('so_o_dono')
    expect(ownerRefusal({ kind: 'flow', engine: 'entrega' }, 'legacy')?.code).toBe('so_o_dono')
    expect(ownerRefusal({ kind: 'owner', via: 'legacy-browser' }, 'legacy')).toBeNull()
    expect(ownerRefusal({ kind: 'owner', via: 'vault-credential', grantId: 'g' }, 'required')).toBeNull()
  })
  test('the move spelling is shared by mint and use', () => {
    expect(ownerMove('approve', 'publicado')).toBe('approve:publicado')
    expect(ownerMove('override')).toBe('override')
    expect(ownerMove(undefined, 5)).toBe('')
  })
})

describe('browserFactsOf: what the HTTP adapter reads off a request', () => {
  const H = (h: Record<string, string>) => ({ headers: new Headers(h), method: 'POST' })
  const O = { host: 'alien-wsl.tail1.ts.net:47292', allowlist: [] as string[], dev: false }
  test('own origin + same-origin fetch from a REMOTE peer: both facts true, loopback false', () => {
    const f = browserFactsOf(H({ origin: 'http://alien-wsl.tail1.ts.net:47292', 'sec-fetch-site': 'same-origin', host: O.host }), '100.64.0.9', O)
    expect(f).toMatchObject({ originOwn: true, sameOriginFetch: true, loopbackPeer: false })
  })
  test('Sec-Fetch-Site other than same-origin (cross-site, same-site, none, absent) is not same-origin', () => {
    for (const v of ['cross-site', 'same-site', 'none', 'x']) expect(browserFactsOf(H({ origin: `http://${O.host}`, 'sec-fetch-site': v }), '100.64.0.9', O).sameOriginFetch).toBe(false)
    expect(browserFactsOf(H({ origin: `http://${O.host}` }), '100.64.0.9', O).sameOriginFetch).toBe(false)
  })
  test('the owner-grant header is passed through verbatim and only when present', () => {
    expect(browserFactsOf(H({ 'x-agentop-owner-grant': 'G' }), null, O).grantHeader).toBe('G')
    expect('grantHeader' in browserFactsOf(H({}), null, O)).toBe(false)
  })
  test('a local page: loopback peer + loopback Host + own origin', () => {
    const f = browserFactsOf(H({ origin: 'http://localhost:47292', host: 'localhost:47292', 'sec-fetch-site': 'same-origin' }), '127.0.0.1', { ...O, host: 'localhost:47292' })
    expect(f).toMatchObject({ originOwn: true, sameOriginFetch: true, loopbackPeer: true })
  })
})

describe('browser origin', () => {
  const HOST = 'alien-wsl.tail1234.ts.net:47292'
  test('the request\'s own origin counts, from this machine and from another one over the tailnet', () => {
    expect(originIsOwn('http://localhost:47292', 'localhost:47292', [], false)).toBe(true)
    expect(originIsOwn(`http://${HOST}`, HOST, [], false)).toBe(true)
    expect(originIsOwn(`https://${HOST}`, HOST, [], false)).toBe(true)
  })
  test('an allowed origin counts; a foreign, null or absent one never does', () => {
    expect(originIsOwn('https://app.example.com', HOST, ['https://app.example.com'], false)).toBe(true)
    expect(originIsOwn('http://evil.example:47292', HOST, [], false)).toBe(false)
    expect(originIsOwn('http://evil-' + HOST, HOST, [], false)).toBe(false)
    expect(originIsOwn('null', HOST, [], false)).toBe(false)
    expect(originIsOwn(null, HOST, [], false)).toBe(false)
  })
  test('the local dev origin counts only in dev', () => {
    expect(originIsOwn('http://localhost:5173', HOST, [], true)).toBe(true)
    expect(originIsOwn('http://localhost:5173', HOST, [], false)).toBe(false)
  })
})

describe('health WARN delivery-owner-unproven', () => {
  const run = (...a: Parameters<typeof analyzeOwnerProof> extends [infer M, infer V, infer F, unknown] ? [M, V, F] : never) => { const i: HealthIssue[] = []; analyzeOwnerProof(a[0], a[1], a[2], i); return i }
  test('permanent warning in legacy for every vault state, never an error; silent in required', () => {
    for (const v of ['none', 'silent-only', 'human', 'unknown'] as const) {
      const i = run('legacy', v, false)
      expect(i).toHaveLength(1)
      expect(i[0]).toMatchObject({ id: 'delivery-owner-unproven', severity: 'warning' })
    }
    expect(run('required', 'human', false)).toEqual([])
  })
  test('names the next step per vault state and the freeze', () => {
    expect(run('legacy', 'silent-only', false)[0]!.guide).toContain('password or Windows Hello')
    expect(run('legacy', 'human', false)[0]!.guide).toContain('required')
    expect(run('legacy', 'human', true)[0]!.description).toContain('frozen')
  })
})
