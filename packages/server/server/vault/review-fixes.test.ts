/**
 * SECRETS.4 independent review (t-afdb361ae7, ~/.agentistics/leader/briefs/secrets4-review-findings.md):
 * one test per finding, each written to FAIL on the code as reviewed and pass once fixed. Fakes as in
 * gate.test.ts — a silent "dpapi", a "hello" that counts gestures — and a fake clock; nothing spawned.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base32Decode, hotp, type Protector, type ProtectorId, type UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, sealToFile } from './service'
import { __resetGateForTests, beginAuthenticator, beginRecoveryKey, confirmAuthenticator, confirmRecoveryKey, enrolPresence } from './gate'

const STORE = new Map<string, Uint8Array>()
type Fake = Protector & { gestures: number; wrapFails: string | null }
function fake(id: ProtectorId): Fake {
  const self: Fake = {
    id, gestures: 0, wrapFails: null,
    label: () => (id === 'hello' ? 'Windows Hello (fake)' : 'DPAPI (fake)'),
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) {
      if (self.wrapFails) return { ok: false as const, reason: self.wrapFails }
      STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: 'x' } }
    },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      if (id === 'hello') self.gestures++
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
  }
  return self
}

export let T = 1_800_000_000_000
const clock = () => T
let seed: Uint8Array
export const codeAt = (o = 0) => hotp(seed, Math.floor(T / 30_000) + o)
export const next = () => { T += 30_000 }
export let dir = ''
export let dpapi = fake('dpapi')
export let hello = fake('hello')
export const S = { session: 'socket' }
let lastWords: string[] = []

export function restart(): void {
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
}

/** A SECRETS.2 vault (silent DPAPI) holding one sealed secret. */
export async function silentVault(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-review-'))
  dpapi = fake('dpapi'); hello = fake('hello')
  restart()
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('MARK'))
}

/** …plus the authenticator only (the leader's order puts presence BEFORE the recovery key). */
export async function authVault(): Promise<void> {
  await silentVault()
  const a = await beginAuthenticator(S, 'box')
  if (!a.ok) throw new Error(a.sentence)
  seed = base32Decode(a.secret)
  const c = await confirmAuthenticator(codeAt(0), S)
  if (!c.ok) throw new Error(c.sentence)
  next()
}

/** Make the recovery key now (socket); returns the words. */
export async function makeRecovery(): Promise<string[]> {
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  const k = await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!), S)
  if (!k.ok) throw new Error(k.sentence)
  return r.words
}

/** …plus the authenticator and a recovery key (through the socket session), presence NOT yet enrolled. */
export async function enrolledVault(): Promise<{ words: string[] }> {
  await silentVault()
  const a = await beginAuthenticator(S, 'box')
  if (!a.ok) throw new Error(a.sentence)
  seed = base32Decode(a.secret)
  const c = await confirmAuthenticator(codeAt(0), S)
  if (!c.ok) throw new Error(c.sentence)
  next()
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  const k = await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!))
  if (!k.ok) throw new Error(k.sentence)
  lastWords = r.words
  return { words: r.words }
}

beforeEach(() => { STORE.clear() })
// Leave the process the way every other vault test file expects it (central-env.test.ts reads the
// default test vault without resetting it — a locked fake left here would fail it).
// A UNIQUE directory: a fixed one would keep the vault the next file creates there, and the run after
// would read it as protector-lost (its memory key died with the previous process).
afterAll(() => { __resetVaultForTests({ dir: join(mkdtempSync(join(tmpdir(), 'agentistics-review-done-')), 'vault') }); __resetGateForTests() })

describe('step 0 — a presence enrolment failure reaches the UI as a sentence, never a reason code', () => {
  test('the bridge failure is said in words (EN), with no code and no .NET name', async () => {
    await authVault()
    hello.wrapFails = 'presence-unavailable: bridge-failed'
    const r = await enrolPresence('hello', { ...S, code: codeAt() })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('presence-unavailable')
    expect(r.sentence).not.toContain('presence-unavailable')
    expect(r.sentence).not.toContain('bridge-failed')
    expect(r.sentence).toContain('Windows Hello')
  })
  test('a reason that is not a presence code still becomes a sentence, not the raw text', async () => {
    await authVault()
    hello.wrapFails = 'no-hmac-secret: this security key does not support hmac-secret'
    const r = await enrolPresence('hello', { ...S, code: codeAt() })
    expect(!r.ok && r.sentence).not.toMatch(/^no-hmac-secret:/)
  })
})

// ── M1: no cross-site request may drive a vault action ─────────────────────────────────────────

