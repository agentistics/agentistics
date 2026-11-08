/**
 * Owner decision 2026-10-06 — the per-action authentication policy, enforced by the SERVER gate — as it
 * reads since COFRE.DESBLOQUEIO (owner, 2026-11-07): there is no authenticator code any more, so every
 * kind either asks the person's ONE proof (here Windows Hello) or — for a read, at this computer —
 * nothing. A stored "code" or "both" from before is that one proof; the critical kinds are never
 * "nothing"; changing the policy costs the proof; a record that cannot be read is read as the strictest.
 * Same fakes as gate.test.ts.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACTION_KINDS, ACTION_KINDS_ORDER, choicesFor, proofsFor, type ActionKind, type ProofChoice, type Protector, type ProtectorId, type UnwrapResult,
} from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, sealToFile } from './service'
import {
  ACTION_KIND_OF, VAULT_ACTION_ROWS, __resetGateForTests, acceptSetupCode, authPolicyView, beginRecoveryKey, confirmRecoveryKey,
  enrolPresence, mintSetupCode, policyRow, requirePersonalReveal, requireVaultStepUp, setAuthPolicy, type VaultAction,
} from './gate'
import { authPolicyFile, readAuthPolicy, writeAuthPolicy } from './auth-policy'

const STORE = new Map<string, Uint8Array>()
function fake(id: ProtectorId): Protector & { gestures: number; cancel: boolean } {
  const self = {
    id, gestures: 0, cancel: false,
    label: () => (id === 'hello' ? 'Windows Hello (fake)' : 'DPAPI (fake)'),
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: 'x' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      if (id === 'hello') { self.gestures++; if (self.cancel) return { ok: false, kind: 'denied', reason: 'presence-cancelled: the user said no' } }
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
  }
  return self
}

let T = 1_800_000_000_000
const clock = () => T
let dir = ''
let dpapi = fake('dpapi')
let hello = fake('hello')
/** A page from ANOTHER device (LAN / tailnet) and a page ON this computer. */
const S = { session: 'session-A' }
const L = { ...S, loopback: true }
/** A code a caller may still send: it is never judged and never helps. */
const CODE = '123456'

async function ownerMachine(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-authpolicy-'))
  dpapi = fake('dpapi'); hello = fake('hello')
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('TEST-NOT-A-SECRET')) // creates the vault
  expect((await acceptSetupCode({ ...L, setupCode: mintSetupCode().code })).ok).toBe(true)
  expect((await enrolPresence('hello', L)).ok).toBe(true)
  const r = await beginRecoveryKey(L)
  if (!r.ok) throw new Error(r.sentence)
  expect((await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), L)).ok).toBe(true)
}

afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-authpolicy-done-')), 'vault') }) })

const FULL = { hasAuthenticator: true, hasPresence: true }
const NOW = { hasAuthenticator: false, hasPresence: true }
const mapped = Object.entries(ACTION_KIND_OF).filter(([a]) => a !== 'personal-reveal') as [VaultAction, ActionKind][]

describe('the defaults are the table\'s rows, exactly', () => {
  test('policyRow with no policy returns the table\'s row for every action', () => {
    for (const a of Object.keys(VAULT_ACTION_ROWS) as VaultAction[]) {
      expect(policyRow(a, L, null, FULL)).toEqual(VAULT_ACTION_ROWS[a])
    }
  })
  test('on a vault with no authenticator (every vault now), a "code" choice is the gesture — never nothing', () => {
    expect(proofsFor('code', NOW)).toEqual({ code: false, gesture: true })
    expect(proofsFor('both', NOW)).toEqual({ code: false, gesture: true })
    expect(proofsFor('gesture', NOW)).toEqual({ code: false, gesture: true })
    expect(proofsFor('none', NOW)).toEqual({ code: false, gesture: false })
  })
})

describe('the server gate — every mapped action × every allowed choice', () => {
  beforeEach(async () => { await ownerMachine() })

  for (const [action, kind] of mapped) {
    for (const choice of choicesFor(kind)) {
      test(`${action} (${kind}) = ${choice}`, async () => {
        await writeAuthPolicy({ v: 1, choices: { [kind]: choice } })
        const g0 = hello.gestures
        expect((await requireVaultStepUp(action, L)).ok).toBe(true)
        // ONE proof for anything but "none"; nothing for "none" (a read, at this computer).
        expect(hello.gestures - g0).toBe(choice === 'none' ? 0 : 1)
        if (choice !== 'none') {
          hello.cancel = true
          expect((await requireVaultStepUp(action, { ...L, code: CODE })).ok).toBe(false) // a code is no proof
          hello.cancel = false
        }
      })
    }
  }

  test('"none" OFF this computer is never nothing: the phone\'s biometrics, never a dialog here', async () => {
    await writeAuthPolicy({ v: 1, choices: { use: 'none' } })
    const g0 = hello.gestures
    expect(await requireVaultStepUp('personal-grant', S)).toMatchObject({ ok: false, code: 'mobile-gesture-required' })
    expect(await requireVaultStepUp('personal-grant', { ...S, code: CODE })).toMatchObject({ ok: false, code: 'mobile-gesture-required' })
    expect(hello.gestures - g0).toBe(0)
  })
})

