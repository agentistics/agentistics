/**
 * ENTREGA.GARANTIDA §2.3.1 — the owner's fresh proof. Fake protectors (a silent dpapi, a counting hello, a fake
 * vault password) and a fake clock; nothing is spawned and no real credential exists in this file.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFileSync } from 'node:fs'
import { mkdtemp as mkdtempP } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Protector, ProtectorId, UnwrapResult } from '@agentistics/vault'
import {
  __resetVaultForTests, __setVaultClockForTests, ensureVaultOpen, lockVault, unlockWithGesture, vaultDir, vaultStatus,
} from './service'
import {
  ACTION_KIND_OF, REMOTE_ROWS, VAULT_ACTION_ROWS, __resetGateForTests, acceptSetupCode, beginRecoveryKey, confirmRecoveryKey, consumeDeliveryGrant,
  enrolPresence, grantValid, mintGrant, mintSetupCode, ownerProofAvailable, recoverWithWords, requireDeliveryOwner, requireVaultStepUp, rowFor, setAuthPolicy,
  setOwnerProofMode, deliveryGrantHash,
} from './gate'
import { currentVaultPassword, withVaultPassword } from './password-context'
import { readOwnerProofMode } from '../delivery/owner-mode'
import { randomBytes } from 'node:crypto'

void mkdtemp

// ── fakes ─────────────────────────────────────────────────────────────────────────────────────
const STORE = new Map<string, Uint8Array>()
const PW = 'Zq-r8!kLm2Pw'
function fake(id: ProtectorId) {
  const self = {
    id, gestures: 0, cancel: false,
    label: () => id,
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: 'x' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      if (id === 'hello') { self.gestures++; if (self.cancel) return { ok: false, kind: 'denied', reason: 'presence-cancelled: no' } }
      if (id === 'password') {
        const typed = currentVaultPassword()
        if (typed === undefined) return { ok: false, kind: 'denied', reason: 'password-required' }
        if (typed !== PW) return { ok: false, kind: 'denied', reason: 'password-wrong' }
      }
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
  }
  return self as Protector & typeof self
}
let T = 1_800_000_000_000
const clock = () => T
let dir = ''
let dpapi = fake('dpapi'); let hello = fake('hello'); let pw = fake('password')
const S = { session: 'http:local', loopback: true }
const SCOPE = { pieceKey: 'piece-1', move: 'approve:publicado' }

function restart(): void {
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello, pw], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
}
async function fresh(): Promise<void> {
  dir = await mkdtempP(join(tmpdir(), 'agentistics-deliv-'))
  STORE.clear(); dpapi = fake('dpapi'); hello = fake('hello'); pw = fake('password')
  restart()
}
/** A vault with ONLY the silent wrapper (nobody to ask). */
async function silentOnly(): Promise<void> { await fresh(); expect(await ensureVaultOpen({ create: true, migrate: false })).not.toBeNull() }
/** A vault with Windows Hello (a human wrapper), open. */
async function withHello(): Promise<{ words: string[] }> {
  await fresh()
  expect(await ensureVaultOpen({ create: true, migrate: false })).not.toBeNull()
  expect((await acceptSetupCode({ ...S, setupCode: mintSetupCode().code })).ok).toBe(true)
  expect(await enrolPresence('hello', { ...S, code: '000000' })).toMatchObject({ ok: true })
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  expect((await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).ok).toBe(true)
  return { words: r.words }
}
/** A vault whose human wrapper is the vault PASSWORD. */
async function withPassword(): Promise<void> {
  await fresh()
  expect(await ensureVaultOpen({ create: true, migrate: false })).not.toBeNull()
  expect((await acceptSetupCode({ ...S, setupCode: mintSetupCode().code })).ok).toBe(true)
  expect(await withVaultPassword(PW, () => enrolPresence('password', { ...S }))).toMatchObject({ ok: true })
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  expect((await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).ok).toBe(true)
  void unlockWithGesture
}
afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtempP(join(tmpdir(), 'agentistics-deliv-done-')), 'vault') }) })

