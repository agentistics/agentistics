/**
 * Owner decision 2026-10-06 — the per-action authentication policy, enforced by the SERVER gate: every
 * mapped action × every choice its kind allows, the critical kinds never "nothing", changing the policy
 * costs a proof, and a record that cannot be read is read as the strictest. Same fakes as gate.test.ts.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACTION_KINDS, ACTION_KINDS_ORDER, base32Decode, choicesFor, hotp, proofsFor, type ActionKind, type ProofChoice, type Protector, type ProtectorId, type UnwrapResult,
} from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, sealToFile } from './service'
import {
  ACTION_KIND_OF, VAULT_ACTION_ROWS, __resetGateForTests, authPolicyView, beginAuthenticator, beginRecoveryKey, confirmAuthenticator, confirmRecoveryKey,
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
const step = () => Math.floor(T / 1000 / 30)
let seed: Uint8Array
const code = () => hotp(seed, step())
const next = () => { T += 30_000 }
let dir = ''
let dpapi = fake('dpapi')
let hello = fake('hello')
const S = { session: 'session-A' }
const L = { ...S, loopback: true }

async function ownerMachine(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-authpolicy-'))
  dpapi = fake('dpapi'); hello = fake('hello')
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('TEST-NOT-A-SECRET')) // creates the vault
  const a = await beginAuthenticator({ ...S, setupCode: mintSetupCode().code }, 'test-box')
  if (!a.ok) throw new Error(a.sentence)
  seed = base32Decode(a.secret)
  expect((await confirmAuthenticator(code(), S)).ok).toBe(true)
  next()
  expect((await enrolPresence('hello', { ...S, code: code() })).ok).toBe(true)
  next()
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  expect((await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).ok).toBe(true)
  next()
}

afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-authpolicy-done-')), 'vault') }) })

const FULL = { hasAuthenticator: true, hasPresence: true }
const mapped = Object.entries(ACTION_KIND_OF).filter(([a]) => a !== 'personal-reveal') as [VaultAction, ActionKind][]

describe('the defaults are today\'s rows, exactly', () => {
  test('policyRow with no policy returns the table\'s row for every action', () => {
    for (const a of Object.keys(VAULT_ACTION_ROWS) as VaultAction[]) {
      expect(policyRow(a, L, null, FULL)).toEqual(VAULT_ACTION_ROWS[a])
    }
  })
  test('every mapped action\'s row matches its kind\'s default', () => {
    for (const [a, kind] of Object.entries(ACTION_KIND_OF) as [VaultAction, ActionKind][]) {
      const row = VAULT_ACTION_ROWS[a]
      expect(proofsFor(ACTION_KINDS[kind].default, FULL)).toEqual({ code: row.code, gesture: row.gesture })
    }
  })
})

describe('the server gate — every mapped action × every allowed choice', () => {
  beforeEach(async () => { await ownerMachine() })

  for (const [action, kind] of mapped) {
    for (const choice of choicesFor(kind)) {
      test(`${action} (${kind}) = ${choice}`, async () => {
        await writeAuthPolicy({ v: 1, choices: { [kind]: choice } })
        const want = proofsFor(choice, FULL)
        const g0 = hello.gestures
        if (want.code) {
          expect(await requireVaultStepUp(action, L)).toMatchObject({ ok: false, code: 'stepup-required' })
          expect(hello.gestures - g0).toBe(0) // refusing for the code raises no prompt
          expect((await requireVaultStepUp(action, { ...L, code: code() })).ok).toBe(true)
          next()
        } else {
          expect((await requireVaultStepUp(action, L)).ok).toBe(true)
        }
        expect(hello.gestures - g0).toBe(want.gesture ? 1 : 0)
      })
    }
  }

  test('a cancelled gesture still refuses when the choice asks the gesture', async () => {
    await writeAuthPolicy({ v: 1, choices: { 'delete-secret': 'gesture' } })
    hello.cancel = true
    expect((await requireVaultStepUp('personal-purge', L)).ok).toBe(false)
  })

  test('"none" OFF this computer is never nothing: the code (riding the read grant)', async () => {
    await writeAuthPolicy({ v: 1, choices: { use: 'none' } })
    expect(await requireVaultStepUp('personal-grant', S)).toMatchObject({ ok: false, code: 'stepup-required' })
    const ok = await requireVaultStepUp('personal-grant', { ...S, code: code() })
    next()
    expect(ok.ok && ok.grant).toBeString()
  })
})

describe('reveal — requirePersonalReveal under each choice', () => {
  beforeEach(async () => { await ownerMachine() })
  const R = { ...L, binding: 'item:value' }

  test('gesture (the default): one Hello, no code', async () => {
    const g0 = hello.gestures
    expect((await requirePersonalReveal(R)).ok).toBe(true)
    expect(hello.gestures - g0).toBe(1)
  })
  test('none: no code, no prompt — at this computer only', async () => {
    await writeAuthPolicy({ v: 1, choices: { reveal: 'none' } })
    const g0 = hello.gestures
    expect((await requirePersonalReveal(R)).ok).toBe(true)
    expect(hello.gestures - g0).toBe(0)
    expect(await requirePersonalReveal({ ...S, binding: 'item:value' })).toMatchObject({ ok: false, code: 'stepup-required' })
  })
  test('code: the code, fresh, and no prompt', async () => {
    await writeAuthPolicy({ v: 1, choices: { reveal: 'code' } })
    const g0 = hello.gestures
    expect(await requirePersonalReveal(R)).toMatchObject({ ok: false, code: 'stepup-required' })
    expect((await requirePersonalReveal({ ...R, code: code() })).ok).toBe(true)
    next()
    expect(hello.gestures - g0).toBe(0)
    expect(await requirePersonalReveal(R)).toMatchObject({ ok: false, code: 'stepup-required' }) // fresh each time
  })
  test('both: the code and one Hello', async () => {
    await writeAuthPolicy({ v: 1, choices: { reveal: 'both' } })
    const g0 = hello.gestures
    expect(await requirePersonalReveal(R)).toMatchObject({ ok: false, code: 'stepup-required' })
    expect((await requirePersonalReveal({ ...R, code: code() })).ok).toBe(true)
    next()
    expect(hello.gestures - g0).toBe(1)
  })
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
      expect(await setAuthPolicy({ [k]: 'none' }, { ...L, code: code() })).toMatchObject({ ok: false, code: 'bad-request' })
    }
    expect(await setAuthPolicy({ reveal: 'none', wipe: 'none' }, { ...L, code: code() })).toMatchObject({ ok: false, code: 'bad-request' })
    expect((await readAuthPolicy()).state).toBe('default')
  })

  test('costs a proof: by default the code AND the gesture; refused without the code', async () => {
    const g0 = hello.gestures
    expect(await setAuthPolicy({ reveal: 'none' }, L)).toMatchObject({ ok: false, code: 'stepup-required' })
    expect((await readAuthPolicy()).state).toBe('default')
    expect((await setAuthPolicy({ reveal: 'none', settings: 'code' }, { ...L, code: code() })).ok).toBe(true)
    next()
    expect(hello.gestures - g0).toBe(1)
    const r = await readAuthPolicy()
    expect(r).toEqual({ state: 'stored', policy: { v: 1, choices: { reveal: 'none', settings: 'code' } } })
    // The next change follows the CHOSEN settings row: the code alone, no prompt — never nothing.
    const g1 = hello.gestures
    expect(await setAuthPolicy({ settings: 'both' }, L)).toMatchObject({ ok: false, code: 'stepup-required' })
    expect((await setAuthPolicy({ settings: 'both' }, { ...L, code: code() })).ok).toBe(true)
    next()
    expect(hello.gestures - g1).toBe(0)
  })

  test('the record is sealed: its bytes never carry the choices in plain text', async () => {
    await writeAuthPolicy({ v: 1, choices: { reveal: 'none' } })
    const raw = await Bun.file(authPolicyFile()).text()
    expect(raw).not.toContain('reveal')
    expect(raw).not.toContain('none')
  })

  test('a record that cannot be opened reads as the STRICTEST: both proofs everywhere', async () => {
    writeFileSync(authPolicyFile(), 'not a sealed record')
    chmodSync(authPolicyFile(), 0o600)
    const r = await readAuthPolicy()
    expect(r.state).toBe('unreadable')
    const v = await authPolicyView()
    expect(v.rows.every(x => x.choice === 'both')).toBe(true)
    const g0 = hello.gestures
    expect(await requirePersonalReveal({ ...L, binding: 'i:v' })).toMatchObject({ ok: false, code: 'stepup-required' })
    expect((await requirePersonalReveal({ ...L, binding: 'i:v', code: code() })).ok).toBe(true)
    next()
    expect(hello.gestures - g0).toBe(1)
  })

  test('the view lists every kind with its choices, and no critical kind offers "none"', async () => {
    const v = await authPolicyView()
    expect(v.rows.map(r => r.kind)).toEqual([...ACTION_KINDS_ORDER])
    for (const r of v.rows) {
      expect(r.choice).toBe(r.default)
      if (r.critical) expect(r.choices).not.toContain('none' as ProofChoice)
    }
  })
})
