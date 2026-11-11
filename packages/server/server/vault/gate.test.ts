/**
 * SECRETS.4 S4.7 on the host — §12.2 (two-phase unlock), §12.4 (recovery), §12.5 (auto-lock) and a test
 * for EVERY row of the §2.4 table. Fake protectors (a silent "dpapi", a "hello" that counts gestures)
 * and a fake clock; nothing is spawned.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { engineSecrets } from './engine-secrets'
import { base32Decode, hotp, parseVaultJson, refusalSentence, type Protector, type ProtectorId, type UnwrapResult } from '@agentistics/vault'
import {
  __resetVaultForTests, __setVaultClockForTests, autoLockTick, ensureVaultOpen, noteVaultActivity, openFromFile, pendingUnlock,
  sealToFile, unlockWithGesture, vaultDir, vaultStatus,
} from './service'
import {
  VAULT_ACTION_ROWS, __resetGateForTests, acceptSetupCode, beginAuthenticator, mintSetupCode, beginRecoveryKey, completeUnlock, confirmAuthenticator, confirmRecoveryKey,
  enrolPresence, grantValid, mintGrant, recoverWithWords, requireVaultStepUp, setAutoLockMinutes, stepUpState, addPassphraseAllowed,
  type VaultAction,
} from './gate'

// ── fakes ─────────────────────────────────────────────────────────────────────────────────────

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
// COFRE.DESBLOQUEIO (2026-11-07): no authenticator, no seed. A "code" a test passes is IGNORED by the gate.
const codeAt = (_offset = 0) => '123456'
const next = () => { T += 30_000 }

let dir = ''
let dpapi = fake('dpapi')
let hello = fake('hello')
/** A page ON this computer (loopback): the only page a gesture may be raised for (COFRE.DESBLOQUEIO). */
const S = { session: 'session-A', loopback: true }
/** The same session from another device (a LAN / tailnet page): never a dialog on this computer. */
const REMOTE = { session: 'session-A' }
const MARK = 'TEST-NOT-A-SECRET-' + randomBytes(6).toString('hex')

function restart(): void {
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
}

/** The owner flow (COFRE.DESBLOQUEIO): vault (silent) → presence → recovery key (silent removed). No authenticator. */
async function ownerMachine(): Promise<{ words: string[] }> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-gate-'))
  dpapi = fake('dpapi'); hello = fake('hello')
  restart()
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode(MARK))
  // The page's first enrolment carries the one-time setup code the service printed (review S2).
  expect((await acceptSetupCode({ ...S, setupCode: mintSetupCode().code })).ok).toBe(true)
  // The authenticator is gone from every channel.
  expect((await beginAuthenticator(S, 'test-box')).ok).toBe(false)
  // Leader decision 2: presence BEFORE the recovery key (presence replaces the data key; the words are
  // made LAST so they wrap the final key and are never kept in memory across steps).
  const p = await enrolPresence('hello', { ...S, code: codeAt() })
  // Leader decision 2026-10-02: presence is HELD — nothing written, the silent wrapper stays until the words are confirmed.
  expect(p).toMatchObject({ ok: true, removed: [], recoveryOwed: true })
  next()
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  expect(r.words).toHaveLength(24)
  expect((await confirmRecoveryKey(['zoo', 'zoo', 'zoo'])).ok).toBe(r.positions.every(p => r.words[p - 1] === 'zoo'))
  expect((await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)).ok).toBe(true)
  next()
  return { words: r.words }
}

afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-gate-done-')), 'vault') }) })