import { handleVaultHttp } from './http'
import { stepUpState } from './gate'
import { autoLockRemainingMs } from './service'

async function post(path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request(`http://127.0.0.1:47291${path}`, { method: 'POST', headers, ...(body !== undefined ? { body } : {}) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'local' })
  const t = res ? await res.text() : ''
  return { status: res?.status ?? 404, json: t.startsWith('{') ? JSON.parse(t) : {} }
}
const CODE = JSON.stringify({ code: '000000' })
const CROSS = { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }
const SAME = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:47291' }

describe('M1 — CSRF: /api/vault POSTs need a same-origin proof AND a JSON body type, cookie or not', () => {
  test('a text/plain "simple" POST (no preflight) is refused and counts no failure', async () => {
    await enrolledVault()
    const r = await post('/api/vault/stepup', { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }, CODE)
    expect(r.json.code).toBe('not-json')
    expect((await stepUpState()).failures).toBe(0)
  })
  test('a cross-site POST cannot freeze the gate (25 tries, 0 failures counted)', async () => {
    await enrolledVault()
    for (let i = 0; i < 25; i++) { T += 31 * 60_000; expect((await post('/api/vault/stepup', CROSS, CODE)).json.code).toBe('not-same-origin') }
    const s = await stepUpState()
    expect(s.failures).toBe(0)
    expect(s.frozen).toBe(false)
  })
  test('a request with no Origin and no Sec-Fetch-Site (not a browser page of ours) is refused', async () => {
    await enrolledVault()
    expect((await post('/api/vault/stepup', { 'content-type': 'application/json' }, CODE)).json.code).toBe('not-same-origin')
    expect((await stepUpState()).failures).toBe(0)
  })
  test('a cross-site ping cannot keep the vault from auto-locking', async () => {
    await enrolledVault()
    T += 29 * 60_000
    const before = autoLockRemainingMs()
    await post('/api/vault/activity', CROSS, '{}')
    expect(autoLockRemainingMs()).toBe(before)
  })
  test('a cross-site POST cannot raise a presence gesture', async () => {
    await enrolledVault()
    const g = hello.gestures
    expect((await post('/api/vault/unlock', CROSS, '{}')).json.code).toBe('not-same-origin')
    expect(hello.gestures).toBe(g)
  })
  test('the dashboard itself (same-origin, JSON) still works — a wrong code is judged', async () => {
    await enrolledVault()
    const r = await post('/api/vault/stepup', SAME, CODE)
    expect(r.json.code).toBe('stepup-wrong')
    expect((await stepUpState()).failures).toBe(1)
  })
  test('an older browser without Sec-Fetch-Site passes on a matching Origin only', async () => {
    await enrolledVault()
    expect((await post('/api/vault/stepup', { 'content-type': 'application/json', origin: 'http://127.0.0.1:47291' }, CODE)).json.code).toBe('stepup-wrong')
    expect((await post('/api/vault/stepup', { 'content-type': 'application/json', origin: 'http://evil.example' }, CODE)).json.code).toBe('not-same-origin')
    expect((await stepUpState()).failures).toBe(1)
  })
})

// ── M2: recovery mode hands out a NEW root key — only to the local terminal ──────────────────

import { recoverWithWords } from './gate'
import { vaultStatus } from './service'

describe('M2 — in recovery mode the re-enrolment steps answer the local socket (TTY), never HTTP', () => {
  async function inRecovery(): Promise<void> {
    await authVault()
    expect((await enrolPresence('hello', { ...S, code: codeAt() })).ok).toBe(true)
    next()
    const words = await makeRecovery()
    restart()
    expect((await vaultStatus()).state).toBe('locked')
    const r = await recoverWithWords(words.join(' '))
    expect(r.ok).toBe(true)
  }
  const WEB = { session: 'local' }
  test('HTTP cannot get the new 24 words', async () => {
    await inRecovery()
    const r = await beginRecoveryKey(WEB)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('recovery-tty-only')
    expect(JSON.stringify(r)).not.toMatch(/"words"/)
  })
  test('HTTP cannot get a new authenticator seed', async () => {
    await inRecovery()
    const r = await beginAuthenticator(WEB, 'box')
    expect(!r.ok && r.code).toBe('recovery-tty-only')
  })
  test('HTTP cannot enrol a presence credential', async () => {
    await inRecovery()
    const g = hello.gestures
    const r = await enrolPresence('hello', WEB)
    expect(!r.ok && r.code).toBe('recovery-tty-only')
    expect(hello.gestures).toBe(g)
  })
  test('the local terminal (vault.sock) still completes all three steps without the lost factors', async () => {
    await inRecovery()
    const a = await beginAuthenticator(S, 'box')
    expect(a.ok).toBe(true)
    const r = await beginRecoveryKey(S)
    expect(r.ok).toBe(true)
    expect((await enrolPresence('hello', S)).ok).toBe(true)
  })
  test('the refusal is a sentence naming the terminal command, in PT too', async () => {
    await inRecovery()
    const r = await beginRecoveryKey(WEB)
    expect(!r.ok && r.sentence).toContain('agentop vault enroll')
  })
  test('an HTTP request whose session cookie is literally "socket" is still HTTP', async () => {
    await inRecovery()
    const req = new Request('http://127.0.0.1:47291/api/vault/recovery/begin', { method: 'POST', headers: SAME, body: '{}' })
    const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'socket' })
    const j = JSON.parse(await res!.text())
    expect(j.code).toBe('recovery-tty-only')
    expect(j.words).toBeUndefined()
  })
})

