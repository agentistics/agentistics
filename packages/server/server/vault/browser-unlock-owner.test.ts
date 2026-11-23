/**
 * NAVEGADOR S4b — the person's fresh vault proof before a session's browser is unlocked. Reuses the
 * ENTREGA.GARANTIDA §2.3.1 primitive (`proveGesture`, single-use owner grants); this file proves the
 * `browser-unlock` row and grant class with fake protectors and a fake clock — nothing is spawned, no real
 * credential exists here.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Protector, ProtectorId, UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, ensureVaultOpen, lockVault, vaultDir } from './service'
import {
  ACTION_KIND_OF, REMOTE_ROWS, VAULT_ACTION_ROWS, __resetGateForTests, acceptSetupCode, beginRecoveryKey, confirmRecoveryKey,
  consumeBrowserProfilesGrant, consumeBrowserUnlockGrant, consumeDeliveryGrant, requireBrowserProfilesOwner, deliveryGrantHash, enrolPresence, grantValid, mintGrant, mintSetupCode,
  recoverWithWords, requireBrowserUnlockOwner, requireDeliveryOwner, requireVaultStepUp, rowFor, setAuthPolicy,
} from './gate'
import { currentVaultPassword, withVaultPassword } from './password-context'
import { __resetOwnerModeForTests } from '../delivery/owner-mode'

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
const T = 1_800_000_000_000
const clock = () => T
let dir = ''
let dpapi = fake('dpapi'); let hello = fake('hello'); let pw = fake('password')
const S = { session: 'http:local', loopback: true }
const ID = 'aaa'

async function fresh(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-bru-'))
  STORE.clear(); dpapi = fake('dpapi'); hello = fake('hello'); pw = fake('password')
  __resetOwnerModeForTests()
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello, pw], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
}
async function silentOnly(): Promise<void> { await fresh(); expect(await ensureVaultOpen({ create: true, migrate: false })).not.toBeNull() }
async function finishRecovery(): Promise<string[]> {
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  expect((await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).ok).toBe(true)
  return r.words
}
async function withHello(): Promise<{ words: string[] }> {
  await fresh()
  expect(await ensureVaultOpen({ create: true, migrate: false })).not.toBeNull()
  expect((await acceptSetupCode({ ...S, setupCode: mintSetupCode().code })).ok).toBe(true)
  expect(await enrolPresence('hello', { ...S, code: '000000' })).toMatchObject({ ok: true })
  return { words: await finishRecovery() }
}
async function withPassword(): Promise<void> {
  await fresh()
  expect(await ensureVaultOpen({ create: true, migrate: false })).not.toBeNull()
  expect((await acceptSetupCode({ ...S, setupCode: mintSetupCode().code })).ok).toBe(true)
  expect(await withVaultPassword(PW, () => enrolPresence('password', { ...S }))).toMatchObject({ ok: true })
  await finishRecovery()
}
async function mint(id = ID): Promise<string> {
  const r = await requireBrowserUnlockOwner(S, id)
  if (!r.ok || !r.grant) throw new Error(`no grant: ${JSON.stringify(r)}`)
  return r.grant
}
afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-bru-done-')), 'vault') }) })

describe('the `browser-unlock` row is dedicated, never generic', () => {
  test('exists, asks the proof fresh, grants nothing generic', () => {
    expect(VAULT_ACTION_ROWS['browser-unlock']).toEqual({ code: false, gesture: true, grant: null })
  })
  test('immune to policy lowering: no ACTION_KIND_OF and no REMOTE_ROWS entry', () => {
    expect(ACTION_KIND_OF['browser-unlock']).toBeUndefined()
    expect(REMOTE_ROWS['browser-unlock']).toBeUndefined()
    expect(rowFor('browser-unlock', { session: 'http:x', loopback: false })).toEqual(VAULT_ACTION_ROWS['browser-unlock'])
  })
  test('the generic gate refuses it (bad-request) so its tail can never pass it vacuously', async () => {
    await withHello()
    const r = await requireVaultStepUp('browser-unlock', S)
    expect(r).toMatchObject({ ok: false, code: 'bad-request' })
    expect(!r.ok && r.sentence).toContain('requireBrowserUnlockOwner')
  })
  test('lowering EVERY kind to none still asks the fresh proof (mutant: policy lowered to none)', async () => {
    await withHello()
    const policy = { v: 1, kinds: Object.fromEntries(['reveal', 'use', 'edit', 'delete-secret', 'delete-device', 'wipe', 'settings', 'recovery'].map(k => [k, 'none'])) }
    await setAuthPolicy(policy, S).catch(() => undefined)
    const g0 = hello.gestures
    expect((await requireBrowserUnlockOwner(S, ID)).ok).toBe(true)
    expect(hello.gestures - g0).toBe(1)
    hello.cancel = true
    expect((await requireBrowserUnlockOwner(S, ID)).ok).toBe(false)
  })
})

describe('requireBrowserUnlockOwner: a FRESH proof every time (mutant: proof skipped)', () => {
  test('Hello: every call raises the gesture again and mints a distinct grant', async () => {
    await withHello()
    const g0 = hello.gestures
    const a = await requireBrowserUnlockOwner(S, ID); const b = await requireBrowserUnlockOwner(S, ID)
    expect(a.ok && b.ok).toBe(true)
    expect(hello.gestures - g0).toBe(2)
    expect(a.ok && a.grant).not.toBe(b.ok && b.grant)
  })
  test('a cancelled gesture is a refusal and mints nothing', async () => {
    await withHello()
    hello.cancel = true
    const r = await requireBrowserUnlockOwner(S, ID)
    expect(r).toMatchObject({ ok: false, code: 'presence-cancelled' })
    expect('grant' in r).toBe(false)
  })
  test('an open vault, a read grant or a fresh token do not stand for it', async () => {
    await withHello()
    hello.cancel = true
    expect(await requireBrowserUnlockOwner({ ...S, grant: mintGrant(S.session, 'read'), fresh: 'x' }, ID)).toMatchObject({ ok: false, code: 'presence-cancelled' })
  })
  test('password: none typed → password-required; the right one passes with no gesture; a wrong one refuses', async () => {
    await withPassword()
    expect(await requireBrowserUnlockOwner(S, ID)).toMatchObject({ ok: false, code: 'password-required' })
    expect((await withVaultPassword(PW, () => requireBrowserUnlockOwner(S, ID))).ok).toBe(true)
    expect(await withVaultPassword('Wrong-pw!!99', () => requireBrowserUnlockOwner(S, ID))).toMatchObject({ ok: false, code: 'password-wrong' })
  })
})

describe('per vault state — no human to ask is a refusal that says what to do', () => {
  test('no vault set up → owner-proof-unavailable with the set-up sentence (pt/en), never a pass', async () => {
    await fresh()
    const r = await requireBrowserUnlockOwner(S, ID)
    expect(r).toMatchObject({ ok: false, code: 'owner-proof-unavailable' })
    expect(!r.ok && r.sentence).toContain('Open the Vault')
    expect(!r.ok && r.sentence).not.toContain('agentop')
  })
  test('silent wrappers only (dpapi/keychain/libsecret) → owner-proof-unavailable, same sentence', async () => {
    await silentOnly()
    const r = await requireBrowserUnlockOwner(S, ID)
    expect(r).toMatchObject({ ok: false, code: 'owner-proof-unavailable' })
    expect(!r.ok && r.sentence).toContain('Open the Vault')
  })
  test('the sentence follows the vault language', async () => {
    await fresh()
    __resetVaultForTests({ dir: join(dir, 'vault-pt'), lang: 'pt', protectors: [dpapi, hello, pw], autoInit: { candidates: [dpapi] } })
    const r = await requireBrowserUnlockOwner(S, ID)
    expect(!r.ok && r.sentence).toContain('Abra o Cofre')
  })
  test('locked → `locked`; frozen → stepup-frozen; recovery → recovery-mode', async () => {
    await withHello()
    lockVault('user')
    expect(await requireBrowserUnlockOwner(S, ID)).toMatchObject({ ok: false, code: 'locked' })
    await withHello()
    writeFileSync(join(vaultDir(), 'stepup.json'), JSON.stringify({ v: 1, failures: 20, lastStep: 1, pausedUntilMs: null, frozen: true }))
    __resetGateForTests(clock)
    expect(await requireBrowserUnlockOwner(S, ID)).toMatchObject({ ok: false, code: 'stepup-frozen' })
    const { words } = await withHello()
    expect((await recoverWithWords(words.join(' '))).ok).toBe(true)
    expect(await requireBrowserUnlockOwner(S, ID)).toMatchObject({ ok: false, code: 'recovery-mode' })
  })
  test('off this computer → owner-proof-local-only before anything else (no dialog raised)', async () => {
    await withHello()
    const g0 = hello.gestures
    expect(await requireBrowserUnlockOwner({ session: 'http:local' }, ID)).toMatchObject({ ok: false, code: 'owner-proof-local-only' })
    expect(hello.gestures).toBe(g0)
  })
  test('a malformed managed id is a bad request, no dialog raised', async () => {
    await withHello()
    const g0 = hello.gestures
    for (const bad of ['', '../x', 'a b', 'x'.repeat(65)]) expect(await requireBrowserUnlockOwner(S, bad)).toMatchObject({ ok: false, code: 'bad-request' })
    expect(hello.gestures).toBe(g0)
  })
})

describe('the `browser-unlock` grant: ONE browser, single-use, ≤ 5 min, loopback, this session', () => {
  test('spends once (mutant: grant reused)', async () => {
    await withHello()
    const g = await mint()
    const first = consumeBrowserUnlockGrant(g, S, ID)
    expect(first).toEqual({ ok: true, grantId: deliveryGrantHash(g) })
    expect(consumeBrowserUnlockGrant(g, S, ID)).toEqual({ ok: false, code: 'grant-invalid' })
  })
  test('another session\'s browser is grant-scope and does NOT spend it (mutant: grant from another scope)', async () => {
    await withHello()
    const g = await mint('aaa')
    expect(consumeBrowserUnlockGrant(g, S, 'bbb')).toEqual({ ok: false, code: 'grant-scope' })
    expect(consumeBrowserUnlockGrant(g, S, 'aaa').ok).toBe(true)
  })
  test('expires after 5 minutes', async () => {
    await withHello()
    const g = await mint()
    expect(consumeBrowserUnlockGrant(g, S, ID, T + 5 * 60_000 + 1)).toEqual({ ok: false, code: 'grant-invalid' })
  })
  test('another HTTP session cannot use it; a non-loopback caller is refused and does not spend it', async () => {
    await withHello()
    const g = await mint()
    expect(consumeBrowserUnlockGrant(g, { session: 'http:other', loopback: true }, ID)).toEqual({ ok: false, code: 'grant-invalid' })
    expect(consumeBrowserUnlockGrant(g, { session: S.session }, ID)).toEqual({ ok: false, code: 'owner-proof-local-only' })
    expect(consumeBrowserUnlockGrant(g, S, ID).ok).toBe(true)
  })
  test('forged, truncated, empty and read-class tokens never spend', async () => {
    await withHello()
    const g = await mint()
    for (const bad of [null, undefined, '', 'x', g + 'a', g.slice(0, -2), mintGrant(S.session, 'read')]) expect(consumeBrowserUnlockGrant(bad as string, S, ID).ok).toBe(false)
    expect(consumeBrowserUnlockGrant(g, S, ID).ok).toBe(true)
  })
  test('the classes never cross: a delivery grant never unlocks a browser, a browser grant is never a delivery move', async () => {
    await withHello()
    // A delivery grant minted for the very scope string a browser grant uses.
    const d = await requireDeliveryOwner(S, { pieceKey: `browser:${ID}`, move: 'unlock' })
    if (!d.ok || !d.grant) throw new Error('no delivery grant')
    expect(consumeBrowserUnlockGrant(d.grant, S, ID)).toEqual({ ok: false, code: 'grant-invalid' })
    const b = await mint()
    expect(consumeDeliveryGrant(b, S, { pieceKey: `browser:${ID}`, move: 'unlock' })).toEqual({ ok: false, code: 'grant-invalid' })
    expect(grantValid(b, S.session, 'read')).toBe(false)
    expect(consumeBrowserUnlockGrant(b, S, ID).ok).toBe(true)
    expect(consumeDeliveryGrant(d.grant, S, { pieceKey: `browser:${ID}`, move: 'unlock' }).ok).toBe(true)
  })
  test('the audit log names the browser and a HASH of the grant — never the grant or a credential', async () => {
    await withPassword()
    const r = await withVaultPassword(PW, () => requireBrowserUnlockOwner(S, ID))
    if (!r.ok || !r.grant) throw new Error('no grant')
    const log = readFileSync(join(vaultDir(), 'audit.jsonl'), 'utf8')
    expect(log).toContain('browser.owner-proof')
    expect(log).toContain(deliveryGrantHash(r.grant))
    expect(log).not.toContain(r.grant)
    expect(log).not.toContain(PW)
  })
})

describe('S12 r4 — the `browser-profiles` grant ("Delete profiles")', () => {
  const prof = async (): Promise<string> => { const r = await requireBrowserProfilesOwner(S); if (!r.ok || !r.grant) throw new Error(JSON.stringify(r)); return r.grant }
  test('asks the fresh proof every time; a cancelled gesture mints nothing', async () => {
    await withHello()
    const g0 = hello.gestures
    await prof(); await prof()
    expect(hello.gestures - g0).toBe(2)
    hello.cancel = true
    expect((await requireBrowserProfilesOwner(S)).ok).toBe(false)
  })
  test('single-use (mutant: grant reused), 5 min, this session, loopback only', async () => {
    await withHello()
    const g = await prof()
    expect(consumeBrowserProfilesGrant(g, { session: 'http:other', loopback: true })).toEqual({ ok: false, code: 'grant-invalid' })
    expect(consumeBrowserProfilesGrant(g, { session: S.session })).toEqual({ ok: false, code: 'owner-proof-local-only' })
    expect(consumeBrowserProfilesGrant(g, S, T + 5 * 60_000 + 1)).toEqual({ ok: false, code: 'grant-invalid' })
    expect(consumeBrowserProfilesGrant(g, S)).toEqual({ ok: true, grantId: deliveryGrantHash(g) })
    expect(consumeBrowserProfilesGrant(g, S)).toEqual({ ok: false, code: 'grant-invalid' })
  })
  test('classes never stand for each other: an unlock grant does not delete, a profiles grant does not unlock', async () => {
    await withHello()
    const unlock = await mint()
    expect(consumeBrowserProfilesGrant(unlock, S)).toEqual({ ok: false, code: 'grant-invalid' })
    const g = await prof()
    expect(consumeBrowserUnlockGrant(g, S, ID)).toEqual({ ok: false, code: 'grant-invalid' })
    expect(consumeBrowserProfilesGrant(g, S).ok).toBe(true)
  })
  test('no token / forged token never spend', async () => {
    await withHello()
    expect(consumeBrowserProfilesGrant(null, S)).toEqual({ ok: false, code: 'grant-invalid' })
    expect(consumeBrowserProfilesGrant('x.y', S)).toEqual({ ok: false, code: 'grant-invalid' })
  })
})