describe('the owner flow, then a restart (§1.2, §2.2)', () => {
  test('enrolment leaves presence + recovery and NO silent wrapper; a restart is locked without a dialog', async () => {
    await ownerMachine()
    const v = parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!
    expect(v.wrappers.map(w => w.type).sort()).toEqual(['hello', 'recovery'])
    expect(v.stepup).toBeUndefined() // COFRE.DESBLOQUEIO: no authenticator is ever recorded again
    expect(STORE.has(`dpapi:${v.kid}`)).toBe(false)

    restart()
    const before = hello.gestures
    expect(await ensureVaultOpen()).toBeNull()               // a consumer never raises Hello…
    expect(hello.gestures).toBe(before)                       // …not even once
    const s = await vaultStatus()
    expect(s.state).toBe('locked')
    expect(s.sentence).toBe(refusalSentence('presence-required', 'en', { presence: 'Windows Hello' }))
    const r = await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')
    expect(!r.ok && !r.absent && r.code).toBe('presence-required')
  })

  test('COFRE.DESBLOQUEIO: the gesture ALONE opens it — no code is owed, nothing waits, a code endpoint has nothing to complete', async () => {
    await ownerMachine()
    restart()
    const g0 = hello.gestures
    expect(await unlockWithGesture()).toMatchObject({ ok: true, state: 'open' })
    expect(hello.gestures - g0).toBe(1)
    expect(pendingUnlock()).toBeNull()
    const r = await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')
    expect(r.ok && new TextDecoder().decode(r.plaintext)).toBe(MARK)
    expect((await completeUnlock(codeAt())).ok).toBe(false)
  })

  test('a cancelled gesture says so and opens nothing', async () => {
    await ownerMachine()
    restart()
    hello.cancel = true
    const u = await unlockWithGesture()
    expect(u).toMatchObject({ ok: false, code: 'presence-cancelled' })
    expect(pendingUnlock()).toBeNull()
  })
})

describe('§2.4 — every row of the table', () => {
  beforeEach(async () => { await ownerMachine() })

  const rows = Object.entries(VAULT_ACTION_ROWS).filter(([a]) => a !== 'unlock') as [VaultAction, (typeof VAULT_ACTION_ROWS)[VaultAction]][]
  for (const [action, row] of rows) {
    // COFRE.DESBLOQUEIO (owner, 2026-11-07): every row that asked the code OR the gesture now asks the
    // person's ONE proof — here Windows Hello. A code is never asked and never helps.
    test(`${action}: asks ${row.code || row.gesture ? 'the proof' : 'nothing'}${row.code && !row.gesture && row.grant ? ', reusable for 5 min' : row.code || row.gesture ? ', fresh' : ''}`, async () => {
      if (action === 'personal-grant') return // VAULT.UI2: loopback needs no proof, a phone needs its passkey — see the dedicated describe below
      if (!row.code && !row.gesture) {
        expect((await requireVaultStepUp(action, S)).ok).toBe(true)
        return
      }
      const g0 = hello.gestures
      const ok = await requireVaultStepUp(action, S)
      expect(ok.ok).toBe(true)
      expect(hello.gestures - g0).toBe(1)
      // A code is not a proof: with the gesture cancelled, the code changes nothing.
      hello.cancel = true
      expect((await requireVaultStepUp(action, { ...S, code: codeAt() })).ok).toBe(false)
      hello.cancel = false
      if (row.code && !row.gesture && row.grant) {
        // What only asked the CODE keeps its 5-minute grant: the proof once, then reused — this session only.
        const grant = ok.ok ? ok.grant : undefined
        expect(grant).toBeString()
        const g1 = hello.gestures
        expect((await requireVaultStepUp(action, { ...S, grant })).ok).toBe(true)
        expect(hello.gestures).toBe(g1)                                                   // reused
        expect((await requireVaultStepUp(action, { ...S, session: 'session-B', grant })).ok).toBe(true)
        expect(hello.gestures).toBe(g1 + 1)                                               // bound to the session: asked again
      } else if (row.gesture) {
        // A fresh proof: a read grant never stands for it.
        const read = await requireVaultStepUp('set-auto-lock', S)
        const g1 = hello.gestures
        expect((await requireVaultStepUp(action, { ...S, grant: read.ok ? read.grant : undefined })).ok).toBe(true)
        expect(hello.gestures).toBe(g1 + 1)
      }
    })
  }

  test('a cancelled gesture refuses a destructive action even with the right code', async () => {
    hello.cancel = true
    expect((await requireVaultStepUp('reset', { ...S, code: codeAt() })).ok).toBe(false)
  })

  test('lock and lock-local ask nothing (locking only reduces exposure); set-auto-lock is gated; set-auto-lock refuses "never"', async () => {
    const g0 = hello.gestures
    expect((await requireVaultStepUp('lock', S)).ok).toBe(true)
    expect((await requireVaultStepUp('lock-local', S)).ok).toBe(true)
    expect(hello.gestures).toBe(g0)
    hello.cancel = true
    expect((await requireVaultStepUp('set-auto-lock', S)).ok).toBe(false)
    hello.cancel = false
    expect((await setAutoLockMinutes('never', { ...S, code: codeAt() })).ok).toBe(false)
    expect((await setAutoLockMinutes(0, { ...S, code: codeAt() })).ok).toBe(false)
    expect((await setAutoLockMinutes(45, { ...S, code: codeAt() })).ok).toBe(true)
    next()
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.autoLock).toEqual({ minutes: 45 })
  })

  test('a grant expires after 5 minutes', () => {
    const g = mintGrant('s', 'read', T)
    expect(grantValid(g, 's', 'read', T + 299_000)).toBe(true)
    expect(grantValid(g, 's', 'read', T + 301_000)).toBe(false)
    expect(grantValid(g.replace(/.$/, c => (c === '0' ? '1' : '0')), 's', 'read', T)).toBe(false)
  })

  test('add-passphrase is refused where a protector exists (§4.3)', async () => {
    const o = await ensureVaultOpen()
    expect(addPassphraseAllowed(o!.vault)).toMatchObject({ ok: false, code: 'passphrase-replaced' })
  })
})