// ── S1 / N1: the socket ──────────────────────────────────────────────────────────────────────

import { DEFAULT_SOCKET_GATE, handleVaultOp, installVaultOps } from './ops'

function op(header: Record<string, unknown>, body: Uint8Array | null = null) {
  return handleVaultOp({ header, body, emit() {}, closed: new Promise(() => {}) })
}

describe('S1 — the socket never seals a reserved vault/* purpose (the gate\'s own seed)', () => {
  test('seal of vault/totp-seed is refused before any crypto', async () => {
    await enrolledVault()
    installVaultOps()
    const r = await op({ op: 'seal', purpose: 'vault/totp-seed', name: 'totp-seed' }, new Uint8Array(20))
    expect(r.reply.ok).toBe(false)
    expect(!r.reply.ok && r.reply.code).toBe('purpose')
    expect(r.body).toBeUndefined()
  })
  test('an ordinary human purpose still seals', async () => {
    await enrolledVault()
    installVaultOps()
    const r = await op({ op: 'seal', purpose: 'github-backup', name: 'github-backup' }, new TextEncoder().encode('x'))
    expect(r.reply.ok).toBe(true)
  })
})

describe('N1 — the socket gate fails CLOSED until the real one is installed', () => {
  test('the default gate refuses every action', async () => {
    for (const a of ['lock-local', 'rekey', 'reset', 'add-passphrase']) {
      const g = await DEFAULT_SOCKET_GATE(a, {})
      expect(g.ok).toBe(false)
    }
  })
})

// ── S2: the FIRST enrolment over HTTP needs a local proof ─────────────────────────────────────

import { mintSetupCode, probePresence } from './gate'

describe('S2 — first enrolment from a page needs a proof from this machine', () => {
  const WEB = { session: 'http:local' }
  test('the first authenticator over HTTP is refused without a setup code (no seed handed out)', async () => {
    await silentVault()
    const r = await beginAuthenticator(WEB, 'box')
    expect(!r.ok && r.code).toBe('setup-code-required')
    expect(!r.ok && r.sentence).toContain('agentop vault setup-code')
    expect(JSON.stringify(r)).not.toContain('otpauth')
  })
  test('with the code the service printed, it proceeds — once', async () => {
    await silentVault()
    const { code } = mintSetupCode()
    expect(code).toMatch(/^\d{8}$/)
    const r = await beginAuthenticator({ ...WEB, setupCode: code }, 'box')
    expect(r.ok).toBe(true)
    const again = await beginAuthenticator({ ...WEB, setupCode: code }, 'box')
    expect(!again.ok && again.code).toBe('setup-code-required')
  })
  test('five wrong setup codes burn it', async () => {
    await silentVault()
    const { code } = mintSetupCode()
    for (let i = 0; i < 5; i++) expect((await beginAuthenticator({ ...WEB, setupCode: '00000000' }, 'box')).ok).toBe(false)
    const r = await beginAuthenticator({ ...WEB, setupCode: code }, 'box')
    expect(!r.ok && r.code).toBe('setup-code-required')
  })
  test('an expired setup code is refused', async () => {
    await silentVault()
    const { code } = mintSetupCode()
    T += 11 * 60_000
    expect((await beginAuthenticator({ ...WEB, setupCode: code }, 'box')).ok).toBe(false)
  })
  test('the local terminal (socket) needs no setup code', async () => {
    await silentVault()
    expect((await beginAuthenticator(S, 'box')).ok).toBe(true)
  })
  test('the first recovery key over HTTP, outside THIS session\'s wizard, needs the authenticator code', async () => {
    await silentVault()
    const a = await beginAuthenticator(S, 'box')
    if (!a.ok) throw new Error(a.sentence)
    seed = base32Decode(a.secret)
    expect((await confirmAuthenticator(codeAt(), S)).ok).toBe(true)
    next()
    // The wizard flow belongs to the session that verified the code — a page is not that session.
    const r = await beginRecoveryKey(WEB)
    expect(!r.ok && r.code).toBe('stepup-required')
    const ok = await beginRecoveryKey({ ...WEB, code: codeAt() })
    expect(ok.ok).toBe(true)
  })
  test('inside the same session\'s wizard the verified code stands for the recovery step', async () => {
    await silentVault()
    const { code } = mintSetupCode()
    const a = await beginAuthenticator({ ...WEB, setupCode: code }, 'box')
    if (!a.ok) throw new Error(a.sentence)
    seed = base32Decode(a.secret)
    expect((await confirmAuthenticator(codeAt(), WEB)).ok).toBe(true)
    next()
    expect((await beginRecoveryKey(WEB)).ok).toBe(true)
  })
  test('a failed device check is said in words, never as a reason code', async () => {
    await silentVault()
    hello.probe = async () => ({ ok: false as const, reason: 'presence-unavailable: bridge-failed' })
    const r = await probePresence('hello', S)
    expect(!r.ok && r.sentence).not.toContain('bridge-failed')
    expect(!r.ok && r.code).toBe('presence-unavailable')
  })
})

