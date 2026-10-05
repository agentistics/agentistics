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
  VAULT_ACTION_ROWS, __resetGateForTests, beginAuthenticator, mintSetupCode, beginRecoveryKey, completeUnlock, confirmAuthenticator, confirmRecoveryKey,
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
const step = () => Math.floor(T / 1000 / 30)
let seed: Uint8Array
const codeAt = (offset = 0) => hotp(seed, step() + offset)
/** Every accepted code burns its step (replay): move to the next one. */
const next = () => { T += 30_000 }

let dir = ''
let dpapi = fake('dpapi')
let hello = fake('hello')
const S = { session: 'session-A' }
const MARK = 'TEST-NOT-A-SECRET-' + randomBytes(6).toString('hex')

function restart(): void {
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
}

/** The §7.3 owner flow: vault (silent) → authenticator → recovery key → presence (silent removed). */
async function ownerMachine(): Promise<{ words: string[] }> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-gate-'))
  dpapi = fake('dpapi'); hello = fake('hello')
  restart()
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode(MARK))
  // The page's first enrolment carries the one-time setup code the service printed (review S2).
  const a = await beginAuthenticator({ ...S, setupCode: mintSetupCode().code }, 'test-box')
  if (!a.ok) throw new Error(a.sentence)
  seed = base32Decode(a.secret)
  expect(a.uri).toStartWith('otpauth://totp/Agentistics:test-box?')
  // The URI is served ONCE.
  expect((await beginAuthenticator({ ...S, setupCode: mintSetupCode().code }, 'test-box')).ok).toBe(false)
  expect((await confirmAuthenticator(codeAt(0), S)).ok).toBe(true)
  next()
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
    expect(v.stepup).toMatchObject({ digits: 6, period: 30 })
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

  test('gesture → pending-stepup: NOTHING opens until the code; a wrong code zeroes the key (bytes asserted)', async () => {
    await ownerMachine()
    restart()
    expect(await unlockWithGesture()).toMatchObject({ ok: true, state: 'pending-stepup' })
    const pending = pendingUnlock()!
    const dekRef = pending.dek
    expect(dekRef.some(b => b !== 0)).toBe(true)
    expect(await ensureVaultOpen()).toBeNull()
    expect((await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')).ok).toBe(false)
    const wrong = await completeUnlock('000000' === codeAt() ? '111111' : '000000')
    expect(wrong.ok).toBe(false)
    expect(dekRef.every(b => b === 0)).toBe(true)
    expect(pendingUnlock()).toBeNull()
    expect((await vaultStatus()).state).toBe('locked')
    // and the right one, after a fresh gesture
    expect((await unlockWithGesture()).ok).toBe(true)
    expect((await completeUnlock(codeAt())).ok).toBe(true)
    next()
    const r = await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')
    expect(r.ok && new TextDecoder().decode(r.plaintext)).toBe(MARK)
  })

  test('pending-stepup expires at 120 s and zeroes the key', async () => {
    await ownerMachine()
    restart()
    await unlockWithGesture()
    const dekRef = pendingUnlock()!.dek
    T += 119_000
    expect(pendingUnlock()).not.toBeNull()
    T += 2_000
    expect(pendingUnlock()).toBeNull()
    expect(dekRef.every(b => b === 0)).toBe(true)
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
    test(`${action}: code ${row.code ? 'yes' : 'no'}, gesture ${row.gesture ? 'yes' : 'no'}, grant ${row.grant ?? 'none'}`, async () => {
      // A personal-secret row is the DESKTOP rule on a loopback page (off loopback the gesture is a phone
      // passkey token — tested in mobile.test.ts).
      if (action === 'personal-grant') return // VAULT.UI2: loopback needs no proof, a phone needs its passkey — see the dedicated describe below
      // Review M3: a no-proof row is the rule for THIS computer (a remote caller owes the code — review-2-103-2.test.ts).
      const C = action.startsWith('personal-') || (!row.code && !row.gesture) ? { ...S, loopback: true } : S
      if (!row.code && !row.gesture) {
        expect((await requireVaultStepUp(action, C)).ok).toBe(true)
        return
      }
      if (!row.code) {
        // Gesture only (§10 the computer's approval of a phone): no code asked, Hello raised, fresh, no grant.
        const g0 = hello.gestures
        const ok = await requireVaultStepUp(action, C)
        expect(ok).toMatchObject({ ok: true })
        expect(ok.ok && ok.grant).toBeFalsy()
        expect(hello.gestures - g0).toBe(1)
        return
      }
      expect(await requireVaultStepUp(action, C)).toMatchObject({ ok: false, code: 'stepup-required' })
      const g0 = hello.gestures
      const ok = await requireVaultStepUp(action, { ...C, code: codeAt() })
      next()
      expect(ok.ok).toBe(true)
      expect(hello.gestures - g0).toBe(row.gesture ? 1 : 0)
      if (row.grant) {
        const grant = ok.ok ? ok.grant : undefined
        expect(grant).toBeString()
        expect((await requireVaultStepUp(action, { ...C, grant })).ok).toBe(true)                       // reused
        expect((await requireVaultStepUp(action, { ...C, session: 'session-B', grant })).ok).toBe(false)     // bound to the session
      } else {
        // destructive: a grant from a read step-up is NOT accepted
        const read = await requireVaultStepUp('set-auto-lock', { ...S, code: codeAt() })
        next()
        expect((await requireVaultStepUp(action, { ...C, grant: read.ok ? read.grant : undefined })).ok).toBe(false)
      }
    })
  }

  test('a cancelled gesture refuses a destructive action even with the right code', async () => {
    hello.cancel = true
    expect((await requireVaultStepUp('reset', { ...S, code: codeAt() })).ok).toBe(false)
  })

  test('lock and lock-local ask nothing (locking only reduces exposure); set-auto-lock is gated; set-auto-lock refuses "never"', async () => {
    expect((await requireVaultStepUp('lock', S)).ok).toBe(true)
    expect((await requireVaultStepUp('set-auto-lock', S)).ok).toBe(false)
    expect((await requireVaultStepUp('lock-local', S)).ok).toBe(true)
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
    await unlockWithGesture()
    expect((await completeUnlock(codeAt())).ok).toBe(true)
    next()
    const g0 = hello.gestures
    for (let i = 0; i < 3; i++) expect((await requireVaultStepUp('personal-grant-open', { ...S, loopback: true })).ok).toBe(true)
    expect(hello.gestures - g0).toBe(0)
    lockVault('user')
    expect((await requireVaultStepUp('personal-grant-open', { ...S, loopback: true })).ok).toBe(false)
  })

  test('a remote origin never gets a Hello prompt: an ON secret wants the phone passkey token', async () => {
    const g0 = hello.gestures
    expect(await requireVaultStepUp('personal-grant', S)).toMatchObject({ ok: false, code: 'mobile-gesture-required' })
    expect(hello.gestures - g0).toBe(0)
  })

  test('polling the list is not use: it does not postpone the auto-lock', async () => {
    const before = autoLockRemainingMs()!
    T += 10 * 60_000
    expect((await requireVaultStepUp('list', { ...S, loopback: true })).ok).toBe(true)
    expect(autoLockRemainingMs()!).toBeLessThan(before - 9 * 60_000)
  })

  test('extend-open: a click on this computer is enough; a remote origin must give the code', async () => {
    expect((await requireVaultStepUp('extend-open', { ...S, loopback: true })).ok).toBe(true)
    expect(await requireVaultStepUp('extend-open', S)).toMatchObject({ ok: false, code: 'stepup-required' })
    expect((await requireVaultStepUp('extend-open', { ...S, code: codeAt() })).ok).toBe(true)
    next()
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

describe('§2.3 on the host: the counter is on disk, and 20 failures freeze (and lock)', () => {
  test('frozen → every gated action refused, the vault locked, until recover', async () => {
    const { words } = await ownerMachine()
    for (let i = 0; i < 20; i++) {
      const s = await stepUpState()
      if (s.pausedUntilMs) T = s.pausedUntilMs + 1
      await requireVaultStepUp('set-auto-lock', { ...S, code: '000000' === codeAt() ? '111111' : '000000' })
    }
    expect((await stepUpState()).frozen).toBe(true)
    expect(existsSync(join(vaultDir(), 'stepup.json'))).toBe(true)
    expect((await vaultStatus()).lockedBy).toBe('stepup-frozen')
    // a "restart" does not reset it (the file is read back)
    restart()
    expect((await stepUpState()).frozen).toBe(true)
    expect(await requireVaultStepUp('set-auto-lock', { ...S, code: codeAt() })).toMatchObject({ ok: false, code: 'stepup-frozen' })
    // recover lifts it into recovery mode
    expect((await recoverWithWords(words.join(' '))).ok).toBe(true)
    expect((await stepUpState()).frozen).toBe(false)
  })
})

describe('§4.3 / §12.4 recovery', () => {
  test('recover → recovery mode refuses everything but the three re-enrolment steps; afterwards the old words are dead', async () => {
    const { words } = await ownerMachine()
    restart()
    expect((await recoverWithWords(words.slice(0, 23).join(' '))).ok).toBe(false)
    const r = await recoverWithWords(words.map(w => w.slice(0, 4)).join(' '))
    expect(r).toMatchObject({ ok: true, todo: ['presence', 'authenticator', 'recovery'] })
    for (const a of ['list', 'reset', 'rekey', 'set-auto-lock', 'disable-presence'] as VaultAction[]) {
      expect(await requireVaultStepUp(a, { ...S, code: codeAt() })).toMatchObject({ ok: false, code: 'recovery-mode' })
    }
    // (a) presence, (b) authenticator, (c) a NEW recovery key — none needs the lost factors, and all
    // three answer the local terminal's channel only (review M2: never an HTTP session)
    const SOCK = { session: 'socket' }
    expect((await enrolPresence('hello', SOCK)).ok).toBe(true)
    const a = await beginAuthenticator(SOCK, 'test-box')
    if (!a.ok) throw new Error(a.sentence)
    seed = base32Decode(a.secret)
    expect((await confirmAuthenticator(codeAt(0))).ok).toBe(true)
    next()
    const k = await beginRecoveryKey(SOCK)
    if (!k.ok) throw new Error(k.sentence)
    expect((await confirmRecoveryKey(k.positions.map(p => k.words[p - 1]!))).ok).toBe(true)
    expect((await vaultStatus()).recoveryTodo).toBeNull()
    // the old words no longer open the vault
    restart()
    expect((await recoverWithWords(words.join(' '))).ok).toBe(false)
    expect((await recoverWithWords(k.words.join(' '))).ok).toBe(true)
  })

  test('the words, the seed and the codes never appear in the audit trail or the vault files', async () => {
    const { words } = await ownerMachine()
    restart()
    await recoverWithWords(words.join(' '))
    const audit = readFileSync(join(vaultDir(), 'audit.jsonl'), 'utf8')
    const vjson = readFileSync(join(vaultDir(), 'vault.json'), 'utf8')
    const step = readFileSync(join(vaultDir(), 'stepup.json'), 'utf8')
    for (const blob of [audit, vjson, step]) {
      expect(blob).not.toContain(words.slice(0, 3).join(' '))
      expect(blob).not.toContain(Buffer.from(seed).toString('hex'))
      expect(blob).not.toContain(MARK)
    }
    expect(audit).toContain('vault.recovered')
  })
})

describe('§5.1 / §12.5 auto-lock', () => {
  test('idle 30 min → locked, the DEK buffer zeroed, audited; activity and opens reset the clock', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentistics-autolock-'))
    dpapi = fake('dpapi'); hello = fake('hello')
    restart()
    await sealToFile(join(dir, 'x.sealed'), 'central-token', 'n', new Uint8Array([1, 2, 3]))
    const o = await ensureVaultOpen()
    const dekRef = o!.dek
    const t0 = T
    expect(autoLockTick(t0 + 29 * 60_000)).toBe(false)
    T = t0 + 20 * 60_000
    noteVaultActivity()
    expect(autoLockTick(t0 + 49 * 60_000)).toBe(false)
    T = t0 + 45 * 60_000
    expect((await openFromFile(join(dir, 'x.sealed'), 'central-token', 'n')).ok).toBe(true) // an open is use
    expect(autoLockTick(t0 + 74 * 60_000)).toBe(false)
    expect(autoLockTick(t0 + 75 * 60_000)).toBe(true)
    expect(dekRef.every(b => b === 0)).toBe(true)
    expect((await vaultStatus()).lockedBy).toBe('auto-lock')
    expect(readFileSync(join(vaultDir(), 'audit.jsonl'), 'utf8')).toContain('vault.auto-locked')
  })

  test('a presence vault that auto-locked says so, and stays locked until a gesture', async () => {
    await ownerMachine()
    restart()
    await unlockWithGesture()
    expect((await completeUnlock(codeAt())).ok).toBe(true)
    next()
    expect(autoLockTick(T + 31 * 60_000)).toBe(true)
    expect(await ensureVaultOpen()).toBeNull()
    expect((await vaultStatus()).sentence).toBe(refusalSentence('auto-locked', 'en', { minutes: 30, presence: 'Windows Hello' }))
  })
})

// ── the unlock policy (owner decision 2026-10-02): always / hello-only / daily (the default) ─────

import { autoLockRemainingMs, extendAutoLock, lockVault, unlockWindowAnchor } from './service'
import { setUnlockPolicy, unlockPolicyView } from './gate'

const H = 3_600_000
/** A full gesture+code unlock from a cold (just restarted) service. */
async function coldUnlock(): Promise<void> {
  expect(await unlockWithGesture()).toMatchObject({ ok: true, state: 'pending-stepup' })
  expect((await completeUnlock(codeAt())).ok).toBe(true)
  next()
}
/** Auto-lock (NOT a restart): the in-memory window must survive it. */
const autoLock = () => lockVault('auto-lock')

describe('unlock policy — per day (the DEFAULT): code on the first unlock, Hello alone inside the window', () => {
  test('absent from vault.json reads as daily / 12 h, and the first unlock after start owes the code', async () => {
    await ownerMachine()
    restart()
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.unlockPolicy).toBeUndefined()
    expect(unlockPolicyView(null)).toMatchObject({ mode: 'daily', hours: 12, chosen: false, codeNextUnlock: true })
    await coldUnlock()
    expect(unlockWindowAnchor()).not.toBeNull()
  })
  test('a re-open after auto-lock inside the window is the gesture ALONE — one Hello, no code', async () => {
    await ownerMachine()
    restart()
    await coldUnlock()
    autoLock()
    T += 3 * H
    const g = hello.gestures
    expect(await unlockWithGesture()).toMatchObject({ ok: true, state: 'open' })
    expect(hello.gestures).toBe(g + 1)
    expect(pendingUnlock()).toBeNull()
  })
  test('the window is anchored to the last gesture+CODE unlock, not to a Hello-only re-open, and expires at N hours', async () => {
    await ownerMachine()
    restart()
    await coldUnlock()
    autoLock(); T += 11 * H
    expect(await unlockWithGesture()).toMatchObject({ state: 'open' }) // Hello alone, does NOT move the anchor
    autoLock(); T += 1 * H + 1_000                                     // 12 h after the code unlock
    expect(await unlockWithGesture()).toMatchObject({ state: 'pending-stepup' })
  })
  test('a reboot / service restart drops the window: the code again', async () => {
    await ownerMachine()
    restart()
    await coldUnlock()
    restart() // the service process is new
    expect(unlockWindowAnchor()).toBeNull()
    expect(await unlockWithGesture()).toMatchObject({ state: 'pending-stepup' })
  })
  test('ANY failed code drops the window', async () => {
    await ownerMachine()
    restart()
    await coldUnlock()
    const wrong = codeAt() === '000000' ? '111111' : '000000'
    expect((await requireVaultStepUp('set-auto-lock', { ...S, code: wrong })).ok).toBe(false)
    expect(unlockWindowAnchor()).toBeNull()
    autoLock()
    expect(await unlockWithGesture()).toMatchObject({ state: 'pending-stepup' })
  })
  test('recovery drops the window', async () => {
    const { words } = await ownerMachine()
    restart()
    await coldUnlock()
    autoLock()
    expect((await recoverWithWords(words.join(' '))).ok).toBe(true)
    expect(unlockWindowAnchor()).toBeNull()
  })
  test('a configurable window: 1 hour', async () => {
    await ownerMachine()
    restart()
    await coldUnlock()
    expect((await setUnlockPolicy({ mode: 'daily', hours: 1 }, { ...S, code: codeAt() })).ok).toBe(true)
    next()
    autoLock(); T += 30 * 60_000
    expect(await unlockWithGesture()).toMatchObject({ state: 'open' })
    autoLock(); T += 31 * 60_000
    expect(await unlockWithGesture()).toMatchObject({ state: 'pending-stepup' })
  })
})

describe('unlock policy — always (Hello + code every time)', () => {
  test('every unlock owes the code, auto-lock or not', async () => {
    await ownerMachine()
    expect((await setUnlockPolicy({ mode: 'always', hours: 12 }, { ...S, code: codeAt() })).ok).toBe(true)
    next()
    restart()
    await coldUnlock()
    autoLock(); T += 60_000
    expect(await unlockWithGesture()).toMatchObject({ state: 'pending-stepup' })
  })
})

describe('unlock policy — Hello only', () => {
  test('the gesture alone opens it, even cold; the code is still asked for the inventory', async () => {
    await ownerMachine()
    expect((await setUnlockPolicy({ mode: 'hello-only', hours: 12 }, { ...S, code: codeAt() })).ok).toBe(true)
    next()
    restart()
    expect(await unlockWithGesture()).toMatchObject({ ok: true, state: 'open' })
    const l = await requireVaultStepUp('set-auto-lock', S)
    expect(!l.ok && l.code).toBe('stepup-required')
  })
})

describe('changing the policy is gated by the code AND the gesture, and refuses what is not a policy', () => {
  test('no code → refused; a bad mode or hours → refused in words; the right code + gesture → written', async () => {
    await ownerMachine()
    expect((await setUnlockPolicy({ mode: 'hello-only', hours: 12 }, S)).ok).toBe(false)
    for (const bad of [{ mode: 'never', hours: 12 }, { mode: 'daily', hours: 0 }, { mode: 'daily', hours: 25 }, { mode: 'daily', hours: 1.5 }]) {
      const r = await setUnlockPolicy(bad, { ...S, code: codeAt() })
      expect(!r.ok && r.code).toBe('bad-request')
    }
    const g = hello.gestures
    expect((await setUnlockPolicy({ mode: 'daily', hours: 8 }, { ...S, code: codeAt() })).ok).toBe(true)
    expect(hello.gestures).toBeGreaterThan(g)
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.unlockPolicy).toEqual({ mode: 'daily', hours: 8 })
    expect(VAULT_ACTION_ROWS['set-unlock-policy']).toEqual({ code: true, gesture: true, grant: null })
  })
})