describe('VAULT.UI2 — the grant for a :vault chip, and the extension of an open vault', () => {
  beforeEach(async () => { await ownerMachine() })

  test('"Sempre confirmar" OFF on every chosen secret: an open vault is the proof — no code, no gesture', async () => {
    const g0 = hello.gestures
    for (let i = 0; i < 3; i++) expect(await requireVaultStepUp('personal-grant-open', { ...S, loopback: true })).toMatchObject({ ok: true })
    expect(hello.gestures - g0).toBe(0)
  })

  test('"Sempre confirmar" ON (the default): the gesture, fresh each time, and NEVER the code', async () => {
    const g0 = hello.gestures
    expect(await requireVaultStepUp('personal-grant', { ...S, loopback: true })).toMatchObject({ ok: true })
    expect(await requireVaultStepUp('personal-grant', { ...S, loopback: true })).toMatchObject({ ok: true })
    expect(hello.gestures - g0).toBe(2)
    hello.cancel = true
    expect((await requireVaultStepUp('personal-grant', { ...S, loopback: true })).ok).toBe(false)
  })

  test('locked: refused as locked either way — the composer opens the vault once first', async () => {
    lockVault('user')
    expect(await requireVaultStepUp('personal-grant-open', { ...S, loopback: true })).toMatchObject({ ok: false, code: 'locked' })
    expect(await requireVaultStepUp('personal-grant', { ...S, loopback: true })).toMatchObject({ ok: false, code: 'locked' })
  })

  test('locked → one unlock → an OFF secret then goes with no more prompts until it locks again', async () => {
    lockVault('user')
    expect(await unlockWithGesture()).toMatchObject({ ok: true, state: 'open' })
    const g0 = hello.gestures
    for (let i = 0; i < 3; i++) expect((await requireVaultStepUp('personal-grant-open', { ...S, loopback: true })).ok).toBe(true)
    expect(hello.gestures - g0).toBe(0)
    lockVault('user')
    expect((await requireVaultStepUp('personal-grant-open', { ...S, loopback: true })).ok).toBe(false)
  })

  test('a remote origin never gets a Hello prompt: an ON secret wants the phone passkey token', async () => {
    const g0 = hello.gestures
    expect(await requireVaultStepUp('personal-grant', REMOTE)).toMatchObject({ ok: false, code: 'mobile-gesture-required' })
    expect(hello.gestures - g0).toBe(0)
  })
  test('COFRE.DESBLOQUEIO: nothing raises a dialog on an empty desk — not even what used to ask only the code', async () => {
    const g0 = hello.gestures
    for (const a of ['set-auto-lock', 'reset', 'set-auth-policy', 'create-recovery'] as VaultAction[]) {
      expect(await requireVaultStepUp(a, REMOTE)).toMatchObject({ ok: false, code: 'mobile-gesture-required' })
    }
    expect(hello.gestures - g0).toBe(0)
  })

  test('polling the list is not use: it does not postpone the auto-lock', async () => {
    const before = autoLockRemainingMs()!
    T += 10 * 60_000
    expect((await requireVaultStepUp('list', { ...S, loopback: true })).ok).toBe(true)
    expect(autoLockRemainingMs()!).toBeLessThan(before - 9 * 60_000)
  })

  test('extend-open: fresh Hello even with a grant or code; cancellation never counts as activity', async () => {
    expect(VAULT_ACTION_ROWS['extend-open']).toEqual({ code: false, gesture: true, grant: null })
    const g0 = hello.gestures
    expect((await requireVaultStepUp('extend-open', { ...S, loopback: true })).ok).toBe(true)
    expect(hello.gestures).toBe(g0 + 1)
    hello.cancel = true
    T += 60_000
    const before = autoLockRemainingMs()
    for (const proof of [{}, { grant: mintGrant(S.session, 'read') }, { code: codeAt() }]) {
      expect(await requireVaultStepUp('extend-open', { ...S, loopback: true, ...proof })).toMatchObject({ ok: false, code: 'presence-cancelled' })
      expect(autoLockRemainingMs()).toBe(before)
    }
    expect(await requireVaultStepUp('extend-open', { ...REMOTE, code: codeAt() })).toMatchObject({ ok: false, code: 'mobile-gesture-required' })
    hello.cancel = false
  })

  test('extendAutoLock moves the clock by a whole window, audited; nothing open → null', async () => {
    const before = autoLockRemainingMs()!
    T += 25 * 60_000
    expect(autoLockRemainingMs()!).toBeLessThan(before)
    const left = extendAutoLock()
    expect(left).toBeGreaterThan(before - 1000)
    expect(readFileSync(join(vaultDir(), 'audit.jsonl'), 'utf8')).toContain('vault.auto-lock-extended')
    lockVault('user')
    expect(extendAutoLock()).toBeNull()
  })
})