// ── S3: reset of a vault that cannot open ──────────────────────────────────────────────────────

describe('S3 — reset when the vault cannot open: allowed from the terminal, with its own sentence', () => {
  test('a SECRETS.2 vault whose protector key is gone can be reset over the socket', async () => {
    await silentVault()
    STORE.clear() // the DPAPI blob is gone: protector-lost, no code can be checked
    restart(); installVaultOps()
    const r = await op({ op: 'vault-reset' })
    expect(r.reply.ok).toBe(true)
  })
  test('a vault that is merely LOCKED behind presence is not reset that way — the sentence says unlock first', async () => {
    await authVault()
    expect((await enrolPresence('hello', { ...S, code: codeAt() })).ok).toBe(true)
    next()
    restart(); installVaultOps()
    const r = await op({ op: 'vault-reset' })
    expect(r.reply.ok).toBe(false)
    expect(!r.reply.ok && r.reply.code).toBe('reset-needs-unlock')
    expect(!r.reply.ok && r.reply.sentence).toContain('agentop vault unlock')
    expect(!r.reply.ok && r.reply.sentence).not.toContain('passphrase')
  })
})

// ── S5: engine-api 1.6 — the engine hears every state change, with the reason ──────────────────

import { engineSecrets, __resetEngineSecretsForTests } from './engine-secrets'
import { autoLockTick, lockVault, ensureVaultOpen } from './service'
import { requireVaultStepUp } from './gate'
import type { EngineSecretsStatus } from '@agentistics/engine-api'

describe('S5 — onStateChange / lockedBy / autoLockInMs are fed by the vault', () => {
  async function watching(): Promise<EngineSecretsStatus[]> {
    await enrolledVault()
    __resetEngineSecretsForTests()
    const seen: EngineSecretsStatus[] = []
    engineSecrets().onStateChange!(s => { seen.push(s) })
    return seen
  }
  test('while open, autoLockInMs is the real countdown (not null)', async () => {
    await watching()
    const s = engineSecrets().status()
    expect(s.state).toBe('open')
    expect(s.autoLockInMs).toBeGreaterThan(29 * 60_000)
  })
  test('an auto-lock reaches the subscriber as locked / auto-lock', async () => {
    const seen = await watching()
    T += 31 * 60_000
    expect(autoLockTick(T)).toBe(true)
    expect(seen.at(-1)).toMatchObject({ state: 'locked', lockedBy: 'auto-lock' })
    expect(engineSecrets().status().lockedBy).toBe('auto-lock')
  })
  test('a user lock, then a re-open, are both heard', async () => {
    const seen = await watching()
    lockVault('user')
    expect(seen.at(-1)).toMatchObject({ state: 'locked', lockedBy: 'user' })
    restart() // keeps the files; the silent wrapper opens again on demand
    __resetEngineSecretsForTests()
    const again: EngineSecretsStatus[] = []
    engineSecrets().onStateChange!(s => { again.push(s) })
    expect(await ensureVaultOpen({ create: false, migrate: false })).not.toBeNull()
    expect(again.at(-1)?.state).toBe('open')
  })
  test('a frozen step-up is heard as stepup-frozen', async () => {
    const seen = await watching()
    for (let i = 0; i < 20; i++) { T += 16 * 60_000; await requireVaultStepUp('list', { session: 'socket', code: '000000' }) }
    expect(seen.at(-1)).toMatchObject({ state: 'locked', lockedBy: 'stepup-frozen' })
  })
})