// ── the row ───────────────────────────────────────────────────────────────────────────────────
describe('the `delivery-owner` row is dedicated, never generic', () => {
  test('exists, asks the gesture fresh, grants nothing', () => {
    expect(VAULT_ACTION_ROWS['delivery-owner']).toEqual({ code: false, gesture: true, grant: null })
  })
  test('immune to policy lowering: no ACTION_KIND_OF and no REMOTE_ROWS entry', () => {
    expect(ACTION_KIND_OF['delivery-owner']).toBeUndefined()
    expect(REMOTE_ROWS['delivery-owner']).toBeUndefined()
    expect(rowFor('delivery-owner', { session: 'http:x', loopback: false })).toEqual(VAULT_ACTION_ROWS['delivery-owner'])
  })
  test('the generic gate refuses it (bad-request, "use requireDeliveryOwner") so its tail can never pass it', async () => {
    await withHello()
    const r = await requireVaultStepUp('delivery-owner', S)
    expect(r).toMatchObject({ ok: false, code: 'bad-request' })
    expect(!r.ok && r.sentence).toContain('requireDeliveryOwner')
  })
  test('lowering EVERY kind to none (set-auth-policy) still asks the fresh proof', async () => {
    await withHello()
    const policy = { v: 1, kinds: Object.fromEntries(['reveal', 'use', 'edit', 'delete-secret', 'delete-device', 'wipe', 'settings', 'recovery'].map(k => [k, 'none'])) }
    await setAuthPolicy(policy, S).catch(() => undefined) // the gate may refuse critical kinds at none; either way:
    const g0 = hello.gestures
    expect((await requireDeliveryOwner(S, SCOPE)).ok).toBe(true)
    expect(hello.gestures - g0).toBe(1)
  })
})

// ── the proof ─────────────────────────────────────────────────────────────────────────────────
describe('requireDeliveryOwner: a FRESH proof every time, "the vault is open" is never enough', () => {
  test('Hello: every call raises the gesture again and mints a distinct grant', async () => {
    await withHello()
    const g0 = hello.gestures
    const a = await requireDeliveryOwner(S, SCOPE); const b = await requireDeliveryOwner(S, SCOPE)
    expect(a.ok && b.ok).toBe(true)
    expect(hello.gestures - g0).toBe(2)
    expect(a.ok && b.ok && a.grant).not.toBe(b.ok && b.grant)
  })
  test('a cancelled gesture is a refusal and mints nothing', async () => {
    await withHello()
    hello.cancel = true
    expect(await requireDeliveryOwner(S, SCOPE)).toMatchObject({ ok: false, code: 'presence-cancelled' })
  })
  test('a read grant, the unlock token and an open vault do not stand for it', async () => {
    await withHello()
    const read = mintGrant(S.session, 'read')
    hello.cancel = true
    expect(await requireDeliveryOwner({ ...S, grant: read, fresh: 'whatever' }, SCOPE)).toMatchObject({ ok: false, code: 'presence-cancelled' })
  })
  test('password first: the typed vault password proves it with NO gesture; a wrong one is refused and counts toward the back-off', async () => {
    await withPassword()
    expect(await requireDeliveryOwner(S, SCOPE)).toMatchObject({ ok: false, code: 'password-required' })
    const ok = await withVaultPassword(PW, () => requireDeliveryOwner(S, SCOPE))
    expect(ok.ok).toBe(true)
    expect(await withVaultPassword('Wrong-pw!!99', () => requireDeliveryOwner(S, SCOPE))).toMatchObject({ ok: false, code: 'password-wrong' })
  })
  test('password back-off: after the free tries the vault answers with the pause sentence, even for the right password', async () => {
    await withPassword()
    let last: { ok: boolean; code?: string } = { ok: true }
    for (let i = 0; i < 6; i++) last = await withVaultPassword('Wrong-pw!!99', () => requireDeliveryOwner(S, SCOPE))
    expect(last.ok).toBe(false)
    const paused = await withVaultPassword(PW, () => requireDeliveryOwner(S, SCOPE))
    expect(paused.ok).toBe(false)
    expect(!paused.ok && paused.code).not.toBe('password-required')
  })
})