describe('VAULT.UI2 — a provider session start prompts at most ONCE (owner, 2026-10-04: it asked twice)', () => {
  const PURPOSE = 'engine/provider-key', NAME = 'anthropic'
  const secrets = () => engineSecrets()
  /** An owner machine that has done its day's first open (Hello + code), then locked: Hello alone reopens it. */
  const warmWindow = async () => { await ownerMachine(); restart(); await coldUnlock(); lockVault('user') }

  test('vault OPEN: sealing and opening the provider key raise 0 prompts', async () => {
    await ownerMachine()
    restart(); await coldUnlock()
    const g0 = hello.gestures
    const sealed = await secrets().seal(PURPOSE, NAME, new TextEncoder().encode('sk-test-NOT-A-KEY'))
    expect(sealed.ok).toBe(true)
    for (let i = 0; i < 3; i++) expect((await secrets().open(PURPOSE, NAME, (sealed as { sealed: Uint8Array }).sealed)).ok).toBe(true)
    expect(hello.gestures - g0).toBe(0)
  })

  test('vault LOCKED: the open refuses without prompting; ONE Hello opens it; every start after that is silent', async () => {
    await warmWindow()
    await unlockWithGesture()
    const sealed = (await secrets().seal(PURPOSE, NAME, new TextEncoder().encode('sk-test-NOT-A-KEY'))) as { sealed: Uint8Array }
    lockVault('user')
    const g0 = hello.gestures
    expect(await secrets().open(PURPOSE, NAME, sealed.sealed)).toMatchObject({ ok: false, code: 'locked' })
    expect(hello.gestures - g0).toBe(0)                     // refusing is not prompting
    expect(await unlockWithGesture()).toMatchObject({ ok: true, state: 'open' }) // inside the per-day window: Hello alone
    for (let i = 0; i < 3; i++) expect((await secrets().open(PURPOSE, NAME, sealed.sealed)).ok).toBe(true)
    expect(hello.gestures - g0).toBe(1)                     // exactly one prompt for the whole sequence
  })

  test('opening and then sending a chip with "Sempre confirmar" ON costs ONE Hello, not two', async () => {
    await warmWindow()
    const g0 = hello.gestures
    // Review H2: the page declares the send its unlock is for, and gets the single-use proof in the reply.
    const u = await unlockWithGesture(undefined, { session: S.session, binding: 'personal-grant:sess-1' })
    expect(u).toMatchObject({ ok: true, state: 'open' })
    const fresh = u.ok ? u.fresh : undefined
    expect((await requireVaultStepUp('personal-grant', { ...S, loopback: true, fresh, binding: 'sess-1' })).ok).toBe(true) // covered by the unlock's Hello
    expect(hello.gestures - g0).toBe(1)
    // the cover is single-use: the NEXT send asks again
    expect((await requireVaultStepUp('personal-grant', { ...S, loopback: true, fresh, binding: 'sess-1' })).ok).toBe(true)
    expect(hello.gestures - g0).toBe(2)
  })

  test('the cover dies with the lock and with time', async () => {
    await warmWindow()
    await unlockWithGesture()
    lockVault('user')
    await unlockWithGesture()
    T += 120_000
    const g0 = hello.gestures
    expect((await requireVaultStepUp('personal-grant', { ...S, loopback: true })).ok).toBe(true)
    expect(hello.gestures - g0).toBe(1)
  })
})

