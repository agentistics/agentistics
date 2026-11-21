/**
 * NAVEGADOR S10 r3, end to end in one process: the REAL vault gate (fake protectors, fake clock) minting the
 * person's personal-browser grant, checked by the REAL route over a fake host. The QA escapes (a detached child
 * with a clean environment, a `--network host` container, `systemd-run`) all LOOK like the person to the socket;
 * what they lack is the vault proof, so with no grant every personal door says no whatever the socket says.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Protector, ProtectorId, UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, ensureVaultOpen } from '../vault/service'
import {
  __resetGateForTests, acceptSetupCode, beginRecoveryKey, confirmRecoveryKey, enrolPresence, mintPersonalBrowserGrant, mintSetupCode,
} from '../vault/gate'
import { currentVaultPassword, withVaultPassword } from '../vault/password-context'
import { __resetOwnerModeForTests } from '../delivery/owner-mode'
import { browserRoute, type RouteDeps, type RouteHost } from './browser-web'
import type { ActionHost } from './browser-actions'
import type { CallerVerdict } from './browser-caller'
import { __resetPersonalGrantsForTests, personalGrants } from './personal-grant'

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
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-pbp-'))
  STORE.clear()
  __resetPersonalGrantsForTests()
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

/** The personal routes wired the way index.ts wires them: the header's grant checked against the real store. */
function door(caller: CallerVerdict) {
  const host: RouteHost = {
    start: async () => ({ ok: true, key: 'personal', pid: 1, reused: false }),
    stop: async () => {},
    actionHost: (k) => (k === 'personal' ? ({ key: k, tabs: () => [] } as unknown as ActionHost) : null),
    status: async () => ({ live: [{ key: 'personal', owner: { kind: 'personal' }, tabs: [{ url: 'https://bank.example/a', title: 'x' }] }] }),
  }
  let header: string | null = null
  const deps: RouteDeps = {
    host, verify: async () => null, run: async () => ({ ok: true }),
    caller: () => caller,
    personalGrant: () => personalGrants().check(header, S.session),
  }
  const call = (action: string, grant: string | null) => { header = grant; return browserRoute('POST', `/api/browser/personal/${action}`, { url: 'http://a/' }, deps) }
  const status = (grant: string | null) => { header = grant; return browserRoute('GET', '/api/browser/status', undefined, deps) }
  return { call, status }
}
const PERSON: CallerVerdict = { kind: 'person', via: 'process', pid: 9 }
const ESCAPES: Array<[string, CallerVerdict]> = [
  ['detached child, clean environment (env -u … setsid)', { kind: 'person', via: 'process', pid: 9 }],
  ['docker --network host (uid 0 = the Windows relay)', { kind: 'person', via: 'wsl-relay' }],
  ['systemd-run --user', { kind: 'person', via: 'process', pid: 77 }],
  ['no /proc to ask', { kind: 'unknown', reason: 'no-proc' }],
]
afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-pbp-done-')), 'vault') }) })

describe('S10 r3 — the personal browser answers to the owner proof, not to the socket', () => {
  test('every QA escape (no grant) is refused on every verb and on the status', async () => {
    await vault('password')
    for (const [name, caller] of ESCAPES) {
      const d = door(caller)
      for (const a of ['navigate', 'snapshot', 'screenshot', 'tabs', 'tab_new']) {
        expect(await d.call(a, null), `${name} ${a}`).toMatchObject({ status: 403, body: { error: 'personal_proof_required' } })
      }
      const st = (await d.status(null))!.body as { live: unknown[] }
      expect(JSON.stringify(st), name).not.toContain('bank.example')
    }
  })
  test('a forged or guessed grant is refused', async () => {
    await vault('password')
    const d = door(PERSON)
    for (const g of ['x'.repeat(43), 'AAAA', '', 'null']) expect(await d.call('navigate', g)).toMatchObject({ status: 403 })
  })
  test('without the vault password nobody can mint a grant', async () => {
    await vault('password')
    expect(await mintPersonalBrowserGrant(S)).toMatchObject({ ok: false, code: 'password-required' })
    expect(await withVaultPassword('guess-guess-1A!', () => mintPersonalBrowserGrant(S))).toMatchObject({ ok: false })
    expect(personalGrants().size()).toBe(0)
  })
  test('the person with the proof gets a grant that works on every door, many times, and the status shows the browser', async () => {
    await vault('password')
    const g = await withVaultPassword(PW, () => mintPersonalBrowserGrant(S))
    if (!g.ok) throw new Error(JSON.stringify(g))
    expect(g.expiresAt - Date.now()).toBeLessThanOrEqual(12 * 3_600_000)
    const d = door(PERSON)
    for (let i = 0; i < 3; i++) expect(await d.call('navigate', g.grant)).toMatchObject({ status: 200 })
    expect(JSON.stringify((await d.status(g.grant))!.body)).toContain('bank.example')
  })
  test('a known SESSION holding a valid grant is still refused (the socket adds a no, never a yes)', async () => {
    await vault('password')
    const g = await withVaultPassword(PW, () => mintPersonalBrowserGrant(S))
    if (!g.ok) throw new Error(JSON.stringify(g))
    expect(await door({ kind: 'session', pid: 4, managedId: 'aaa' }).call('navigate', g.grant)).toMatchObject({ status: 403, body: { error: 'session_cannot_drive_personal' } })
  })
  test('a revoked grant stops working at once', async () => {
    await vault('password')
    const g = await withVaultPassword(PW, () => mintPersonalBrowserGrant(S))
    if (!g.ok) throw new Error(JSON.stringify(g))
    const d = door(PERSON)
    expect(await d.call('navigate', g.grant)).toMatchObject({ status: 200 })
    personalGrants().revoke(g.grant)
    expect(await d.call('navigate', g.grant)).toMatchObject({ status: 403, body: { error: 'personal_proof_required' } })
  })
  test('off this computer the proof cannot be given', async () => {
    await vault('password')
    expect(await withVaultPassword(PW, () => mintPersonalBrowserGrant({ session: 'http:local', loopback: false }))).toMatchObject({ ok: false, code: 'owner-proof-local-only' })
  })
  test('a machine whose vault cannot ask a person: no grant, and the sentence names the Vault', async () => {
    for (const k of ['silent', 'none'] as const) {
      await vault(k)
      const r = await mintPersonalBrowserGrant(S)
      expect(r).toMatchObject({ ok: false, code: 'owner-proof-unavailable' })
      expect((r as { sentence: string }).sentence).toMatch(/Vault/)
      expect(personalGrants().size()).toBe(0)
    }
  })
})
