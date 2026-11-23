/**
 * D7 (2026-11-21): a SESSION never writes a task's repository, through any door; the person writes it with the
 * owner's single-use vault grant scoped to ONE task. The grant here is REAL (the vault gate with fake protectors).
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Protector, ProtectorId, UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, ensureVaultOpen } from '../vault/service'
import {
  __resetGateForTests, acceptSetupCode, beginRecoveryKey, confirmRecoveryKey, consumeDeliveryGrant, enrolPresence, mintSetupCode, requireDeliveryOwner,
} from '../vault/gate'
import { __resetOwnerModeForTests } from '../delivery/owner-mode'
import { REPO_PERSON_ONLY, repoEditGate, taskRepoScope } from './task-repo-gate'
import { runTask } from './cli-task'
import { createTask } from './task-web'

const STORE = new Map<string, Uint8Array>()
function fake(id: ProtectorId): Protector {
  return {
    id, label: () => id,
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: 'x' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
  } as Protector
}
const T = 1_800_000_000_000
const clock = () => T
const S = { session: 'http:local', loopback: true }

async function vaultWithHello(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-repogate-'))
  STORE.clear()
  __resetOwnerModeForTests()
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [fake('dpapi'), fake('hello'), fake('password')], autoInit: { candidates: [fake('dpapi')] } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
  expect(await ensureVaultOpen({ create: true, migrate: false })).not.toBeNull()
  expect((await acceptSetupCode({ ...S, setupCode: mintSetupCode().code })).ok).toBe(true)
  expect(await enrolPresence('hello', { ...S, code: '000000' })).toMatchObject({ ok: true })
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  expect((await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).ok).toBe(true)
}
afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-repogate-done-')), 'vault') }) })

/** The person's grant for ONE task, minted exactly as `POST /api/vault/delivery-owner` does. */
async function mintFor(taskId: string): Promise<string> {
  const s = taskRepoScope(taskId)
  const r = await requireDeliveryOwner(S, s)
  if (!r.ok || !r.grant) throw new Error('no grant')
  return r.grant
}

const taskIdOf = async (ref: string) => (ref === 'T1' || ref === 'T2' ? ref : undefined)
const verifySession = async (id: unknown) => (id === 'lead-1' ? 'lead-1' : null)
const consume = (token: string | null, scope: { pieceKey: string; move: string }) => consumeDeliveryGrant(token, S, scope)
const gate = (over: Partial<Parameters<typeof repoEditGate>[0]> = {}) =>
  repoEditGate({ body: {}, ref: 'T1', verify: verifySession, grant: null, consume, taskIdOf, ...over })

describe('D7: who writes a task repository', () => {
  test('REST with a verified session proof: 403 repo_person_only, even carrying a valid grant (a session cannot use the person\'s)', async () => {
    await vaultWithHello()
    const g = await mintFor('T1')
    const out = await gate({ body: { session: { id: 'lead-1', token: 't' } }, grant: g })
    expect(out).toMatchObject({ status: 403, body: { error: 'repo_person_only', message: REPO_PERSON_ONLY } })
    // the grant was NOT spent by the refused session: the person can still use it
    expect(await gate({ grant: g })).toBeNull()
  })

  test('REST from inside a session with NO proof (curl, own environment/process tree): refused, there is no grant to spend', async () => {
    await vaultWithHello()
    expect(await gate()).toMatchObject({ status: 403, body: { error: 'owner_proof_required' } })
    expect(await gate({ grant: 'forged.token' })).toMatchObject({ status: 403, body: { error: 'grant_invalid' } })
    expect(await gate({ grant: '' })).toMatchObject({ status: 403 })
  })

  test('a forged session proof is refused as unverified (nothing changes)', async () => {
    expect(await gate({ body: { session: { id: 'lead-1', token: 'forged' } }, verify: async () => null })).toMatchObject({ status: 403, body: { error: 'unverified_sender' } })
  })

  test('MCP rides the same route with the session proof attached: refused with the plain sentence', async () => {
    await vaultWithHello()
    const out = await gate({ body: { session: { id: 'lead-1', token: 'mcp-proof' }, repo: 'o/r' } })
    expect(out?.body.message).toBe('Only the person sets a task\'s repository, from the task screen.')
  })

  test('CLI `agentop task edit --repo`: always refused with the same sentence, nothing written', async () => {
    const t = (await createTask({ title: `d7 cli ${Math.random().toString(36).slice(2, 8)}` }))!
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runTask(['edit', t.id, '--repo', 'o/r'])).toBe(1)
      expect(err).toHaveBeenCalledWith(REPO_PERSON_ONLY)
      const { loadTaskWorld } = await import('./task-source')
      expect((await loadTaskWorld()).book.tasks.find(x => x.id === t.id)?.repo).toBeFalsy()
    } finally { err.mockRestore() }
  })

  test('the person WITHOUT a grant is refused with the vault sentence; WITH a grant it goes through, once', async () => {
    await vaultWithHello()
    expect(await gate()).toMatchObject({ status: 403, body: { error: 'owner_proof_required' } })
    const g = await mintFor('T1')
    expect(await gate({ grant: g })).toBeNull()
    // grant reuse: refused
    expect(await gate({ grant: g })).toMatchObject({ status: 403, body: { error: 'grant_invalid' } })
  })

  test('a grant minted for another task never spends here (and is not burned by the attempt)', async () => {
    await vaultWithHello()
    const other = await mintFor('T2')
    expect(await gate({ grant: other })).toMatchObject({ status: 403, body: { error: 'grant_scope' } })
    expect(await gate({ ref: 'T2', grant: other })).toBeNull()
  })

  test('a delivery-move grant for the same piece text never stands for a repository edit', async () => {
    await vaultWithHello()
    const r = await requireDeliveryOwner(S, { pieceKey: 'T1', move: 'task:write' })
    if (!r.ok || !r.grant) throw new Error('no grant')
    expect(await gate({ grant: r.grant })).toMatchObject({ status: 403, body: { error: 'grant_scope' } })
  })

  test('off this computer (not loopback) a grant is refused; a vault with no human wrapper points at the Vault', async () => {
    await vaultWithHello()
    const g = await mintFor('T1')
    const remote = (token: string | null, scope: { pieceKey: string; move: string }) => consumeDeliveryGrant(token, { session: 'http:local', loopback: false }, scope)
    expect(await gate({ grant: g, consume: remote })).toMatchObject({ status: 403, body: { error: 'owner_proof_local_only' } })
    expect(await gate({ proofAvailable: async () => false })).toMatchObject({ status: 403, body: { error: 'owner_proof_unavailable', action: { kind: 'open-vault' } } })
  })

  test('an unknown task is not the gate\'s to answer (the write itself says 404)', async () => {
    expect(await gate({ ref: 'nope' })).toBeNull()
  })
})