describe('COFRE.DESBLOQUEIO: a code is never judged, so nothing can be frozen by one', () => {
  test('twenty wrong codes count nothing, write no counter and lock nothing', async () => {
    await ownerMachine()
    for (let i = 0; i < 20; i++) { T += 16 * 60_000; await requireVaultStepUp('set-auto-lock', { ...S, code: '000000' }) }
    expect((await stepUpState()).frozen).toBe(false)
    expect((await stepUpState()).failures).toBe(0)
    expect(existsSync(join(vaultDir(), 'stepup.json'))).toBe(false)
    expect((await vaultStatus()).lockedBy).not.toBe('stepup-frozen')
  })
})

describe('§4.3 / §12.4 recovery', () => {
  test('recover → recovery mode refuses everything but the two re-enrolment steps; afterwards the old words are dead', async () => {
    const { words } = await ownerMachine()
    restart()
    expect((await recoverWithWords(words.slice(0, 23).join(' '))).ok).toBe(false)
    const r = await recoverWithWords(words.map(w => w.slice(0, 4)).join(' '))
    // COFRE.DESBLOQUEIO: no authenticator step — a way to confirm, and new words.
    expect(r).toMatchObject({ ok: true, todo: ['presence', 'recovery'] })
    for (const a of ['list', 'reset', 'rekey', 'set-auto-lock', 'disable-presence'] as VaultAction[]) {
      expect(await requireVaultStepUp(a, { ...S, code: codeAt() })).toMatchObject({ ok: false, code: 'recovery-mode' })
    }
    // (a) presence, (b) a NEW recovery key — neither needs the lost factors, and both answer the local
    // terminal's channel only (review M2: never an HTTP session)
    const SOCK = { session: 'socket' }
    expect((await enrolPresence('hello', SOCK)).ok).toBe(true)
    const k = await beginRecoveryKey(SOCK)
    if (!k.ok) throw new Error(k.sentence)
    expect((await confirmRecoveryKey(k.positions.map(p => k.words[p - 1]!))).ok).toBe(true)
    expect((await vaultStatus()).recoveryTodo).toBeNull()
    // the old words no longer open the vault
    restart()
    expect((await recoverWithWords(words.join(' '))).ok).toBe(false)
    expect((await recoverWithWords(k.words.join(' '))).ok).toBe(true)
  })

  test('the words never appear in the audit trail or the vault files', async () => {
    const { words } = await ownerMachine()
    restart()
    await recoverWithWords(words.join(' '))
    const audit = readFileSync(join(vaultDir(), 'audit.jsonl'), 'utf8')
    const vjson = readFileSync(join(vaultDir(), 'vault.json'), 'utf8')
    for (const blob of [audit, vjson]) {
      expect(blob).not.toContain(words.slice(0, 3).join(' '))
      expect(blob).not.toContain(MARK)
    }
    expect(audit).toContain('vault.recovered')
  })
})