describe('reveal — requirePersonalReveal under each choice', () => {
  beforeEach(async () => { await ownerMachine() })
  const R = { ...L, binding: 'item:value' }

  test('gesture (the default): one Hello', async () => {
    const g0 = hello.gestures
    expect((await requirePersonalReveal(R)).ok).toBe(true)
    expect(hello.gestures - g0).toBe(1)
  })
  test('none: no prompt — at this computer only', async () => {
    await writeAuthPolicy({ v: 1, choices: { reveal: 'none' } })
    const g0 = hello.gestures
    expect((await requirePersonalReveal(R)).ok).toBe(true)
    expect(hello.gestures - g0).toBe(0)
    expect(await requirePersonalReveal({ ...S, binding: 'item:value' })).toMatchObject({ ok: false, code: 'mobile-gesture-required' })
  })
  for (const choice of ['code', 'both'] as const) {
    test(`a stored "${choice}" from before is the ONE proof: one Hello, fresh each time`, async () => {
      await writeAuthPolicy({ v: 1, choices: { reveal: choice } })
      const g0 = hello.gestures
      expect((await requirePersonalReveal(R)).ok).toBe(true)
      expect((await requirePersonalReveal({ ...R, code: CODE })).ok).toBe(true)
      expect(hello.gestures - g0).toBe(2)
    })
  }
  test('"Sempre confirmar" OFF on the secret still wins: the open vault is the proof', async () => {
    await writeAuthPolicy({ v: 1, choices: { reveal: 'both' } })
    const g0 = hello.gestures
    expect((await requirePersonalReveal(R, { confirm: false })).ok).toBe(true)
    expect(hello.gestures - g0).toBe(0)
  })
})

describe('changing the policy (set-auth-policy)', () => {
  beforeEach(async () => { await ownerMachine() })

  test('every critical kind refuses "none" — the whole policy, nothing written', async () => {
    for (const k of ACTION_KINDS_ORDER.filter(k => !ACTION_KINDS[k].read)) {
      expect(await setAuthPolicy({ [k]: 'none' }, L)).toMatchObject({ ok: false, code: 'bad-request' })
    }
    expect(await setAuthPolicy({ reveal: 'none', wipe: 'none' }, L)).toMatchObject({ ok: false, code: 'bad-request' })
    expect((await readAuthPolicy()).state).toBe('default')
  })

  test('costs the proof: one Hello, fresh — cancelled, nothing is written', async () => {
    hello.cancel = true
    expect((await setAuthPolicy({ reveal: 'none' }, { ...L, code: CODE })).ok).toBe(false)
    expect((await readAuthPolicy()).state).toBe('default')
    hello.cancel = false
    const g0 = hello.gestures
    expect((await setAuthPolicy({ reveal: 'none' }, L)).ok).toBe(true)
    expect(hello.gestures - g0).toBe(1)
    expect(await readAuthPolicy()).toEqual({ state: 'stored', policy: { v: 1, choices: { reveal: 'none' } } })
  })

  test('the record is sealed: its bytes never carry the choices in plain text', async () => {
    await writeAuthPolicy({ v: 1, choices: { reveal: 'none' } })
    const raw = await Bun.file(authPolicyFile()).text()
    expect(raw).not.toContain('reveal')
    expect(raw).not.toContain('none')
  })

  test('a record that cannot be opened reads as the STRICTEST: the proof everywhere', async () => {
    writeFileSync(authPolicyFile(), 'not a sealed record')
    chmodSync(authPolicyFile(), 0o600)
    const r = await readAuthPolicy()
    expect(r.state).toBe('unreadable')
    const v = await authPolicyView()
    expect(v.rows.every(x => x.choice === 'gesture')).toBe(true)
    const g0 = hello.gestures
    expect((await requirePersonalReveal({ ...L, binding: 'i:v' })).ok).toBe(true)
    expect(hello.gestures - g0).toBe(1)
  })

  test('the view offers only "the proof" or (for a read) "nothing" — never a code — and no critical kind offers "none"', async () => {
    const v = await authPolicyView()
    expect(v.rows.map(r => r.kind)).toEqual([...ACTION_KINDS_ORDER])
    for (const r of v.rows) {
      expect(r.choice).toBe(r.default)
      expect(r.choices.every(c => c === 'gesture' || c === 'none')).toBe(true)
      expect(r.choices).toContain('gesture' as ProofChoice)
      if (r.critical) expect(r.choices).not.toContain('none' as ProofChoice)
    }
  })
})