// ── S7: turning presence on makes a NEW data key; every earlier silent copy opens nothing ─────────

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { openRecord, parseVaultJson } from '@agentistics/vault'
import { __rekeyCrashAtForTests } from './rekey'
import { completeUnlock } from './gate'
import { openFromFile, unlockWithGesture, vaultDir } from './service'

describe('S7 — presence enrolment rotates the data key, crash-safely', () => {
  const vaultJson = () => parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!
  const leftovers = () => [
    ...readdirSync(dir).filter(f => f.endsWith('.rekey')),
    ...readdirSync(vaultDir()).filter(f => f.endsWith('.rekey') || f === 'rekey.json'),
  ]
  /** The "old copy of dek.dpapi": what the silent wrapper held before enrolment. */
  async function silentCopy(): Promise<{ kid: string; dek: Uint8Array }> {
    const kid = vaultJson().kid
    return { kid, dek: new Uint8Array(STORE.get(`dpapi:${kid}`)!) }
  }
  const gh = () => readFileSync(join(dir, 'gh.sealed'))

  test('a copy of the old silent wrapper opens NOTHING after enrolment; everything still reads; words and code still work', async () => {
    await authVault()
    const old = await silentCopy()
    expect((await enrolPresence('hello', { ...S, code: codeAt() })).ok).toBe(true)
    next()
    const words = await makeRecovery() // LAST: the words wrap the final key
    const v = vaultJson()
    expect(v.kid).not.toBe(old.kid)
    expect(v.wrappers.map(w => w.type).sort()).toEqual(['hello', 'recovery'])
    // The thief's copy: the old DEK no longer opens the record (it is sealed under the new kid).
    expect(openRecord({ dek: old.dek, kid: old.kid, purpose: 'github-backup', name: 'github-backup', bytes: gh() }).ok).toBe(false)
    expect(JSON.parse(gh().toString()).kid).toBe(v.kid)
    const r = await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')
    expect(r.ok && new TextDecoder().decode(r.plaintext)).toBe('MARK')
    expect(leftovers()).toEqual([])
    expect(STORE.has(`dpapi:${old.kid}`)).toBe(false) // retired under ITS kid, not the new one
    // The authenticator seed was re-sealed too: a code still verifies.
    expect((await requireVaultStepUp('list', { session: 'socket', code: codeAt() })).ok).toBe(true)
    next()
    // And the SAME 24 words open the rotated vault.
    restart()
    expect((await recoverWithWords(words.join(' '))).ok).toBe(true)
  })

  test('a crash while re-sealing leaves the old vault opening, every record readable, nothing staged after the next open', async () => {
    await authVault()
    const old = await silentCopy()
    __rekeyCrashAtForTests('prepare-mid')
    await expect(enrolPresence('hello', { ...S, code: codeAt() })).rejects.toThrow('injected crash')
    restart()
    const r = await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')
    expect(r.ok && new TextDecoder().decode(r.plaintext)).toBe('MARK')
    expect(vaultJson().kid).toBe(old.kid)
    expect(leftovers()).toEqual([])
  })

  for (const point of ['before-commit-mark', 'before-finish']) {
    test(`a crash after the commit (${point}) is finished on the next unlock — the code still works, nothing is lost`, async () => {
      await enrolledVault() // a recovery key exists: the terminal brings the words, so it must follow too
      const old = await silentCopy()
      __rekeyCrashAtForTests(point)
      await expect(enrolPresence('hello', { ...S, code: codeAt(), words: lastWords.join(' ') })).rejects.toThrow('injected crash')
      next()
      restart()
      expect(vaultJson().kid).not.toBe(old.kid)
      const u = await unlockWithGesture()
      expect(u.ok && u.state).toBe('pending-stepup')
      expect((await completeUnlock(codeAt())).ok).toBe(true)
      const r = await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')
      expect(r.ok && new TextDecoder().decode(r.plaintext)).toBe('MARK')
      expect(leftovers()).toEqual([])
      expect(existsSync(join(vaultDir(), 'dek.recovery'))).toBe(true)
      // …and the words still open the rotated vault (the staged recovery wrapper was finished too).
      restart()
      expect((await recoverWithWords(lastWords.join(' '))).ok).toBe(true)
    })
  }

  test('outside the setup that made the recovery key, the terminal supplies the words; wrong words change nothing', async () => {
    const { words } = await enrolledVault()
    const none = await enrolPresence('hello', { ...S, code: codeAt() })
    expect(!none.ok && none.code).toBe('presence-needs-recovery-words')
    const kid0 = vaultJson().kid
    const wrong = await enrolPresence('hello', { ...S, code: codeAt(), words: Array(24).fill('abandon').join(' ').replace(/abandon$/, 'art') })
    expect(!wrong.ok && wrong.code).toBe('recovery-denied')
    expect(vaultJson().kid).toBe(kid0)
    next()
    const ok = await enrolPresence('hello', { ...S, code: codeAt(), words: words.join(' ') })
    expect(ok.ok).toBe(true)
    expect(vaultJson().kid).not.toBe(kid0)
  })

  test('the words never come from a page: an HTTP session is refused even when it sends them', async () => {
    const { words } = await enrolledVault()
    const r = await enrolPresence('hello', { session: 'http:local', code: codeAt(), words: words.join(' ') })
    expect(!r.ok && r.code).toBe('presence-needs-recovery-words')
  })
})