describe('§5.1 / §12.5 auto-lock', () => {
  test('idle 30 min → locked, the DEK buffer zeroed, audited; human activity resets the clock, a decrypt does not', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentistics-autolock-'))
    dpapi = fake('dpapi'); hello = fake('hello')
    restart()
    await sealToFile(join(dir, 'x.sealed'), 'github-backup', 'n', new Uint8Array([1, 2, 3]))
    const o = await ensureVaultOpen()
    const dekRef = o!.dek
    const t0 = T
    expect(autoLockTick(t0 + 29 * 60_000)).toBe(false)
    T = t0 + 20 * 60_000
    noteVaultActivity()
    expect(autoLockTick(t0 + 49 * 60_000)).toBe(false)
    T = t0 + 45 * 60_000
    // A decrypt (a harness ref, a hook, a backup) is machine traffic: it never keeps the vault open.
    expect((await openFromFile(join(dir, 'x.sealed'), 'github-backup', 'n')).ok).toBe(true)
    expect(autoLockTick(t0 + 49 * 60_000)).toBe(false)
    expect(autoLockTick(t0 + 50 * 60_000)).toBe(true)
    expect(dekRef.every(b => b === 0)).toBe(true)
    expect((await vaultStatus()).lockedBy).toBe('auto-lock')
    expect(readFileSync(join(vaultDir(), 'audit.jsonl'), 'utf8')).toContain('vault.auto-locked')
  })

  test('a presence vault that auto-locked says so, and stays locked until a gesture', async () => {
    await ownerMachine()
    restart()
    expect(await unlockWithGesture()).toMatchObject({ ok: true, state: 'open' })
    expect(autoLockTick(T + 31 * 60_000)).toBe(true)
    expect(await ensureVaultOpen()).toBeNull()
    expect((await vaultStatus()).sentence).toBe(refusalSentence('auto-locked', 'en', { minutes: 30, presence: 'Windows Hello' }))
  })
})

// ── the unlock policy (owner decision 2026-10-02): always / hello-only / daily (the default) ─────

import { autoLockRemainingMs, extendAutoLock, lockVault, unlockWindowAnchor, unlockWindowHint, unlockWindowSettled, UNLOCK_WINDOW_FILE } from './service'
import { writeFileSync } from 'node:fs'
import { disablePresence, setUnlockPolicy } from './gate'
import { readVaultView } from './inventory'

/** An unlock from a cold (just restarted) service: since COFRE.DESBLOQUEIO, the gesture alone. */
async function coldUnlock(): Promise<void> {
  expect(await unlockWithGesture()).toMatchObject({ ok: true, state: 'open' })
}

