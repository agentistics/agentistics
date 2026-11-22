import { afterEach, describe, expect, test } from 'bun:test'
import { setTaskRepo } from './tasks'
import { ownerProofSentence } from './ownerProof'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

interface Call { url: string; grant: string | null; body: Record<string, unknown> }

function mock(taskStatus: (n: number, grant: string | null) => { status: number; body: unknown }, vault: () => { status: number; body: unknown }): Call[] {
  const calls: Call[] = []
  let n = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    calls.push({ url, grant: headers.get('X-Agentop-Owner-Grant'), body })
    const r = url.includes('/api/vault/') ? vault() : taskStatus(++n, headers.get('X-Agentop-Owner-Grant'))
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}

describe('setTaskRepo (D7: the person writes it, with the vault grant scoped to this task)', () => {
  test('asks the vault for task-repo:<id>/edit, then repeats the SAME write with the grant in the header', async () => {
    const calls = mock(
      (n, g) => (g ? { status: 200, body: { ok: true } } : { status: 403, body: { error: 'owner_proof_required' } }),
      () => ({ status: 200, body: { ok: true, ownerGrant: 'GRANT-1' } }),
    )
    expect(await setTaskRepo('t-1', 'o/r', false)).toEqual({ ok: true })
    const vault = calls.find(c => c.url.includes('/api/vault/delivery-owner'))!
    expect(vault.body).toEqual({ pieceKey: 'task-repo:t-1', move: 'edit' })
    const writes = calls.filter(c => c.url.includes('/api/tasks/t-1'))
    expect(writes).toHaveLength(2)
    expect(writes[0]!.grant).toBeNull()
    expect(writes[1]!.grant).toBe('GRANT-1')
    expect(writes[1]!.body).toMatchObject({ repo: 'o/r' })
  })

  test('a refused vault proof surfaces a sentence and never writes', async () => {
    const calls = mock(() => ({ status: 403, body: { error: 'owner_proof_required' } }), () => ({ status: 403, body: { ok: false, code: 'presence-cancelled', sentence: 'x' } }))
    const out = await setTaskRepo('t-1', 'o/r', false)
    expect(out.ok).toBe(false)
    expect(calls.filter(c => c.url.includes('/api/tasks/t-1') && c.grant)).toHaveLength(0)
  })

  test('a person-only refusal shows the server sentence', async () => {
    mock(() => ({ status: 403, body: { error: 'repo_person_only', message: 'Only the person sets a task\'s repository, from the task screen.' } }), () => ({ status: 200, body: {} }))
    expect(await setTaskRepo('t-1', 'o/r', false)).toEqual({ ok: false, message: 'Only the person sets a task\'s repository, from the task screen.' })
  })
})

test('R3: owner_proof_unavailable / an open-vault action marks the refusal openVault; person-only does not', async () => {
  mock(() => ({ status: 403, body: { error: 'owner_proof_unavailable', message: 'open it', action: { kind: 'open-vault', path: '/vault' } } }), () => ({ status: 200, body: {} }))
  expect(await setTaskRepo('t-1', 'o/r', false)).toEqual({ ok: false, message: ownerProofSentence('owner_proof_unavailable', false), openVault: true })
  mock(() => ({ status: 403, body: { error: 'repo_person_only', message: 'no' } }), () => ({ status: 200, body: {} }))
  expect(await setTaskRepo('t-1', 'o/r', false)).toEqual({ ok: false, message: 'no' })
})

test('a vault refusal is worded in the page language, not the server sentence (the padlock does the same)', async () => {
  mock(() => ({ status: 403, body: { error: 'owner_proof_unavailable', message: 'The vault has silent protection only.', action: { kind: 'open-vault' } } }), () => ({ status: 200, body: {} }))
  const out = await setTaskRepo('t-1', 'o/r', true)
  expect(out).toEqual({ ok: false, message: ownerProofSentence('owner_proof_unavailable', true), openVault: true })
  expect(ownerProofSentence('owner_proof_unavailable', true)).not.toBe(ownerProofSentence('owner_proof_unavailable', false))
})