// ── §2.3.1 per-state table ────────────────────────────────────────────────────────────────────
describe('per-vault-state table (the gate half; the mode half is in principal.doors.test.ts)', () => {
  test('no vault set up → locked/refused, never a pass', async () => {
    await fresh()
    expect((await requireDeliveryOwner(S, SCOPE)).ok).toBe(false)
    expect(await ownerProofAvailable()).toBe(false)
  })
  test('open, silent wrappers only → owner-proof-unavailable (any same-uid process could ask a silent wrapper)', async () => {
    await silentOnly()
    expect(await requireDeliveryOwner(S, SCOPE)).toMatchObject({ ok: false, code: 'owner-proof-unavailable' })
    expect(await ownerProofAvailable()).toBe(false)
    expect(await setOwnerProofMode('required', S)).toMatchObject({ ok: false, code: 'owner-proof-unavailable' })
    expect(await readOwnerProofMode()).toBe('legacy')
  })
  test('open with a human wrapper → ownerProofAvailable', async () => {
    await withHello()
    expect(await ownerProofAvailable()).toBe(true)
  })
  test('locked → refused `locked`, nothing minted', async () => {
    await withHello()
    lockVault('user')
    expect(await requireDeliveryOwner(S, SCOPE)).toMatchObject({ ok: false, code: 'locked' })
  })
  test('frozen → refused stepup-frozen', async () => {
    await withHello()
    writeFileSync(join(vaultDir(), 'stepup.json'), JSON.stringify({ v: 1, failures: 20, lastStep: 1, pausedUntilMs: null, frozen: true }))
    __resetGateForTests(clock)
    expect(await requireDeliveryOwner(S, SCOPE)).toMatchObject({ ok: false, code: 'stepup-frozen' })
  })
  test('recovery mode → refused recovery-mode', async () => {
    const { words } = await withHello()
    expect((await recoverWithWords(words.join(' '))).ok).toBe(true)
    expect(await requireDeliveryOwner(S, SCOPE)).toMatchObject({ ok: false, code: 'recovery-mode' })
  })
  test('off this computer → owner-proof-local-only (the phone path is out of scope), before anything else', async () => {
    await withHello()
    expect(await requireDeliveryOwner({ session: 'http:local' }, SCOPE)).toMatchObject({ ok: false, code: 'owner-proof-local-only' })
  })
  test('an empty scope is a bad request', async () => {
    await withHello()
    expect(await requireDeliveryOwner(S, { pieceKey: '', move: 'x' })).toMatchObject({ ok: false, code: 'bad-request' })
  })
})