// ── Leader decision 3: the setup code is shown ONLY on demand, on a terminal — never in a log ─────


describe('decision 3 — the setup code never reaches a log; it is minted on demand for a TTY', () => {
  test('a page asking without a code gets a sentence naming the command — and nothing is minted or logged', async () => {
    await silentVault()
    const r = await beginAuthenticator({ session: 'http:local' }, 'box')
    expect(!r.ok && r.code).toBe('setup-code-required')
    expect(!r.ok && r.sentence).toContain('agentop vault setup-code')
    expect(!r.ok && r.sentence).not.toMatch(/\blog\b/)
    // Nothing was minted for the page to guess at: no 8-digit code is live.
    expect((await beginAuthenticator({ session: 'http:local', setupCode: '00000000' }, 'box')).ok).toBe(false)
  })
  test('the socket op refuses a caller that is not on a terminal', async () => {
    await silentVault()
    installVaultOps()
    const r = await op({ op: 'setup-code' })
    expect(r.reply.ok).toBe(false)
    expect(!r.reply.ok && r.reply.code).toBe('tty-only')
    const t = await op({ op: 'setup-code', tty: true })
    expect(t.reply.ok && typeof t.reply.code).toBe('string')
  })
  test('each request mints a NEW code: an earlier one shown on some other screen stops working', async () => {
    await silentVault()
    installVaultOps()
    const a = (await op({ op: 'setup-code', tty: true })).reply as { code: string }
    const b = (await op({ op: 'setup-code', tty: true })).reply as { code: string }
    expect(a.code).not.toBe(b.code) // a fresh code each time (a collision is 1 in 10^8)
    expect((await beginAuthenticator({ session: 'http:local', setupCode: a.code }, 'box')).ok).toBe(false)
    expect((await beginAuthenticator({ session: 'http:local', setupCode: b.code }, 'box')).ok).toBe(true)
  })
})

// ── Leader decision 2: no recovery words in memory across steps — fixed by ORDER ────────────────

import { wizardPlan, missingSteps } from '../../../web/src/lib/vaultApi'
import { stepsToRun } from './enroll-plan'

