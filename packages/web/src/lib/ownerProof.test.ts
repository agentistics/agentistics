import { afterEach, describe, expect, test } from 'bun:test'
import { OWNER_GRANT_HEADER, needsOwnerProof, ownerMove, ownerProofSentence, postWithOwnerProof, requestOwnerGrant, type OwnerGrant } from './ownerProof'

// No `mock.module`: bun applies it to every file in the run, which would break the other suites that import vaultApi.
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

interface Seen { url: string; headers: Record<string, string>; body: unknown }
function stubFetch(replies: { status: number; body: unknown }[]): Seen[] {
  const seen: Seen[] = []
  globalThis.fetch = (async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    seen.push({ url, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined })
    const r = replies.shift()!
    return { status: r.status, json: async () => r.body } as Response
  }) as unknown as typeof fetch
  return seen
}
const grants = (g: OwnerGrant, asked: unknown[] = []) => async (pieceKey: string, move: string) => { asked.push({ pieceKey, move }); return g }

describe('owner proof from the browser', () => {
  test('the move spelling equals the server\'s (grant scope depends on it)', () => {
    expect(ownerMove('approve', 'publicado')).toBe('approve:publicado')
    expect(ownerMove('override')).toBe('override')
  })
  test('a vault grant is asked, through the vault door, for exactly this piece and move', async () => {
    const seen = stubFetch([{ status: 200, body: { ok: true, ownerGrant: 'GRANT-1' } }])
    expect(await requestOwnerGrant('s1', 'approve:ci')).toEqual({ ok: true, grant: 'GRANT-1' })
    expect(seen[0]!.url).toBe('/api/vault/delivery-owner')
    expect(seen[0]!.body).toEqual({ pieceKey: 's1', move: 'approve:ci' })
  })
  test('a plain request that succeeds never touches the vault (legacy mode keeps working as before)', async () => {
    const seen = stubFetch([{ status: 200, body: { ok: true } }])
    const asked: unknown[] = []
    const r = await postWithOwnerProof('/api/deliveries/s1', { action: 'approve' }, { pieceKey: 's1', move: 'approve:ci' }, undefined, false, grants({ ok: true, grant: 'G' }, asked))
    expect(r.status).toBe(200)
    expect(asked).toEqual([])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.headers[OWNER_GRANT_HEADER]).toBeUndefined()
  })
  test('owner_proof_required → vault proof → the SAME request repeated with the grant in the header, not the URL', async () => {
    const seen = stubFetch([{ status: 403, body: { error: 'owner_proof_required' } }, { status: 200, body: { ok: true } }])
    let proving = 0
    const asked: unknown[] = []
    const r = await postWithOwnerProof('/api/deliveries/s1', { action: 'approve', phase: 'ci' }, { pieceKey: 's1', move: 'approve:ci' }, () => { proving++ }, false, grants({ ok: true, grant: 'GRANT-1' }, asked))
    expect(r.status).toBe(200)
    expect(proving).toBe(1)
    expect(asked).toEqual([{ pieceKey: 's1', move: 'approve:ci' }])
    expect(seen[1]!.headers[OWNER_GRANT_HEADER]).toBe('GRANT-1')
    expect(seen[1]!.url).not.toContain('GRANT')
    expect(seen[1]!.body).toEqual(seen[0]!.body)
  })
  test('a refused proof stops there: the request is not repeated and the refusal is said in words', async () => {
    const seen = stubFetch([{ status: 403, body: { error: 'owner_proof_required' } }])
    const r = await postWithOwnerProof('/api/deliveries/s1', { action: 'approve' }, { pieceKey: 's1', move: 'approve:ci' }, undefined, false, grants({ ok: false, code: 'owner-proof-unavailable', sentence: '' }))
    expect(seen).toHaveLength(1)
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('owner-proof-unavailable')
    expect(r.body.sentence).toContain('silent')
  })
  test('an unrelated refusal never opens the vault', async () => {
    stubFetch([{ status: 403, body: { error: 'so_o_dono', sentence: 'only the owner' } }])
    const asked: unknown[] = []
    const r = await postWithOwnerProof('/api/deliveries/s1', {}, { pieceKey: 's1', move: 'x' }, undefined, false, grants({ ok: true, grant: 'G' }, asked))
    expect(r.body.error).toBe('so_o_dono')
    expect(asked).toEqual([])
    expect(needsOwnerProof('so_o_dono')).toBe(false)
  })
  test('every refusal code has a sentence in both languages', () => {
    for (const c of ['owner-proof-unavailable', 'locked', 'stepup-frozen', 'recovery-mode', 'owner-proof-local-only', 'presence-cancelled', 'zzz']) {
      expect(ownerProofSentence(c, true).length).toBeGreaterThan(10)
      expect(ownerProofSentence(c, false).length).toBeGreaterThan(10)
    }
  })
})