// ── the grant ─────────────────────────────────────────────────────────────────────────────────
describe('the `delivery` grant: scoped, single-use, ≤ 5 min, loopback, bound to the session', () => {
  async function mint() { await withHello(); const r = await requireDeliveryOwner(S, SCOPE); if (!r.ok || !r.grant) throw new Error('no grant'); return r.grant }
  test('spends once for exactly its piece+move', async () => {
    const g = await mint()
    const first = consumeDeliveryGrant(g, S, SCOPE)
    expect(first).toMatchObject({ ok: true })
    expect(first.ok && first.grantId).toBe(deliveryGrantHash(g))
    expect(consumeDeliveryGrant(g, S, SCOPE)).toEqual({ ok: false, code: 'grant-invalid' })
  })
  test('another piece or another move is grant-scope and does NOT spend it', async () => {
    const g = await mint()
    expect(consumeDeliveryGrant(g, S, { ...SCOPE, pieceKey: 'piece-2' })).toEqual({ ok: false, code: 'grant-scope' })
    expect(consumeDeliveryGrant(g, S, { ...SCOPE, move: 'override' })).toEqual({ ok: false, code: 'grant-scope' })
    expect(consumeDeliveryGrant(g, S, SCOPE).ok).toBe(true)
  })
  test('expires after 5 minutes', async () => {
    const g = await mint()
    expect(consumeDeliveryGrant(g, S, SCOPE, T + 5 * 60_000 + 1)).toEqual({ ok: false, code: 'grant-invalid' })
  })
  test('another browser session cannot use it', async () => {
    const g = await mint()
    expect(consumeDeliveryGrant(g, { session: 'http:other', loopback: true }, SCOPE)).toEqual({ ok: false, code: 'grant-invalid' })
  })
  test('a non-loopback caller is refused owner-proof-local-only', async () => {
    const g = await mint()
    expect(consumeDeliveryGrant(g, { session: S.session }, SCOPE)).toEqual({ ok: false, code: 'owner-proof-local-only' })
    expect(consumeDeliveryGrant(g, S, SCOPE).ok).toBe(true) // not spent by the refusal
  })
  test('forged, truncated, empty and read-class tokens never spend', async () => {
    const g = await mint()
    for (const bad of [null, undefined, '', 'x', g + 'a', g.slice(0, -2), mintGrant(S.session, 'read')]) expect(consumeDeliveryGrant(bad as string, S, SCOPE).ok).toBe(false)
    expect(consumeDeliveryGrant(g, S, SCOPE).ok).toBe(true)
  })
  test('a delivery grant never stands for a read action, and grantValid never accepts the class', async () => {
    const g = await mint()
    expect(grantValid(g, S.session, 'read')).toBe(false)
    expect(grantValid(g, S.session, 'delivery')).toBe(false)
    hello.cancel = true
    expect(await requireVaultStepUp('set-auto-lock', { ...S, grant: g })).toMatchObject({ ok: false }) // asks its own proof, not the grant
  })
  test('the audit log holds the scope and a HASH of the grant — never the grant or any credential', async () => {
    await withHello()
    const r = await withVaultPassword(undefined, () => requireDeliveryOwner(S, SCOPE))
    expect(r.ok).toBe(true)
    const { readFileSync } = await import('node:fs')
    const log = readFileSync(join(vaultDir(), 'audit.jsonl'), 'utf8')
    expect(log).toContain('delivery.owner-proof')
    expect(log).toContain('piece-1|approve:publicado')
    expect(log).not.toContain(r.ok && r.grant ? r.grant : 'unreachable')
  })
})

// ── the mode switch ───────────────────────────────────────────────────────────────────────────
describe('delivery.ownerProof is an owner-only move, both directions', () => {
  test('absent reads as legacy; required needs a fresh proof; so does going back', async () => {
    await withHello()
    expect(await readOwnerProofMode()).toBe('legacy')
    hello.cancel = true
    expect(await setOwnerProofMode('required', S)).toMatchObject({ ok: false })
    expect(await readOwnerProofMode()).toBe('legacy')
    hello.cancel = false
    expect((await setOwnerProofMode('required', S)).ok).toBe(true)
    expect(await readOwnerProofMode()).toBe('required')
    hello.cancel = true
    expect(await setOwnerProofMode('legacy', S)).toMatchObject({ ok: false })
    expect(await readOwnerProofMode()).toBe('required')
    hello.cancel = false
    expect((await setOwnerProofMode('legacy', S)).ok).toBe(true)
    expect(await readOwnerProofMode()).toBe('legacy')
  })
  test('junk modes are bad requests; a remote caller cannot flip it', async () => {
    await withHello()
    expect(await setOwnerProofMode('yes', S)).toMatchObject({ ok: false, code: 'bad-request' })
    expect(await setOwnerProofMode('required', { session: S.session })).toMatchObject({ ok: false, code: 'owner-proof-local-only' })
  })
  test('the random seed is a throwaway, not a credential', () => { expect(randomBytes(1).length).toBe(1); void vaultStatus })
})