describe('decision 2 — authenticator → presence (the key rotates) → recovery LAST; words never linger', () => {
  test('a just-confirmed recovery key is NOT kept: presence right after it still needs the words', async () => {
    await enrolledVault() // recovery confirmed a moment ago, same session
    const r = await enrolPresence('hello', { ...S, code: codeAt() })
    expect(!r.ok && r.code).toBe('presence-needs-recovery-words')
  })
  test('the order: presence before the recovery key is allowed, says the key is owed, and the words made after it open the vault', async () => {
    await authVault()
    const p = await enrolPresence('hello', { ...S, code: codeAt() })
    expect(p.ok && p.recoveryOwed).toBe(true)
    next()
    const words = await makeRecovery()
    restart()
    expect((await recoverWithWords(words.join(' '))).ok).toBe(true)
  })
  test('no words at hand: NEW words are offered — the old ones stop working, and a recovery key is owed', async () => {
    const { words: oldWords } = await enrolledVault()
    const r = await enrolPresence('hello', { ...S, code: codeAt(), replaceRecovery: true })
    expect(r.ok && r.recoveryOwed).toBe(true)
    next()
    const newWords = await makeRecovery()
    restart()
    expect((await recoverWithWords(oldWords.join(' '))).ok).toBe(false)
    restart()
    expect((await recoverWithWords(newWords.join(' '))).ok).toBe(true)
  })
  test('the refusal offers both ways out, in words', async () => {
    await enrolledVault()
    const r = await enrolPresence('hello', { ...S, code: codeAt() })
    expect(!r.ok && r.sentence).toContain('agentop vault enroll --presence')
    expect(!r.ok && r.sentence).toMatch(/new recovery words/i)
  })
  test('the page\'s wizard keeps its flow through presence: the recovery key after it needs no second code', async () => {
    await silentVault()
    const W = { session: 'http:local' }
    const a = await beginAuthenticator({ ...W, setupCode: mintSetupCode().code }, 'box')
    if (!a.ok) throw new Error(a.sentence)
    seed = base32Decode(a.secret)
    expect((await confirmAuthenticator(codeAt(), W)).ok).toBe(true)
    next()
    expect((await enrolPresence('hello', W)).ok).toBe(true)
    expect((await beginRecoveryKey(W)).ok).toBe(true)
  })
  test('the wizard and the terminal both run authenticator → presence → recovery', () => {
    expect(missingSteps({ authenticator: null, recoveryCreatedAt: null, presence: false, presenceAvailable: ['hello'] })).toEqual(['authenticator', 'presence', 'recovery'])
    expect(wizardPlan(['authenticator', 'presence', 'recovery'])).toEqual(['probe', 'authenticator', 'presence', 'recovery'])
    expect(stepsToRun({ only: [], presence: null, requirePresence: false } as never, { authenticator: false, recovery: false, presence: false, available: ['hello'] })).toEqual(['authenticator', 'presence', 'recovery'])
  })
})

// ── owner 2026-10-02: the setup code comes FIRST, before any gesture ───────────────────────────
// The release preview did the Windows Hello gestures and only THEN asked for the setup code, as a red
// failure. `acceptSetupCode` spends it first and holds a proof for that session; the device check
// refuses without it; the view says it is owed, with the exact command and WHERE to run it.

import { setupCodeCommand, setupCodeTtyRefusal, setupCodeWhere } from '@agentistics/vault'
import { acceptSetupCode, setupCodeOwed } from './gate'
import { readVaultView } from './inventory'

const SWEB = { session: 'http:local' }
const OTHER = { session: 'http:other' }

describe('the setup code is asked BEFORE any gesture', () => {
  test('the device check of a first page enrolment is refused without it — no gesture is raised', async () => {
    await silentVault()
    const before = hello.gestures
    const r = await probePresence('hello', SWEB)
    expect(!r.ok && r.code).toBe('setup-code-required')
    expect(hello.gestures).toBe(before)
  })
  test('accepting the code first carries the whole wizard: probe, authenticator, first words — no second code', async () => {
    await silentVault()
    expect(setupCodeOwed(false, SWEB)).toBe(true)
    expect((await acceptSetupCode({ ...SWEB, setupCode: mintSetupCode().code })).ok).toBe(true)
    expect(setupCodeOwed(false, SWEB)).toBe(false)
    expect((await probePresence('hello', SWEB)).ok).toBe(true)
    expect((await beginAuthenticator(SWEB, 'box')).ok).toBe(true)
  })
  test('the proof belongs to the session that typed the code', async () => {
    await silentVault()
    expect((await acceptSetupCode({ ...SWEB, setupCode: mintSetupCode().code })).ok).toBe(true)
    expect(setupCodeOwed(false, OTHER)).toBe(true)
    const r = await beginAuthenticator(OTHER, 'box')
    expect(!r.ok && r.code).toBe('setup-code-required')
    expect((await beginRecoveryKey(OTHER)).ok).toBe(false)
  })
  test('the proof expires with the code\'s own 10 minutes', async () => {
    await silentVault()
    expect((await acceptSetupCode({ ...SWEB, setupCode: mintSetupCode().code })).ok).toBe(true)
    T += 11 * 60_000
    expect(setupCodeOwed(false, SWEB)).toBe(true)
  })
  test('a wrong code is refused with the setup sentence, and the 5th wrong burns the real one', async () => {
    await silentVault()
    const { code } = mintSetupCode()
    for (let i = 0; i < 5; i++) {
      const r = await acceptSetupCode({ ...SWEB, setupCode: '00000000' })
      expect(!r.ok && r.code).toBe('setup-code-required')
    }
    expect((await acceptSetupCode({ ...SWEB, setupCode: code })).ok).toBe(false)
  })
  test('not owed (the terminal) → accepted with nothing to check', async () => {
    await silentVault()
    expect((await acceptSetupCode({ session: 'socket' })).ok).toBe(true)
  })
  test('the view says it is owed, with the command and where to run it', async () => {
    await silentVault()
    const v = await readVaultView([], async () => [], SWEB.session)
    expect(v.setupCode.owed).toBe(true)
    expect(v.setupCode.command).toContain('agentop vault setup-code')
    expect(v.setupCode.where).toBe(setupCodeWhere('en'))
    await acceptSetupCode({ ...SWEB, setupCode: mintSetupCode().code })
    expect((await readVaultView([], async () => [], SWEB.session)).setupCode.owed).toBe(false)
  })
})

