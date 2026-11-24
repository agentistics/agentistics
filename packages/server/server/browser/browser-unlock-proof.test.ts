/**
 * NAVEGADOR S4b, end to end in one process: the REAL vault gate (fake protectors, fake clock) minting the
 * person's `browser-unlock` grant, spent by the REAL padlock route over a fake browser host. The person with
 * the vault password unlocks ONCE; the same grant again, a grant for another browser, no grant at all — and a
 * known session holding a valid grant — are all refused. No browser, no server, no real credential.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Protector, ProtectorId, UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, ensureVaultOpen } from '../vault/service'
import {
  __resetGateForTests, acceptSetupCode, beginRecoveryKey, confirmRecoveryKey, consumeBrowserUnlockGrant, enrolPresence, mintSetupCode,
  ownerProofAvailable, requireBrowserUnlockOwner,
} from '../vault/gate'
import { currentVaultPassword, withVaultPassword } from '../vault/password-context'
import { __resetOwnerModeForTests } from '../delivery/owner-mode'
import { browserRoute, type RouteDeps, type RouteHost } from './browser-web'
import { BrowserLocks } from './browser-lock-host'
import { ownerProofRefusal } from './browser-lock'
import type { ActionHost } from './browser-actions'
import type { CallerVerdict } from './browser-caller'

const STORE = new Map<string, Uint8Array>()
const PW = 'Zq-r8!kLm2Pw'
function fake(id: ProtectorId): Protector {
  return {
    id, label: () => id,
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: 'x' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      if (id === 'password') {
        const typed = currentVaultPassword()
        if (typed === undefined) return { ok: false, kind: 'denied', reason: 'password-required' }
        if (typed !== PW) return { ok: false, kind: 'denied', reason: 'password-wrong' }
      }
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
  } as Protector
}
const T = 1_800_000_000_000
const S = { session: 'http:local', loopback: true }

async function vault(kind: 'password' | 'silent' | 'none'): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-bup-'))
  STORE.clear()
  __resetOwnerModeForTests()
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [fake('dpapi'), fake('password')], autoInit: { candidates: [fake('dpapi')] } })
  __setVaultClockForTests(() => T)
  __resetGateForTests(() => T)
  if (kind === 'none') return
  expect(await ensureVaultOpen({ create: true, migrate: false })).not.toBeNull()
  if (kind === 'silent') return
  expect((await acceptSetupCode({ ...S, setupCode: mintSetupCode().code })).ok).toBe(true)
  expect(await withVaultPassword(PW, () => enrolPresence('password', { ...S }))).toMatchObject({ ok: true })
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  expect((await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).ok).toBe(true)
}

/** The padlock route wired the way index.ts wires it: the header's grant spent against the real gate. */
function door(caller: CallerVerdict) {
  const locks = new BrowserLocks({ now: () => T, setTimer: () => 0, clearTimer: () => {} })
  const host: RouteHost = {
    start: async () => ({ ok: true, key: 's-aaa', pid: 1, reused: false }),
    stop: async () => {},
    actionHost: (k) => (k === 's-aaa' || k === 's-bbb' ? ({ key: k, tabs: () => [] } as unknown as ActionHost) : null),
    status: async () => ({ live: [] }),
  }
  let header: string | null = null
  const deps: RouteDeps = {
    host, locks,
    verify: async () => null,
    run: async () => ({ ok: true }),
    caller: () => caller,
    ownerProof: async (managedId) => {
      const used = consumeBrowserUnlockGrant(header, S, managedId)
      if (used.ok) return used
      const setup = used.code === 'grant-invalid' && (await ownerProofAvailable()) === false
      return ownerProofRefusal(used.code, 'en', setup)
    },
  }
  const unlock = (owner: string, grant: string | null) => { header = grant; return browserRoute('POST', '/api/browser/lock', { owner, lock: 'unlocked' }, deps) }
  const relock = (owner: string) => browserRoute('POST', '/api/browser/lock', { owner, lock: 'locked' }, deps)
  return { unlock, relock, mode: (k: string) => locks.view(k).mode }
}
// NAV.SEM-COFRE: a verified person needs no proof; the proof is what a caller the socket cannot identify still owes.
const PERSON: CallerVerdict = { kind: 'unknown', reason: 'no-proc' }
async function personGrant(id = 'aaa'): Promise<string> {
  const r = await withVaultPassword(PW, () => requireBrowserUnlockOwner(S, id))
  if (!r.ok || !r.grant) throw new Error(JSON.stringify(r))
  return r.grant
}
afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-bup-done-')), 'vault') }) })

describe('S4b end to end — the person with the vault proof unlocks once; nobody else does', () => {
  test('no grant → 403 owner_proof_required (this is every F1 variant that looked like the person)', async () => {
    await vault('password')
    const d = door(PERSON)
    expect(await d.unlock('aaa', null)).toMatchObject({ status: 403, body: { error: 'owner_proof_required' } })
    expect(d.mode('s-aaa')).toBe('locked')
  })
  test('without the password nobody can mint the grant', async () => {
    await vault('password')
    expect(await requireBrowserUnlockOwner(S, 'aaa')).toMatchObject({ ok: false, code: 'password-required' })
    expect(await withVaultPassword('guess-guess-1A!', () => requireBrowserUnlockOwner(S, 'aaa'))).toMatchObject({ ok: false })
  })
  test('the person with the proof unlocks ONCE; the same grant again is refused', async () => {
    await vault('password')
    const d = door(PERSON)
    const g = await personGrant()
    expect(await d.unlock('aaa', g)).toMatchObject({ status: 200, body: { lock: 'unlocked', changed: true } })
    expect(await d.relock('aaa')).toMatchObject({ status: 200, body: { lock: 'locked' } })
    expect(await d.unlock('aaa', g)).toMatchObject({ status: 403, body: { error: 'owner_proof_required' } })
    expect(d.mode('s-aaa')).toBe('locked')
  })
  test('a grant for another session\'s browser does not unlock this one (and stays usable for its own)', async () => {
    await vault('password')
    const d = door(PERSON)
    const g = await personGrant('bbb')
    expect(await d.unlock('aaa', g)).toMatchObject({ status: 403, body: { error: 'owner_proof_scope' } })
    expect(await d.unlock('bbb', g)).toMatchObject({ status: 200, body: { lock: 'unlocked' } })
  })
  test('a KNOWN session holding a valid grant is still refused (socket layer), and the grant is not spent', async () => {
    await vault('password')
    const g = await personGrant()
    expect(await door({ kind: 'session', pid: 4, managedId: 'aaa' }).unlock('aaa', g)).toMatchObject({ status: 403, body: { error: 'session_cannot_unlock' } })
    expect(await door(PERSON).unlock('aaa', g)).toMatchObject({ status: 200 })
  })
  test('macOS / Windows (caller unidentifiable): the proof alone unlocks', async () => {
    await vault('password')
    const d = door({ kind: 'unknown', reason: 'no-proc' })
    expect(await d.unlock('aaa', null)).toMatchObject({ status: 403, body: { error: 'owner_proof_required' } })
    expect(await d.unlock('aaa', await personGrant())).toMatchObject({ status: 200, body: { lock: 'unlocked' } })
  })
  test('a machine whose vault cannot ask a person: refused with the Vault action, never unlocked', async () => {
    for (const k of ['silent', 'none'] as const) {
      await vault(k)
      const a = await door(PERSON).unlock('aaa', null)
      expect(a).toMatchObject({ status: 403, body: { error: 'owner_proof_unavailable', action: { kind: 'open-vault', path: '/vault' } } })
    }
  })
})