// The "unlock policy" (always / hello-only / per-day CODE window) existed only to decide when the
// authenticator code was owed at an unlock. With the code gone (owner, 2026-11-07) every unlock is the
// person's proof alone, whatever a vault.json from before says.
describe('COFRE.DESBLOQUEIO — every unlock is the proof alone, whatever an older unlock policy says', () => {
  for (const mode of ['always', 'daily', 'hello-only'] as const) {
    test(`a vault that recorded "${mode}" opens with the gesture alone, cold and after a lock`, async () => {
      await ownerMachine()
      const v = parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!
      writeFileSync(join(vaultDir(), 'vault.json'), JSON.stringify({ ...v, unlockPolicy: { mode, hours: 12 } }))
      restart()
      await coldUnlock()
      lockVault('auto-lock'); T += 25 * 3_600_000
      await coldUnlock()
      expect(unlockWindowAnchor()).toBeNull()
    })
  }
  test('setting the policy is still a protected setting (the proof, fresh) and refuses what is not a policy', async () => {
    await ownerMachine()
    for (const bad of [{ mode: 'never', hours: 12 }, { mode: 'daily', hours: 0 }, { mode: 'daily', hours: 25 }, { mode: 'daily', hours: 1.5 }]) {
      const r = await setUnlockPolicy(bad, S)
      expect(!r.ok && r.code).toBe('bad-request')
    }
    hello.cancel = true
    expect((await setUnlockPolicy({ mode: 'daily', hours: 8 }, S)).ok).toBe(false)
    hello.cancel = false
  })
})

describe('COFRE.DESBLOQUEIO — migration: a vault that still records an authenticator', () => {
  /** A vault as an older version left it: an authenticator recorded, its sealed seed and counter on disk. */
  async function legacy(): Promise<void> {
    await ownerMachine()
    const v = parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!
    writeFileSync(join(vaultDir(), 'vault.json'), JSON.stringify({ ...v, stepup: { enrolledAt: '2026-10-01T00:00:00.000Z', digits: 6, period: 30 }, unlockPolicy: { mode: 'always', hours: 24 } }))
    writeFileSync(join(vaultDir(), 'totp-seed.sealed'), 'legacy-seed-placeholder')
    writeFileSync(join(vaultDir(), 'stepup.json'), JSON.stringify({ v: 1, failures: 3, lastStep: 1, pausedUntilMs: null, frozen: false }))
    restart()
  }
  test('it keeps opening — with the gesture alone; the code is never asked', async () => {
    await legacy()
    await coldUnlock()
    const g0 = hello.gestures
    expect((await requireVaultStepUp('set-auto-lock', S)).ok).toBe(true)
    expect(hello.gestures - g0).toBe(1)
  })
  test('the view never reports it as enrolled, only as a legacy fact', async () => {
    await legacy()
    await coldUnlock()
    const view = await readVaultView([], async () => [], S.session, true)
    expect(view.authenticator).toBeNull()
    expect(view.legacyAppCode).toBe(true)
  })
  test('setting up a new way to confirm DROPS it: vault.json loses the record, the seed and the counter are deleted', async () => {
    await legacy()
    await coldUnlock()
    const SOCK = { session: 'socket' }
    // a second way (the first already protects the vault): hello is there, so add it again via the socket's flow
    const v0 = parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!
    expect(v0.stepup).toBeDefined()
    // Retire through a real enrolment: turn presence off (back to silent), then on again.
    const off = await disablePresence(SOCK)
    expect(off.ok).toBe(true)
    const on = await enrolPresence('hello', { ...SOCK, replaceRecovery: true })
    expect(on.ok).toBe(true)
    const k = await beginRecoveryKey(SOCK)
    if (!k.ok) throw new Error(k.sentence)
    expect((await confirmRecoveryKey(k.positions.map(p => k.words[p - 1]!), SOCK)).ok).toBe(true)
    const v = parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!
    expect(v.stepup).toBeUndefined()
    expect(v.unlockPolicy).toBeUndefined()
    expect(existsSync(join(vaultDir(), 'totp-seed.sealed'))).toBe(false)
    expect(existsSync(join(vaultDir(), 'stepup.json'))).toBe(false)
    expect(readFileSync(join(vaultDir(), 'audit.jsonl'), 'utf8')).toContain('vault.authenticator-retired')
  })
})