describe('the command reaches THIS service, and the refusal says where a terminal is', () => {
  test('the default data dir needs no env; any other one carries AGENTISTICS_DIR', () => {
    expect(setupCodeCommand('/home/a/.agentistics', '/home/a/.agentistics')).toBe('agentop vault setup-code')
    expect(setupCodeCommand('/tmp/s4-preview', '/home/a/.agentistics')).toBe('AGENTISTICS_DIR=/tmp/s4-preview agentop vault setup-code')
    expect(setupCodeCommand('/tmp/my dir', '/home/a/.agentistics')).toBe("AGENTISTICS_DIR='/tmp/my dir' agentop vault setup-code")
    expect(setupCodeCommand("/tmp/o'k", '/x')).toBe("AGENTISTICS_DIR='/tmp/o'\\''k' agentop vault setup-code")
  })
  test('the owner\'s wording, in PT, and its EN twin', () => {
    expect(setupCodeWhere('pt')).toBe('Abra o terminal do Ubuntu/WSL (ou o Terminal do macOS/Linux) e rode o comando lá. Dentro de um chat de assistente ou de uma IDE ele não aparece, por segurança.')
    expect(setupCodeWhere('en')).toContain('Ubuntu/WSL')
    expect(setupCodeWhere('en')).toContain('assistant')
  })
  test('the TTY refusal names where to run it and the exact command', () => {
    const pt = setupCodeTtyRefusal('pt', 'AGENTISTICS_DIR=/tmp/p agentop vault setup-code')
    expect(pt).toContain(setupCodeWhere('pt'))
    expect(pt).toContain('AGENTISTICS_DIR=/tmp/p agentop vault setup-code')
    expect(setupCodeTtyRefusal('en')).toContain(setupCodeWhere('en'))
  })
})

// ── owner 2026-10-02: the device check states its real gesture count and reports progress ───────

import { PRESENCE_GESTURES, gestureDone } from '@agentistics/vault'
import { gestureProgress } from './gate'

describe('the device check asks nothing; the enrolment reports live "confirmation i of n" (owner 2026-10-02)', () => {
  test('the device check raises no gesture and writes nothing', async () => {
    await silentVault()
    await acceptSetupCode({ ...SWEB, setupCode: mintSetupCode().code })
    const before = hello.gestures
    let wraps = 0
    const wrap = hello.wrap.bind(hello)
    hello.wrap = async (dek, kid) => { wraps++; return wrap(dek, kid) }
    expect((await probePresence('hello', SWEB)).ok).toBe(true)
    expect(hello.gestures).toBe(before)
    expect(wraps).toBe(0)
  })
  test('enrolment progress is visible to the asking session while the dialogs are up, to nobody else, and gone after', async () => {
    await authVault()
    const seen: unknown[] = []
    const wrap = hello.wrap.bind(hello)
    hello.wrap = async (dek, kid) => {
      seen.push(gestureProgress(S)); gestureDone()
      seen.push(gestureProgress(S)); seen.push(gestureProgress(OTHER)); gestureDone(); gestureDone()
      seen.push(gestureProgress(S))
      return wrap(dek, kid)
    }
    expect((await enrolPresence('hello', { ...S, code: codeAt() })).ok).toBe(true)
    expect(seen).toEqual([
      { kind: 'hello', done: 0, total: PRESENCE_GESTURES.enroll },
      { kind: 'hello', done: 1, total: PRESENCE_GESTURES.enroll },
      null,
      { kind: 'hello', done: PRESENCE_GESTURES.enroll, total: PRESENCE_GESTURES.enroll }, // capped at n
    ])
    expect(gestureProgress(S)).toBeNull()
  })
  test('the view states the counts the page prints', async () => {
    await silentVault()
    expect((await readVaultView([], async () => [], SWEB.session)).gestures).toEqual({ probe: 0, enroll: 2 })
  })
})
